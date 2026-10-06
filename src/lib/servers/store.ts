import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeProxmoxHost } from "@/lib/proxmox/client";
import type {
  ProxmoxServer,
  ProxmoxServerPublic,
  ServerInput,
  ServersConfig,
} from "./types";

const EMPTY_CONFIG: ServersConfig = {
  activeServerId: null,
  servers: [],
};

/** Durable system path used on LXC/production installs. */
export const SYSTEM_DATA_DIR = "/var/lib/voxmox";

function localDataDir(): string {
  return path.join(process.cwd(), "data");
}

function dirExists(target: string): boolean {
  try {
    accessSync(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve where servers.json lives.
 * Priority: VOXMOX_DATA_DIR → /var/lib/voxmox (when present) → ./data.
 */
export function getDataDir(): string {
  const fromEnv = process.env.VOXMOX_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;

  // LXC installer creates this before the service starts. Prefer it when present
  // so settings survive /opt/voxmox updates. Fall back to ./data otherwise
  // (local `next start` without root).
  if (dirExists(SYSTEM_DATA_DIR)) {
    return SYSTEM_DATA_DIR;
  }

  return localDataDir();
}

export function getServersConfigPath(): string {
  return path.join(getDataDir(), "servers.json");
}

function normalizeHost(host: string): string {
  return normalizeProxmoxHost(host);
}

function validateInput(input: ServerInput, requireSecret: boolean): void {
  if (!input.name?.trim()) throw new Error("Server name is required.");
  if (!input.host?.trim()) throw new Error("API URL is required.");
  try {
    const url = new URL(normalizeHost(input.host));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("API URL must start with http:// or https://");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("API URL")) throw error;
    throw new Error("API URL is invalid.");
  }
  if (!input.tokenId?.trim()) throw new Error("Token ID is required.");
  if (requireSecret && !input.tokenSecret?.trim()) {
    throw new Error("Token secret is required.");
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDataDir(): Promise<void> {
  await mkdir(getDataDir(), { recursive: true, mode: 0o750 });
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(getDataDir(), 0o750);
  } catch {
    // Best-effort on platforms that ignore mode.
  }
}

/**
 * One-time move from legacy ./data/servers.json into the active data dir
 * (e.g. after switching to /var/lib/voxmox).
 */
async function migrateLegacyConfigIfNeeded(): Promise<void> {
  const target = getServersConfigPath();
  if (await pathExists(target)) return;

  const candidates = [
    path.join(localDataDir(), "servers.json"),
    path.join(SYSTEM_DATA_DIR, "servers.json"),
    path.join(process.cwd(), "data", "servers.json"),
  ];

  for (const candidate of candidates) {
    if (candidate === target) continue;
    if (!(await pathExists(candidate))) continue;
    await ensureDataDir();
    await copyFile(candidate, target);
    return;
  }
}

function parseConfig(raw: string): ServersConfig {
  const parsed = JSON.parse(raw) as ServersConfig;
  if (!parsed || !Array.isArray(parsed.servers)) {
    return structuredClone(EMPTY_CONFIG);
  }
  return {
    activeServerId: parsed.activeServerId ?? null,
    servers: parsed.servers.map((server) => ({
      ...server,
      host: normalizeHost(server.host),
      allowSelfSigned: server.allowSelfSigned !== false,
      enabled: server.enabled !== false,
    })),
  };
}

export async function readServersConfig(): Promise<ServersConfig> {
  await migrateLegacyConfigIfNeeded();
  try {
    const raw = await readFile(getServersConfigPath(), "utf8");
    return parseConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_CONFIG);
    }
    throw error;
  }
}

async function writeServersConfig(config: ServersConfig): Promise<void> {
  await ensureDataDir();
  const target = getServersConfigPath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(temp, payload, { mode: 0o600 });
  await rename(temp, target);
}

export function toPublicServer(
  server: ProxmoxServer,
  activeServerId: string | null,
): ProxmoxServerPublic {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    tokenId: server.tokenId,
    hasTokenSecret: Boolean(server.tokenSecret),
    hasAuthPassword: Boolean(server.authPassword),
    allowSelfSigned: server.allowSelfSigned,
    enabled: server.enabled,
    isActive: server.id === activeServerId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export async function listServersPublic(): Promise<{
  activeServerId: string | null;
  servers: ProxmoxServerPublic[];
  dataDir: string;
  configPath: string;
}> {
  const config = await readServersConfig();
  return {
    activeServerId: config.activeServerId,
    servers: config.servers.map((server) =>
      toPublicServer(server, config.activeServerId),
    ),
    dataDir: getDataDir(),
    configPath: getServersConfigPath(),
  };
}

export async function getServerById(id: string): Promise<ProxmoxServer | null> {
  const config = await readServersConfig();
  return config.servers.find((server) => server.id === id) ?? null;
}

export async function getActiveServer(): Promise<ProxmoxServer | null> {
  const config = await readServersConfig();
  if (config.activeServerId) {
    const active = config.servers.find(
      (server) => server.id === config.activeServerId && server.enabled,
    );
    if (active) return active;
  }
  return config.servers.find((server) => server.enabled) ?? null;
}

export async function createServer(input: ServerInput): Promise<ProxmoxServerPublic> {
  validateInput(input, true);
  const config = await readServersConfig();
  const now = new Date().toISOString();
  const server: ProxmoxServer = {
    id: randomUUID(),
    name: input.name.trim(),
    host: normalizeHost(input.host),
    tokenId: input.tokenId.trim(),
    tokenSecret: input.tokenSecret!.trim(),
    authPassword: input.authPassword?.trim() || undefined,
    allowSelfSigned: input.allowSelfSigned !== false,
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };

  config.servers.push(server);
  if (input.setActive !== false || !config.activeServerId) {
    config.activeServerId = server.id;
  }
  await writeServersConfig(config);
  return toPublicServer(server, config.activeServerId);
}

export async function updateServer(
  id: string,
  input: Partial<ServerInput>,
): Promise<ProxmoxServerPublic> {
  const config = await readServersConfig();
  const index = config.servers.findIndex((server) => server.id === id);
  if (index < 0) throw new Error("Server not found.");

  const current = config.servers[index];
  const nextSecret =
    input.tokenSecret !== undefined && input.tokenSecret !== ""
      ? input.tokenSecret.trim()
      : current.tokenSecret;

  let nextPassword = current.authPassword;
  if (input.authPassword !== undefined) {
    nextPassword = input.authPassword.trim() || undefined;
  }

  const merged: ServerInput = {
    name: input.name ?? current.name,
    host: input.host ?? current.host,
    tokenId: input.tokenId ?? current.tokenId,
    tokenSecret: nextSecret,
    authPassword: nextPassword,
    allowSelfSigned: input.allowSelfSigned ?? current.allowSelfSigned,
    enabled: input.enabled ?? current.enabled,
  };
  validateInput(merged, true);

  const updated: ProxmoxServer = {
    ...current,
    name: merged.name.trim(),
    host: normalizeHost(merged.host),
    tokenId: merged.tokenId.trim(),
    tokenSecret: nextSecret,
    authPassword: nextPassword,
    allowSelfSigned: merged.allowSelfSigned !== false,
    enabled: merged.enabled !== false,
    updatedAt: new Date().toISOString(),
  };

  config.servers[index] = updated;
  if (input.setActive) {
    config.activeServerId = id;
  }
  if (!updated.enabled && config.activeServerId === id) {
    config.activeServerId =
      config.servers.find((server) => server.enabled)?.id ?? null;
  }

  await writeServersConfig(config);
  return toPublicServer(updated, config.activeServerId);
}

export async function deleteServer(id: string): Promise<void> {
  const config = await readServersConfig();
  const nextServers = config.servers.filter((server) => server.id !== id);
  if (nextServers.length === config.servers.length) {
    throw new Error("Server not found.");
  }

  config.servers = nextServers;
  if (config.activeServerId === id) {
    config.activeServerId =
      nextServers.find((server) => server.enabled)?.id ?? null;
  }
  await writeServersConfig(config);
}

export async function setActiveServer(id: string): Promise<ProxmoxServerPublic> {
  const config = await readServersConfig();
  const server = config.servers.find((item) => item.id === id);
  if (!server) throw new Error("Server not found.");
  if (!server.enabled) {
    throw new Error("Enable the server before making it active.");
  }

  config.activeServerId = id;
  await writeServersConfig(config);
  return toPublicServer(server, config.activeServerId);
}
