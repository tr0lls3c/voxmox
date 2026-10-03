import { createVerify, createPublicKey, X509Certificate } from "node:crypto";
import type { RequestEnvelope } from "ask-sdk-model";

const CERT_CHAIN_URL_PATTERN =
  /^https:\/\/s3\.amazonaws\.com\/echo\.api\/(?:.+\/)?echo-api-cert(?:-\d+)?\.pem$/i;

const ALEXA_SERVICE_DOMAIN = "echo-api.amazon.com";

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function shouldSkipAlexaVerification(): boolean {
  return (
    envFlag("ALEXA_SKIP_SIGNATURE_VALIDATION", false) ||
    process.env.NODE_ENV === "development"
  );
}

export async function verifyAlexaRequest(options: {
  body: string;
  signature: string | null;
  signatureCertChainUrl: string | null;
}): Promise<void> {
  if (shouldSkipAlexaVerification()) return;

  const { body, signature, signatureCertChainUrl } = options;
  if (!signature || !signatureCertChainUrl) {
    throw new Error("Missing Alexa signature headers.");
  }

  validateCertUrl(signatureCertChainUrl);

  const certPem = await fetch(signatureCertChainUrl, { cache: "no-store" }).then(
    async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to download Alexa certificate: ${res.status}`);
      }
      return res.text();
    },
  );

  validateCertificate(certPem);

  const verifier = createVerify("RSA-SHA1");
  verifier.update(body, "utf8");
  verifier.end();

  const valid = verifier.verify(createPublicKey(certPem), signature, "base64");
  if (!valid) {
    throw new Error("Alexa signature verification failed.");
  }

  const envelope = JSON.parse(body) as RequestEnvelope;
  const timestamp = envelope.request?.timestamp;
  if (!timestamp) {
    throw new Error("Alexa request missing timestamp.");
  }

  const ageMs = Math.abs(Date.now() - Date.parse(timestamp));
  if (Number.isNaN(ageMs) || ageMs > 150_000) {
    throw new Error("Alexa request timestamp is stale.");
  }
}

function validateCertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid Alexa certificate URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Alexa certificate URL must use HTTPS.");
  }
  if (parsed.hostname.toLowerCase() !== "s3.amazonaws.com") {
    throw new Error("Alexa certificate URL host is not allowed.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Alexa certificate URL must use port 443.");
  }
  if (!CERT_CHAIN_URL_PATTERN.test(url)) {
    throw new Error("Alexa certificate URL path is not allowed.");
  }
}

function validateCertificate(pem: string): void {
  const cert = new X509Certificate(pem);
  const altNames = cert.subjectAltName ?? "";
  if (!altNames.includes(`DNS:${ALEXA_SERVICE_DOMAIN}`)) {
    throw new Error("Alexa certificate SAN validation failed.");
  }

  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
    throw new Error("Alexa certificate is expired or not yet valid.");
  }
}
