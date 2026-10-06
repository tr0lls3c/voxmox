import { createHash, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "voxmox_dashboard";

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Shared secret that gates dashboard/control-plane APIs (not Alexa). */
export function getDashboardSecret(): string | null {
  const secret = process.env.VOXMOX_DASHBOARD_SECRET?.trim();
  return secret ? secret : null;
}

export function isDashboardAuthRequired(): boolean {
  // When a secret is configured, all control-plane APIs require it.
  // Production installs should always set VOXMOX_DASHBOARD_SECRET (installer/updater generate one).
  return Boolean(getDashboardSecret());
}

export function isInsecureProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    !getDashboardSecret() &&
    !envFlag("VOXMOX_ALLOW_ANONYMOUS", false)
  );
}

export function dashboardAuthConfigured(): boolean {
  return Boolean(getDashboardSecret());
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(`voxmox:${secret}`).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function tokenMatchesSecret(token: string | null | undefined): boolean {
  const secret = getDashboardSecret();
  if (!secret || !token) return false;
  const normalized = token.trim();
  if (!normalized) return false;
  const expected = hashSecret(secret);
  // Accept raw secret or its hash (cookie stores hash).
  if (safeEqualString(normalized, secret)) return true;
  return safeEqualHex(normalized, expected) || normalized === expected;
}

export function dashboardCookieValue(secret: string): string {
  return hashSecret(secret);
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || null;
  }
  const custom = request.headers.get("x-voxmox-token");
  return custom?.trim() || null;
}

export function readDashboardCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === COOKIE_NAME) {
      return decodeURIComponent(rest.join("=").trim()) || null;
    }
  }
  return null;
}

export function requestHasDashboardAuth(request: Request): boolean {
  const secret = getDashboardSecret();
  if (!secret) {
    // Auth required in prod but misconfigured — never treat as authenticated.
    return false;
  }
  const token = readBearerToken(request) ?? readDashboardCookie(request);
  return tokenMatchesSecret(token);
}

export function unauthorizedDashboardResponse(): Response {
  const configured = dashboardAuthConfigured();
  return Response.json(
    {
      error: configured
        ? "Unauthorized. Provide the dashboard secret."
        : "Dashboard auth is required in production. Set VOXMOX_DASHBOARD_SECRET (or VOXMOX_ALLOW_ANONYMOUS=1 for trusted LAN-only).",
      code: configured ? "DASHBOARD_AUTH_REQUIRED" : "DASHBOARD_SECRET_MISSING",
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": "Bearer realm=\"Voxmox\"",
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Gate for control-plane routes. Alexa stays ungated (signature-verified). */
export function requireDashboardAuth(request: Request): Response | null {
  if (!isDashboardAuthRequired()) return null;
  if (requestHasDashboardAuth(request)) return null;
  return unauthorizedDashboardResponse();
}

/** True when the client reached us over HTTPS (direct or via proxy). */
export function requestIsHttps(request?: Request | null): boolean {
  if (!request) return false;
  try {
    if (new URL(request.url).protocol === "https:") return true;
  } catch {
    // ignore bad URL
  }
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return true;
    if (first === "http") return false;
  }
  return false;
}

/**
 * Session cookie after unlock.
 * Only set Secure when the request is HTTPS — LAN LXC installs are typically
 * plain HTTP, and a Secure cookie would be dropped by the browser.
 */
export function buildDashboardAuthCookie(
  secret: string,
  request?: Request | null,
): string {
  const value = encodeURIComponent(dashboardCookieValue(secret));
  const secure = requestIsHttps(request) ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function clearDashboardAuthCookie(request?: Request | null): string {
  const secure = requestIsHttps(request) ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export { COOKIE_NAME };
