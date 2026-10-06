import {
  getClusterOverviewWithMeta,
  getProxmoxConfig,
  proxmoxApiBase,
} from "@/lib/proxmox";
import { requireDashboardAuth } from "@/lib/security/dashboard-auth";
import { clientKey, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireDashboardAuth(request);
  if (denied) return denied;

  const limited = rateLimit(clientKey(request, "cluster"), {
    limit: 120,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const url = new URL(request.url);
  const force =
    url.searchParams.get("fresh") === "1" ||
    url.searchParams.get("force") === "1";

  try {
    const config = await getProxmoxConfig();
    const { overview, cached, fetchedAt, ageMs } =
      await getClusterOverviewWithMeta(null, { force });
    const host = config.host || null;
    return Response.json({
      configured: !config.mock || Boolean(config.host),
      mock: config.mock,
      host,
      /** Full Proxmox JSON API root used by the backend. */
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
  } catch (error) {
    console.error("Cluster API error:", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load cluster overview",
      },
      { status: 500 },
    );
  }
}
