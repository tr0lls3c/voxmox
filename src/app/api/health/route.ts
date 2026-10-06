export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const mode = (process.env.VOXMOX_SERVICE_MODE ?? "all").toLowerCase().trim();
  return Response.json({
    ok: true,
    service: "voxmox",
    mode: mode || "all",
    time: new Date().toISOString(),
  });
}
