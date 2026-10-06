import { z } from "zod";
import {
  buildDashboardAuthCookie,
  clearDashboardAuthCookie,
  dashboardAuthConfigured,
  getDashboardSecret,
  isDashboardAuthRequired,
  isInsecureProduction,
  requestHasDashboardAuth,
  tokenMatchesSecret,
} from "@/lib/security/dashboard-auth";
import { clientKey, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  secret: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1)),
});

export async function GET(request: Request) {
  const required = isDashboardAuthRequired();
  const configured = dashboardAuthConfigured();
  const authenticated = configured && requestHasDashboardAuth(request);

  return Response.json({
    required,
    configured,
    authenticated,
    insecureProduction: isInsecureProduction(),
    anonymousAllowed: envAllowsAnonymous(),
  });
}

function envAllowsAnonymous(): boolean {
  const value = process.env.VOXMOX_ALLOW_ANONYMOUS;
  if (value == null || value === "") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export async function POST(request: Request) {
  const limited = rateLimit(clientKey(request, "auth-login"), {
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const secret = getDashboardSecret();
  if (!secret) {
    return Response.json(
      {
        error:
          "VOXMOX_DASHBOARD_SECRET is not set. Add it to .env / the LXC environment, then retry.",
      },
      { status: 503 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Secret is required." }, { status: 400 });
  }

  if (!tokenMatchesSecret(parsed.data.secret)) {
    return Response.json({ error: "Invalid dashboard secret." }, { status: 401 });
  }

  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": buildDashboardAuthCookie(secret, request),
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function DELETE(request: Request) {
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": clearDashboardAuthCookie(request),
        "Cache-Control": "no-store",
      },
    },
  );
}
