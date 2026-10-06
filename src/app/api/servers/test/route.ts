import { z } from "zod";
import { getServerById } from "@/lib/servers";
import { testProxmoxConnection } from "@/lib/proxmox/client";
import { requireDashboardAuth } from "@/lib/security/dashboard-auth";
import { clientKey, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z
  .object({
    serverId: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    tokenSecret: z.string().optional(),
    authPassword: z.string().optional(),
    allowSelfSigned: z.boolean().optional(),
    repair: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.serverId) ||
      (Boolean(value.host) && Boolean(value.tokenId)),
    { message: "Provide serverId or host + tokenId." },
  );

export async function POST(request: Request) {
  const denied = requireDashboardAuth(request);
  if (denied) return denied;

  const limited = rateLimit(clientKey(request, "servers-test"), {
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

  const parsed = testSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const {
      serverId,
      host,
      tokenId,
      tokenSecret,
      authPassword,
      allowSelfSigned,
      repair,
    } = parsed.data;

    if (serverId) {
      const stored = await getServerById(serverId);
      if (!stored) {
        return Response.json({ error: "Server not found." }, { status: 404 });
      }
      const result = await testProxmoxConnection({
        host: host ?? stored.host,
        tokenId: tokenId ?? stored.tokenId,
        tokenSecret:
          tokenSecret && tokenSecret.length > 0
            ? tokenSecret
            : stored.tokenSecret,
        authPassword:
          authPassword && authPassword.length > 0
            ? authPassword
            : stored.authPassword,
        allowSelfSigned: allowSelfSigned ?? stored.allowSelfSigned,
        repair,
      });
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (!tokenSecret?.trim()) {
      return Response.json(
        { error: "Token secret is required when testing unsaved credentials." },
        { status: 400 },
      );
    }

    const result = await testProxmoxConnection({
      host: host!,
      tokenId: tokenId!,
      tokenSecret,
      authPassword,
      allowSelfSigned: allowSelfSigned !== false,
      repair,
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    console.error("Test server error:", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Connection test failed",
      },
      { status: 500 },
    );
  }
}
