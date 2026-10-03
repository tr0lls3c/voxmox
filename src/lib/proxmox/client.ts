import {
  getMockOverview,
  getMockResources,
  mockPowerAction,
} from "./mock";
import type {
  ClusterOverview,
  ClusterResource,
  GuestStatus,
  GuestType,
  NodeStatus,
  PowerAction,
  PowerResult,
} from "./types";

export interface ProxmoxConfig {
  host: string;
  tokenId: string;
  tokenSecret: string;
  rejectUnauthorized: boolean;
  mock: boolean;
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getProxmoxConfig(): ProxmoxConfig {
  const host = (process.env.PROXMOX_HOST ?? "").replace(/\/$/, "");
  const tokenId = process.env.PROXMOX_TOKEN_ID ?? "";
  const tokenSecret = process.env.PROXMOX_TOKEN_SECRET ?? "";
  const forceMock = envFlag("PROXMOX_MOCK", false);
  const rejectUnauthorized = !envFlag("PROXMOX_ALLOW_SELF_SIGNED", true);

  const mock = forceMock || !host || !tokenId || !tokenSecret;

  if (!rejectUnauthorized && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    // Homelab Proxmox installs commonly use self-signed certs.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  return {
    host,
    tokenId,
    tokenSecret,
    rejectUnauthorized,
    mock,
  };
}

class ProxmoxApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProxmoxApiError";
  }
}

async function proxmoxFetch<T>(
  config: ProxmoxConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!config.host) {
    throw new ProxmoxApiError("PROXMOX_HOST is not configured.");
  }

  const url = `${config.host}/api2/json${path}`;
  const headers = new Headers(init?.headers);
  headers.set(
    "Authorization",
    `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
  );

  // Node's undici respects NODE_TLS_REJECT_UNAUTHORIZED; document in README.
  const response = await fetch(url, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProxmoxApiError(
      `Proxmox API ${response.status}: ${body || response.statusText}`,
      response.status,
    );
  }

  const json = (await response.json()) as { data: T };
  return json.data;
}

function resourceToGuest(resource: ClusterResource): GuestStatus | null {
  if (resource.type !== "qemu" && resource.type !== "lxc") return null;
  if (resource.vmid == null || !resource.node) return null;
  if (resource.template === 1) return null;

  return {
    vmid: resource.vmid,
    name: resource.name ?? `${resource.type}-${resource.vmid}`,
    type: resource.type,
    node: resource.node,
    status: resource.status ?? "unknown",
    cpu: resource.cpu ?? 0,
    cpus: resource.maxcpu ?? 1,
    mem: resource.mem ?? 0,
    maxmem: resource.maxmem ?? 0,
    disk: resource.disk ?? 0,
    maxdisk: resource.maxdisk ?? 0,
    uptime: resource.uptime ?? 0,
  };
}

function resourceToNode(resource: ClusterResource): NodeStatus | null {
  if (resource.type !== "node" || !resource.node) return null;
  return {
    node: resource.node,
    status: resource.status ?? "unknown",
    cpu: resource.cpu ?? 0,
    maxcpu: resource.maxcpu ?? 1,
    mem: resource.mem ?? 0,
    maxmem: resource.maxmem ?? 0,
    uptime: resource.uptime ?? 0,
  };
}

function buildOverview(
  resources: ClusterResource[],
  mode: "live" | "mock",
): ClusterOverview {
  const nodes = resources
    .map(resourceToNode)
    .filter((n): n is NodeStatus => n !== null)
    .sort((a, b) => a.node.localeCompare(b.node));

  const guests = resources
    .map(resourceToGuest)
    .filter((g): g is GuestStatus => g !== null)
    .sort((a, b) => a.vmid - b.vmid);

  return {
    mode,
    nodes,
    guests,
    summary: {
      nodeCount: nodes.length,
      onlineNodes: nodes.filter((n) => n.status === "online").length,
      vmCount: guests.filter((g) => g.type === "qemu").length,
      lxcCount: guests.filter((g) => g.type === "lxc").length,
      runningGuests: guests.filter((g) => g.status === "running").length,
      stoppedGuests: guests.filter((g) => g.status !== "running").length,
    },
  };
}

export async function listResources(): Promise<ClusterResource[]> {
  const config = getProxmoxConfig();
  if (config.mock) return getMockResources();
  return proxmoxFetch<ClusterResource[]>(config, "/cluster/resources");
}

export async function getClusterOverview(): Promise<ClusterOverview> {
  const config = getProxmoxConfig();
  if (config.mock) return getMockOverview();

  const resources = await listResources();
  return buildOverview(resources, "live");
}

export async function getNodeStatus(nodeName: string): Promise<NodeStatus | null> {
  const overview = await getClusterOverview();
  const needle = nodeName.toLowerCase();
  return (
    overview.nodes.find((n) => n.node.toLowerCase() === needle) ??
    overview.nodes.find((n) => n.node.toLowerCase().includes(needle)) ??
    null
  );
}

export async function findGuest(
  query: string,
  preferredType?: GuestType,
): Promise<GuestStatus | null> {
  const overview = await getClusterOverview();
  const normalized = normalizeName(query);
  const guests = preferredType
    ? overview.guests.filter((g) => g.type === preferredType)
    : overview.guests;

  const byVmid = Number.parseInt(normalized, 10);
  if (!Number.isNaN(byVmid)) {
    const match = guests.find((g) => g.vmid === byVmid);
    if (match) return match;
  }

  const exact = guests.find((g) => normalizeName(g.name) === normalized);
  if (exact) return exact;

  const partial = guests.filter((g) =>
    normalizeName(g.name).includes(normalized),
  );
  if (partial.length === 1) return partial[0];

  // Prefer higher fuzzy score
  let best: GuestStatus | null = null;
  let bestScore = 0;
  for (const guest of guests) {
    const score = similarity(normalized, normalizeName(guest.name));
    if (score > bestScore) {
      bestScore = score;
      best = guest;
    }
  }

  return bestScore >= 0.55 ? best : null;
}

export async function powerGuest(
  vmid: number,
  type: GuestType,
  node: string,
  action: PowerAction,
): Promise<PowerResult> {
  const config = getProxmoxConfig();
  if (config.mock) return mockPowerAction(vmid, type, action);

  const path = `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`;
  await proxmoxFetch(config, path, { method: "POST" });

  const guest = await findGuest(String(vmid), type);
  const name = guest?.name ?? `${type} ${vmid}`;
  const verb =
    action === "start"
      ? "started"
      : action === "stop"
        ? "force stopped"
        : action === "shutdown"
          ? "shut down"
          : action === "reboot"
            ? "rebooted"
            : "reset";

  return {
    ok: true,
    message: `${name} has been ${verb}.`,
    guest: guest ?? undefined,
  };
}

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : overlap / union;
}

export { ProxmoxApiError };
