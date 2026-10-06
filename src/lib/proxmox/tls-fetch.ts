/**
 * Per-request TLS for outbound Proxmox calls.
 *
 * Avoids mutating process.env.NODE_TLS_REJECT_UNAUTHORIZED (global, racy).
 * Prefers undici Agent + dispatcher; falls back to https/http.request if needed.
 */

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

const secureAgent = new Agent({
  connect: { rejectUnauthorized: true },
});

const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

export type ProxmoxTlsFetchInit = RequestInit & {
  /** When false, accept self-signed / untrusted TLS certs for this request only. */
  rejectUnauthorized?: boolean;
};

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

async function bodyToBuffer(
  body: BodyInit | null | undefined,
): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof (body as Blob).arrayBuffer === "function") {
    return Buffer.from(await (body as Blob).arrayBuffer());
  }
  throw new Error("Unsupported request body type for Proxmox TLS fetch fallback.");
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Minimal fetch via node:http(s) when undici dispatcher cannot be used. */
async function nodeRequestFetch(
  input: string | URL,
  init: ProxmoxTlsFetchInit = {},
): Promise<Response> {
  const rejectUnauthorized = init.rejectUnauthorized !== false;
  const url = typeof input === "string" ? new URL(input) : new URL(input.href);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol for Proxmox fetch: ${url.protocol}`);
  }

  const method = (init.method ?? "GET").toUpperCase();
  const headers = headersToRecord(init.headers);
  const bodyBuf = await bodyToBuffer(init.body ?? undefined);

  if (bodyBuf && !headers["content-length"] && !headers["Content-Length"]) {
    headers["Content-Length"] = String(bodyBuf.length);
  }

  const signal = init.signal ?? undefined;

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        ...(url.protocol === "https:" ? { rejectUnauthorized } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else {
              responseHeaders.set(key, value);
            }
          }
          resolve(
            new Response(buf, {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        });
        res.on("error", reject);
      },
    );

    const onAbort = () => {
      req.destroy();
      reject(abortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Fetch against a Proxmox API host with optional per-request TLS relaxation.
 */
export async function proxmoxTlsFetch(
  input: string | URL,
  init: ProxmoxTlsFetchInit = {},
): Promise<Response> {
  const { rejectUnauthorized = true, ...rest } = init;
  const dispatcher = rejectUnauthorized ? secureAgent : insecureAgent;

  try {
    // Use undici's fetch directly so Next's fetch wrapper cannot strip `dispatcher`.
    const response = await undiciFetch(input, {
      ...rest,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Dispatcher / undici unavailable in this runtime — fall back to http(s).request.
    if (
      /dispatcher|undici|fetch failed|unknown scheme/i.test(message) ||
      (error as NodeJS.ErrnoException)?.code === "ERR_INVALID_ARG_TYPE"
    ) {
      return nodeRequestFetch(input, { ...rest, rejectUnauthorized });
    }
    throw error;
  }
}
