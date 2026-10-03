import { getClusterOverview, getProxmoxConfig } from "@/lib/proxmox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getProxmoxConfig();
    const overview = await getClusterOverview();
    return Response.json({
      configured: !config.mock || Boolean(config.host),
      mock: config.mock,
      host: config.host || null,
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
