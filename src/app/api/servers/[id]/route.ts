import { z } from "zod";
import {
  deleteServer,
  getServerById,
  toPublicServer,
  updateServer,
  readServersConfig,
} from "@/lib/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  tokenId: z.string().min(1).optional(),
  tokenSecret: z.string().optional(),
  allowSelfSigned: z.boolean().optional(),
  enabled: z.boolean().optional(),
  setActive: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const config = await readServersConfig();
    const server = config.servers.find((item) => item.id === id);
    if (!server) {
      return Response.json({ error: "Server not found." }, { status: 404 });
    }
    return Response.json({
      server: toPublicServer(server, config.activeServerId),
    });
  } catch (error) {
    console.error("Get server error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to get server",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const server = await updateServer(id, parsed.data);
    return Response.json({ server });
  } catch (error) {
    console.error("Update server error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to update server";
    const status = message === "Server not found." ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const existing = await getServerById(id);
    if (!existing) {
      return Response.json({ error: "Server not found." }, { status: 404 });
    }
    await deleteServer(id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Delete server error:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete server",
      },
      { status: 500 },
    );
  }
}
