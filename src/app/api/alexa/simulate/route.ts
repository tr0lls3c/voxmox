import { handleAlexaRequest } from "@/lib/alexa/handler";
import type { RequestEnvelope } from "ask-sdk-model";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  intent: z.string().min(1),
  slots: z.record(z.string(), z.string()).optional(),
});

function buildEnvelope(
  intentName: string,
  slots?: Record<string, string>,
): RequestEnvelope {
  const slotEntries = Object.fromEntries(
    Object.entries(slots ?? {}).map(([name, value]) => [
      name,
      {
        name,
        value,
        confirmationStatus: "NONE" as const,
      },
    ]),
  );

  return {
    version: "1.0",
    session: {
      new: true,
      sessionId: "amzn1.echo-api.session.test",
      application: { applicationId: "amzn1.ask.skill.test" },
      user: { userId: "amzn1.ask.account.test" },
    },
    context: {
      System: {
        application: { applicationId: "amzn1.ask.skill.test" },
        user: { userId: "amzn1.ask.account.test" },
        device: { deviceId: "test-device", supportedInterfaces: {} },
        apiEndpoint: "https://api.amazonalexa.com",
      },
    },
    request: {
      type: "IntentRequest",
      requestId: `amzn1.echo-api.request.${Date.now()}`,
      timestamp: new Date().toISOString(),
      locale: "en-US",
      dialogState: "COMPLETED",
      intent: {
        name: intentName,
        confirmationStatus: "NONE",
        slots: slotEntries,
      },
    },
  };
}

export async function POST(request: Request) {
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

  const envelope = buildEnvelope(parsed.data.intent, parsed.data.slots);
  const response = await handleAlexaRequest(envelope);
  const speech =
    response.response.outputSpeech &&
    "text" in response.response.outputSpeech
      ? response.response.outputSpeech.text
      : null;

  return Response.json({ speech, response });
}
