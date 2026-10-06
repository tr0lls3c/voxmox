/**
 * Proxmox auth helpers: token normalization, ticket login, ACL repair.
 *
 * Privilege-separated tokens often authenticate fine (/version, node list) while
 * /nodes/{node}/status returns 403 Sys.Audit. When we have the backing user's
 * password we can grant the token a real ACL and retry.
 */

import { proxmoxTlsFetch } from "./tls-fetch";

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
  const body = new URLSearchParams({
    username: input.username,
    password: input.password,
  });

  const response = await proxmoxTlsFetch(`${input.apiBase}/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    rejectUnauthorized: input.rejectUnauthorized,
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

/** Preferred least-privilege roles for dashboard + Alexa (stats + power). */
export const VOXMOX_ACL_ROLES = "PVEAuditor,PVEVMAdmin";

async function putAcl(input: {
  apiBase: string;
  rejectUnauthorized: boolean;
  headers: Headers;
  body: URLSearchParams;
}): Promise<Response> {
  return proxmoxTlsFetch(`${input.apiBase}/access/acl`, {
    method: "PUT",
    headers: input.headers,
    body: input.body,
    cache: "no-store",
    rejectUnauthorized: input.rejectUnauthorized,
  });
}

/**
 * Grant dashboard ACL on `/` to the API token (and ensure the user has it too).
 * Prefers PVEAuditor+PVEVMAdmin; falls back to Administrator if that write fails.
 */
export async function grantTokenDashboardAccess(input: {
  apiBase: string;
  rejectUnauthorized: boolean;
  tokenId: string;
  /** Token auth header value, or ticket session. */
  auth:
    | { kind: "token"; authorization: string }
    | { kind: "ticket"; session: TicketSession };
}): Promise<{ roles: string }> {
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

  const tryRoles = async (roles: string): Promise<void> => {
    const roleList = roles.split(",").map((r) => r.trim()).filter(Boolean);
    for (const role of roleList) {
      const tokenBody = new URLSearchParams({
        path: "/",
        roles: role,
        tokens: input.tokenId,
        propagate: "1",
      });

      const tokenRes = await putAcl({
        apiBase: input.apiBase,
        rejectUnauthorized: input.rejectUnauthorized,
        headers,
        body: tokenBody,
      });

      if (!tokenRes.ok) {
        const detail = await readErrorBody(tokenRes);
        throw new Error(
          `Failed to grant token ACL role ${role} (${tokenRes.status}): ${detail}`,
        );
      }

      const userBody = new URLSearchParams({
        path: "/",
        roles: role,
        users: userId,
        propagate: "1",
      });

      const userRes = await putAcl({
        apiBase: input.apiBase,
        rejectUnauthorized: input.rejectUnauthorized,
        headers,
        body: userBody,
      });

      if (!userRes.ok) {
        const detail = await readErrorBody(userRes);
        console.warn(
          `User ACL grant for ${role} returned ${userRes.status}: ${detail}`,
        );
      }
    }
  };

  try {
    await tryRoles(VOXMOX_ACL_ROLES);
    return { roles: VOXMOX_ACL_ROLES };
  } catch (leastPrivError) {
    console.warn(
      `Least-privilege ACL failed, falling back to Administrator:`,
      leastPrivError instanceof Error ? leastPrivError.message : leastPrivError,
    );
    await tryRoles("Administrator");
    return { roles: "Administrator" };
  }
}

/** @deprecated Use grantTokenDashboardAccess */
export const grantTokenAdministrator = grantTokenDashboardAccess;

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
    `On the Proxmox host run (preferred least-privilege):\n` +
    `  pveum acl modify / -user '${userId}' -role PVEAuditor\n` +
    `  pveum acl modify / -user '${userId}' -role PVEVMAdmin\n` +
    `  pveum acl modify / -token '${tokenId}' -role PVEAuditor\n` +
    `  pveum acl modify / -token '${tokenId}' -role PVEVMAdmin\n` +
    `Fallback (full admin):\n` +
    `  pveum acl modify / -user '${userId}' -role Administrator\n` +
    `  pveum acl modify / -token '${tokenId}' -role Administrator\n` +
    `Or edit the token and disable Privilege Separation. ` +
    `In the UI, the ACL identity type must be “API Token”, not “User”.`
  );
}
