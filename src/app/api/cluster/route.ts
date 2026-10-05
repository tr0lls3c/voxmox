import {
  getClusterOverview,
  getProxmoxConfig,
  proxmoxApiBase,
} from "@/lib/proxmox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await getProxmoxConfig();
    const overview = await getClusterOverview();
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
