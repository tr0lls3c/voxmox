/**
 * Proxmox auth helpers: token normalization, ticket login, ACL repair.
 *
 * Privilege-separated tokens often authenticate fine (/version, node list) while
 * /nodes/{node}/status returns 403 Sys.Audit. When we have the backing user's
 * password we can grant the token a real Administrator ACL and retry.
 */

export interface TokenCredentials {
  tokenId: string;
  tokenSecret: string;
}

export interface TicketSession {
  ticket: string;
  csrf: string;
  username: string;
}

export interface AuthRepairResult {
  ok: boolean;
  repaired: boolean;
  usedTicketFallback: boolean;
  message?: string;
}

/** Strip common paste mistakes from token id / secret fields. */
export function normalizeTokenCredentials(
  rawTokenId: string,
  rawTokenSecret: string,
): TokenCredentials {
  let tokenId = rawTokenId.trim().replace(/^PVEAPIToken=/i, "");
  let tokenSecret = rawTokenSecret.trim().replace(/^PVEAPIToken=/i, "");

  // Strip wrapping quotes from password managers / .env files.
  tokenId = tokenId.replace(/^['"]|['"]$/g, "");
  tokenSecret = tokenSecret.replace(/^['"]|['"]$/g, "");

  // User pasted "user@realm!token=uuid" into the token id field.
  if (!tokenSecret && tokenId.includes("=")) {
    const idx = tokenId.indexOf("=");
    tokenSecret = tokenId.slice(idx + 1).trim();
    tokenId = tokenId.slice(0, idx).trim();
  }

  // User pasted full "user@realm!token=uuid" into token id while also filling secret.
  if (tokenId.includes("=") && tokenSecret) {
    const idx = tokenId.indexOf("=");
    const maybeSecret = tokenId.slice(idx + 1).trim();
    const maybeId = tokenId.slice(0, idx).trim();
    if (maybeId.includes("@") && maybeId.includes("!")) {
      tokenId = maybeId;
      if (!tokenSecret) tokenSecret = maybeSecret;
    }
  }

  // Secret field accidentally contains "id=secret".
  if (tokenSecret.includes("=") && tokenSecret.includes("@")) {
    const idx = tokenSecret.indexOf("=");
    const maybeId = tokenSecret.slice(0, idx).trim();
    if (maybeId.includes("@") && maybeId.includes("!")) {
      tokenId = maybeId;
      tokenSecret = tokenSecret.slice(idx + 1).trim();
    }
  }

  return { tokenId, tokenSecret };
}

/** `root@pam!voxmox` → `root@pam` */
export function userIdFromTokenId(tokenId: string): string {
  const bang = tokenId.indexOf("!");
  if (bang <= 0) {
    throw new Error(
      `Token ID must look like user@realm!tokenname (got “${tokenId}”).`,
    );
  }
  return tokenId.slice(0, bang);
}

export function buildTokenAuthorization(tokenId: string, tokenSecret: string): string {
  const normalized = normalizeTokenCredentials(tokenId, tokenSecret);
  return `PVEAPIToken=${normalized.tokenId}=${normalized.tokenSecret}`;
}

function applyTls(rejectUnauthorized: boolean): void {
  if (!rejectUnauthorized && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText;
  try {
    const json = JSON.parse(text) as { message?: string; errors?: unknown };
    if (typeof json.message === "string" && json.message.trim()) {
      return json.message.trim();
    }
  } catch {
    // keep raw text
  }
  return text;
}

/** Login as the Proxmox user (ticket + CSRF). */
export async function createTicket(input: {
  host: string;
  username: string;
  password: string;
  rejectUnauthorized: boolean;
  apiBase: string;
}): Promise<TicketSession> {
  applyTls(input.rejectUnauthorized);

  const body = new URLSearchParams({
    username: input.username,
    password: input.password,
  });

  const response = await fetch(`${input.apiBase}/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(
      `Proxmox login failed (${response.status}): ${detail}`,
    );
  }

  const json = (await response.json()) as {
    data?: { ticket?: string; CSRFPreventionToken?: string; username?: string };
  };

  const ticket = json.data?.ticket;
  const csrf = json.data?.CSRFPreventionToken;
  if (!ticket || !csrf) {
    throw new Error("Proxmox login succeeded but returned no ticket.");
  }

  return {
    ticket,
    csrf,
    username: json.data?.username ?? input.username,
  };
}

/**
 * Grant Administrator on `/` to the API token (and ensure the user has it too).
 * Must be called with an auth identity that can modify ACLs (usually a ticket
 * for root/Administrator, not a locked-down token).
 */
export async function grantTokenAdministrator(input: {
  apiBase: string;
  rejectUnauthorized: boolean;
  tokenId: string;
  /** Token auth header value, or ticket session. */
  auth:
    | { kind: "token"; authorization: string }
    | { kind: "ticket"; session: TicketSession };
}): Promise<void> {
  applyTls(input.rejectUnauthorized);

  const userId = userIdFromTokenId(input.tokenId);
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });

  if (input.auth.kind === "token") {
    headers.set("Authorization", input.auth.authorization);
  } else {
    headers.set("Cookie", `PVEAuthCookie=${input.auth.session.ticket}`);
    headers.set("CSRFPreventionToken", input.auth.session.csrf);
  }

  // Token ACL — this is what privilege-separated tokens need.
  const tokenBody = new URLSearchParams({
    path: "/",
    roles: "Administrator",
    tokens: input.tokenId,
    propagate: "1",
  });

  const tokenRes = await fetch(`${input.apiBase}/access/acl`, {
    method: "PUT",
    headers,
    body: tokenBody,
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    const detail = await readErrorBody(tokenRes);
    throw new Error(
      `Failed to grant token ACL (${tokenRes.status}): ${detail}`,
    );
  }

  // User ACL — required for privsep intersection (user ∩ token).
  const userBody = new URLSearchParams({
    path: "/",
    roles: "Administrator",
    users: userId,
    propagate: "1",
  });

  const userRes = await fetch(`${input.apiBase}/access/acl`, {
    method: "PUT",
    headers,
    body: userBody,
    cache: "no-store",
  });

  // User grant is best-effort; token grant is the critical one.
  if (!userRes.ok) {
    const detail = await readErrorBody(userRes);
    // Non-fatal if user already has rights via group membership.
    console.warn(`User ACL grant returned ${userRes.status}: ${detail}`);
  }
}

/** True when an error looks like a Proxmox privilege failure. */
export function isPermissionDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Sys.Audit") ||
    message.includes("Permission check failed") ||
    message.includes(" 403 ") ||
    /\b403\b/.test(message)
  );
}

export function pveumRepairHint(tokenId: string): string {
  const userId = (() => {
    try {
      return userIdFromTokenId(tokenId);
    } catch {
      return "user@realm";
    }
  })();

  return (
    `On the Proxmox host run:\n` +
    `  pveum acl modify / -user '${userId}' -role Administrator\n` +
    `  pveum acl modify / -token '${tokenId}' -role Administrator\n` +
    `Or edit the token and disable Privilege Separation. ` +
    `In the UI, the ACL identity type must be “API Token”, not “User”.`
  );
}
