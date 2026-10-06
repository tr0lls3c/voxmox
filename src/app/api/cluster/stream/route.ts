import {
  getClusterOverviewWithMeta,
  getProxmoxConfig,
  proxmoxApiBase,
} from "@/lib/proxmox";
import { requireDashboardAuth } from "@/lib/security/dashboard-auth";
import { clientKey, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the stream re-reads the shared overview cache (not Proxmox). */
const TICK_MS = 4_000;
const HEARTBEAT_MS = 15_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function GET(request: Request) {
  const denied = requireDashboardAuth(request);
  if (denied) return denied;

  const limited = rateLimit(clientKey(request, "cluster-stream"), {
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const encoder = new TextEncoder();
  let lastFetchedAt = -1;
  let lastHeartbeat = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const comment = (text: string) => {
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };

      try {
        comment("voxmox cluster stream");
        while (!request.signal.aborted) {
          try {
            const config = await getProxmoxConfig();
            const { overview, cached, fetchedAt, ageMs } =
              await getClusterOverviewWithMeta(null);

            // Only push when the shared cache has a new snapshot (or first tick).
            if (fetchedAt !== lastFetchedAt) {
              lastFetchedAt = fetchedAt;
              const host = config.host || null;
              send("overview", {
                configured: !config.mock || Boolean(config.host),
                mock: config.mock,
                host,
                apiBase: host ? proxmoxApiBase(host) : null,
                source: config.source,
                serverName: config.serverName ?? null,
                overview,
                cache: {
                  hit: cached,
                  fetchedAt,
                  ageMs,
                  ttlMs: 4_000,
                },
              });
            } else if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
              comment(`heartbeat ${Date.now()}`);
              lastHeartbeat = Date.now();
            }
          } catch (error) {
            send("cluster-error", {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to load cluster overview",
            });
          }

          await sleep(TICK_MS, request.signal);
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          console.error("Cluster stream error:", error);
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // Client disconnected — AbortSignal on request handles the loop.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
