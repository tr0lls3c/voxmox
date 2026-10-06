import { setActiveServer } from "@/lib/servers";
import { requireDashboardAuth } from "@/lib/security/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const denied = requireDashboardAuth(request);
  if (denied) return denied;

  const { id } = await context.params;
  try {
    const server = await setActiveServer(id);
    return Response.json({ server });
  } catch (error) {
    console.error("Activate server error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to activate server";
    const status = message === "Server not found." ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
