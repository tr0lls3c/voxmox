import { handleAlexaRequest } from "@/lib/alexa/handler";
import { verifyAlexaRequest } from "@/lib/alexa/verify";
import type { RequestEnvelope } from "ask-sdk-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

  const skillId = process.env.ALEXA_SKILL_ID;
  if (
    skillId &&
    envelope.session?.application?.applicationId &&
    envelope.session.application.applicationId !== skillId &&
    envelope.context?.System?.application?.applicationId !== skillId
  ) {
    return Response.json({ error: "Unexpected skill ID" }, { status: 403 });
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
