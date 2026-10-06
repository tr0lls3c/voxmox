import { z } from "zod";
import { findGuest, powerGuest } from "@/lib/proxmox";
import type { GuestType, PowerAction } from "@/lib/proxmox";
import { requireDashboardAuth } from "@/lib/security/dashboard-auth";
import { clientKey, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  vmid: z.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  type: z.enum(["qemu", "lxc"]).optional(),
  action: z.enum(["start", "stop", "shutdown", "reboot", "reset"]),
});

export async function POST(request: Request) {
  const denied = requireDashboardAuth(request);
  if (denied) return denied;

  const limited = rateLimit(clientKey(request, "power"), {
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { action, type, vmid, name } = parsed.data;
  const query = name ?? (vmid != null ? String(vmid) : undefined);
  if (!query) {
    return Response.json(
      { error: "Provide a guest name or vmid." },
      { status: 400 },
    );
  }

  try {
    const guest = await findGuest(query, type as GuestType | undefined);
    if (!guest) {
      return Response.json({ error: `Guest not found: ${query}` }, { status: 404 });
    }

    const result = await powerGuest(
      guest.vmid,
      guest.type,
      guest.node,
      action as PowerAction,
    );

    return Response.json(result);
  } catch (error) {
    console.error("Power API error:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Power action failed",
      },
      { status: 500 },
    );
  }
}
