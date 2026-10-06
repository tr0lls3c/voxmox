import { handleAlexaRequest } from "@/lib/alexa/handler";
import { verifyAlexaRequest } from "@/lib/alexa/verify";
import type { RequestEnvelope } from "ask-sdk-model";
import { clientKey, rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = rateLimit(clientKey(request, "alexa"), {
    limit: 120,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const body = await request.text();

  try {
    await verifyAlexaRequest({
      body,
      signature: request.headers.get("signature"),
      signatureCertChainUrl: request.headers.get("signaturecertchainurl"),
    });
  } catch (error) {
    console.warn("Alexa verification failed:", error);
    return Response.json(
      { error: "Unauthorized Alexa request" },
      { status: 401 },
    );
  }

  let envelope: RequestEnvelope;
  try {
    envelope = JSON.parse(body) as RequestEnvelope;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const skillId = process.env.ALEXA_SKILL_ID?.trim();
  if (process.env.NODE_ENV === "production" && !skillId) {
    console.error("ALEXA_SKILL_ID is required in production.");
    return Response.json(
      { error: "Alexa skill is not configured." },
      { status: 503 },
    );
  }

  if (skillId) {
    const sessionId = envelope.session?.application?.applicationId;
    const contextId = envelope.context?.System?.application?.applicationId;
    if (sessionId !== skillId && contextId !== skillId) {
      return Response.json({ error: "Unexpected skill ID" }, { status: 403 });
    }
  }

  const response = await handleAlexaRequest(envelope);
  return Response.json(response);
}

export async function GET() {
  return Response.json({
    ok: true,
    skill: "Voxmox",
    endpoint: "/api/alexa",
    hint: "POST Alexa RequestEnvelope JSON here.",
  });
}
