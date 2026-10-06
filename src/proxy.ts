import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Split deployment modes (same build, different ports/hosts):
 * - all (default): UI + every API — local/dev convenience
 * - dashboard: UI + control-plane APIs; Alexa skill path disabled
 * - api: Alexa skill (+ health) only; UI and dashboard APIs disabled
 */
type ServiceMode = "all" | "dashboard" | "api";

function getServiceMode(): ServiceMode {
  const raw = (process.env.VOXMOX_SERVICE_MODE ?? "all").toLowerCase().trim();
  if (raw === "dashboard" || raw === "api" || raw === "all") return raw;
  return "all";
}

function isAlexaSkillPath(pathname: string): boolean {
  return pathname === "/api/alexa" || pathname === "/api/alexa/";
}

function isHealthPath(pathname: string): boolean {
  return pathname === "/api/health" || pathname === "/api/health/";
}

export function proxy(request: NextRequest) {
  const mode = getServiceMode();
  if (mode === "all") return NextResponse.next();

  const { pathname } = request.nextUrl;

  if (mode === "api") {
    if (isAlexaSkillPath(pathname) || isHealthPath(pathname)) {
      return NextResponse.next();
    }
    return NextResponse.json(
      {
        error:
          "This host serves the Alexa API only. Use the dashboard host for the UI and control plane.",
        mode: "api",
        skillEndpoint: "/api/alexa",
      },
      { status: 404 },
    );
  }

  // dashboard mode — keep /api/alexa/simulate on the dashboard host
  if (isAlexaSkillPath(pathname)) {
    return NextResponse.json(
      {
        error:
          "Alexa skill endpoint is on the API host, not the dashboard. Point the skill at the API subdomain.",
        mode: "dashboard",
      },
      { status: 404 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except static assets Next serves directly.
     */
    "/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|svg|webp|gif)$).*)",
  ],
};
