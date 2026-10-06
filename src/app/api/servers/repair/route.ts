import { z } from "zod";
import { getServerById, updateServer } from "@/lib/servers";
import { repairProxmoxTokenAccess } from "@/lib/proxmox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const repairSchema = z
  .object({
    serverId: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    tokenSecret: z.string().optional(),
    authPassword: z.string().optional(),
    allowSelfSigned: z.boolean().optional(),
    /** Persist the password on the saved server after a successful repair. */
    savePassword: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.serverId) ||
      (Boolean(value.host) && Boolean(value.tokenId)),
    { message: "Provide serverId or host + tokenId." },
  );

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = repairSchema.safeParse(json);
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
      savePassword,
    } = parsed.data;

    let resolvedHost = host;
    let resolvedTokenId = tokenId;
    let resolvedSecret = tokenSecret;
    let resolvedPassword = authPassword;
    let resolvedSelfSigned = allowSelfSigned;

    if (serverId) {
      const stored = await getServerById(serverId);
      if (!stored) {
        return Response.json({ error: "Server not found." }, { status: 404 });
      }
      resolvedHost = host ?? stored.host;
      resolvedTokenId = tokenId ?? stored.tokenId;
      resolvedSecret =
        tokenSecret && tokenSecret.length > 0
          ? tokenSecret
          : stored.tokenSecret;
      resolvedPassword =
        authPassword && authPassword.length > 0
          ? authPassword
          : stored.authPassword;
      resolvedSelfSigned = allowSelfSigned ?? stored.allowSelfSigned;
    }

    if (!resolvedSecret?.trim()) {
      return Response.json(
        { error: "Token secret is required." },
        { status: 400 },
      );
    }
    if (!resolvedPassword?.trim()) {
      return Response.json(
        {
          error:
            "Proxmox user password is required to repair token ACLs. Edit the server and add it.",
        },
        { status: 400 },
      );
    }

    const result = await repairProxmoxTokenAccess({
      host: resolvedHost!,
      tokenId: resolvedTokenId!,
      tokenSecret: resolvedSecret,
      authPassword: resolvedPassword,
      allowSelfSigned: resolvedSelfSigned !== false,
    });

    if (result.ok && savePassword !== false && serverId && authPassword?.trim()) {
      await updateServer(serverId, { authPassword });
    }

    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    console.error("Repair token access error:", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to repair token access",
      },
      { status: 500 },
    );
  }
}
