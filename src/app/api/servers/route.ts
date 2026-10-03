import { z } from "zod";
import { createServer, listServersPublic } from "@/lib/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1),
  allowSelfSigned: z.boolean().optional(),
  enabled: z.boolean().optional(),
  setActive: z.boolean().optional(),
});

export async function GET() {
  try {
    const data = await listServersPublic();
    return Response.json(data);
  } catch (error) {
    console.error("List servers error:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list servers",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const server = await createServer(parsed.data);
    return Response.json({ server }, { status: 201 });
  } catch (error) {
    console.error("Create server error:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create server",
      },
      { status: 400 },
    );
  }
}
