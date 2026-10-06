import type { ProxmoxConfig } from "@/lib/proxmox/client";
import { normalizeProxmoxHost } from "@/lib/proxmox/client";
import { getActiveServer, getServerById } from "./store";

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function fromEnv(): ProxmoxConfig {
  const host = normalizeProxmoxHost(process.env.PROXMOX_HOST ?? "");
  const tokenId = process.env.PROXMOX_TOKEN_ID ?? "";
  const tokenSecret = process.env.PROXMOX_TOKEN_SECRET ?? "";
  const authPassword = process.env.PROXMOX_AUTH_PASSWORD?.trim() || undefined;
  const forceMock = envFlag("PROXMOX_MOCK", false);
  const rejectUnauthorized = !envFlag("PROXMOX_ALLOW_SELF_SIGNED", true);
  const mock = forceMock || !host || !tokenId || !tokenSecret;
  return {
    host,
    tokenId,
    tokenSecret,
    authPassword,
    rejectUnauthorized,
    mock,
  };
}

/** Resolve connection settings: UI server (preferred) → env → mock. */
export async function resolveProxmoxConfig(
  serverId?: string | null,
): Promise<ProxmoxConfig & { source: "server" | "env" | "mock"; serverName?: string }> {
  const stored = serverId
    ? await getServerById(serverId)
    : await getActiveServer();

  if (stored?.enabled && stored.host && stored.tokenId && stored.tokenSecret) {
    const rejectUnauthorized = !stored.allowSelfSigned;
    return {
      host: normalizeProxmoxHost(stored.host),
      tokenId: stored.tokenId,
      tokenSecret: stored.tokenSecret,
      authPassword: stored.authPassword,
      rejectUnauthorized,
      mock: false,
      source: "server",
      serverName: stored.name,
    };
  }

  const env = fromEnv();
  return {
    ...env,
    source: env.mock ? "mock" : "env",
  };
}
