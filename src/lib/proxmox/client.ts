import { resolveProxmoxConfig } from "@/lib/servers/resolve";
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

export type ResolvedProxmoxConfig = ProxmoxConfig & {
  source: "server" | "env" | "mock";
  serverName?: string;
};

/** Strip trailing slash and optional /api2/json so we always append it once. */
export function normalizeProxmoxHost(host: string): string {
  return host
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api2\/json\/?$/i, "");
}

/** Full Proxmox JSON API root, e.g. https://pve:8006/api2/json */
export function proxmoxApiBase(host: string): string {
  return `${normalizeProxmoxHost(host)}/api2/json`;
}

const PROXMOX_FETCH_TIMEOUT_MS = 12_000;

interface NodeStatusApi {
  uptime?: number;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  memory?: {
    used?: number;
    free?: number;
    total?: number;
  };
  loadavg?: [string, string, string];
  cpuinfo?: {
    cpus?: number;
  };
}

interface NodeIndexItem {
  node: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  ssl_fingerprint?: string;
}

interface NodeGuestListItem {
  vmid: number;
  name?: string;
  status?: string;
  cpus?: number;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
}

export async function getProxmoxConfig(
  serverId?: string | null,
): Promise<ResolvedProxmoxConfig> {
  return resolveProxmoxConfig(serverId);
}

export async function testProxmoxConnection(input: {
  host: string;
  tokenId: string;
  tokenSecret: string;
  allowSelfSigned?: boolean;
}): Promise<{ ok: boolean; version?: string; error?: string; apiBase?: string }> {
  const rejectUnauthorized = input.allowSelfSigned === false;
  applyTlsEnv(rejectUnauthorized);

  const config: ProxmoxConfig = {
    host: normalizeProxmoxHost(input.host),
    tokenId: input.tokenId.trim(),
    tokenSecret: input.tokenSecret.trim(),
    rejectUnauthorized,
    mock: false,
  };

  try {
    const version = await proxmoxFetch<{ version?: string; release?: string }>(
      config,
      "/version",
    );
    const label = [version.version, version.release].filter(Boolean).join(" ");
    return {
      ok: true,
      version: label || "connected",
      apiBase: proxmoxApiBase(config.host),
    };
  } catch (error) {
    return {
      ok: false,
      apiBase: proxmoxApiBase(config.host),
      error:
        error instanceof Error ? error.message : "Connection test failed",
    };
  }
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

function applyTlsEnv(rejectUnauthorized: boolean): void {
  if (!rejectUnauthorized && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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

  applyTlsEnv(config.rejectUnauthorized);

  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${proxmoxApiBase(config.host)}${apiPath}`;
  const headers = new Headers(init?.headers);
  headers.set(
    "Authorization",
    `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PROXMOX_FETCH_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  init?.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProxmoxApiError(
        `Proxmox API ${response.status} at ${apiPath}: ${body || response.statusText}`,
        response.status,
      );
    }

    const json = (await response.json()) as { data: T };
    return json.data;
  } catch (error) {
    if (error instanceof ProxmoxApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProxmoxApiError(
        `Proxmox API timed out after ${PROXMOX_FETCH_TIMEOUT_MS / 1000}s at ${apiPath}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", onAbort);
  }
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
  if (resource.type !== "node") return null;
  const node = resource.node ?? resource.id?.replace(/^node\//, "");
  if (!node) return null;

  return {
    node,
    status: resource.status ?? "unknown",
    cpu: resource.cpu ?? 0,
    maxcpu: resource.maxcpu ?? 0,
    mem: resource.mem ?? 0,
    maxmem: resource.maxmem ?? 0,
    uptime: resource.uptime ?? 0,
  };
}

function nodeIndexToStatus(item: NodeIndexItem): NodeStatus {
  return {
    node: item.node,
    status: item.status ?? "unknown",
    cpu: item.cpu ?? 0,
    maxcpu: item.maxcpu ?? 0,
    mem: item.mem ?? 0,
    maxmem: item.maxmem ?? 0,
    uptime: item.uptime ?? 0,
  };
}

function summarize(nodes: NodeStatus[], guests: GuestStatus[]) {
  return {
    nodeCount: nodes.length,
    onlineNodes: nodes.filter((n) => n.status === "online").length,
    vmCount: guests.filter((g) => g.type === "qemu").length,
    lxcCount: guests.filter((g) => g.type === "lxc").length,
    runningGuests: guests.filter((g) => g.status === "running").length,
    stoppedGuests: guests.filter((g) => g.status !== "running").length,
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
    summary: summarize(nodes, guests),
  };
}

function nodeStatsMissing(node: NodeStatus): boolean {
  return (
    node.maxmem <= 0 ||
    node.maxcpu <= 0 ||
    (node.status === "online" && node.uptime <= 0 && node.mem <= 0)
  );
}

function mergeNodeStats(base: NodeStatus, richer: NodeStatus): NodeStatus {
  return {
    node: base.node,
    status:
      richer.status && richer.status !== "unknown"
        ? richer.status
        : base.status,
    cpu: richer.cpu || base.cpu,
    maxcpu: richer.maxcpu || base.maxcpu,
    mem: richer.mem || base.mem,
    maxmem: richer.maxmem || base.maxmem,
    uptime: richer.uptime || base.uptime,
    loadavg: richer.loadavg ?? base.loadavg,
  };
}

async function listNodesIndex(
  config: ProxmoxConfig,
): Promise<{ nodes: NodeStatus[]; error?: string }> {
  try {
    const items = await proxmoxFetch<NodeIndexItem[]>(config, "/nodes");
    return {
      nodes: items
        .filter((item) => Boolean(item.node))
        .map(nodeIndexToStatus)
        .sort((a, b) => a.node.localeCompare(b.node)),
    };
  } catch (error) {
    return {
      nodes: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to list /nodes",
    };
  }
}

async function enrichNodeFromStatus(
  config: ProxmoxConfig,
  node: NodeStatus,
): Promise<{ node: NodeStatus; error?: string }> {
  if (!nodeStatsMissing(node)) return { node };

  try {
    const status = await proxmoxFetch<NodeStatusApi>(
      config,
      `/nodes/${encodeURIComponent(node.node)}/status`,
    );

    return {
      node: {
        ...node,
        status: node.status === "unknown" ? "online" : node.status,
        cpu: status.cpu ?? node.cpu,
        maxcpu: status.cpuinfo?.cpus || node.maxcpu || 1,
        mem: status.memory?.used ?? status.mem ?? node.mem,
        maxmem: status.memory?.total ?? status.maxmem ?? node.maxmem,
        uptime: status.uptime ?? node.uptime,
        loadavg: status.loadavg ?? node.loadavg,
      },
    };
  } catch (error) {
    return {
      node: {
        ...node,
        maxcpu: node.maxcpu || 1,
      },
      error:
        error instanceof Error
          ? `${node.node}: ${error.message}`
          : `${node.node}: status fetch failed`,
    };
  }
}

async function listGuestsOnNode(
  config: ProxmoxConfig,
  node: string,
  type: GuestType,
): Promise<{ guests: GuestStatus[]; error?: string }> {
  try {
    const items = await proxmoxFetch<NodeGuestListItem[]>(
      config,
      `/nodes/${encodeURIComponent(node)}/${type}`,
    );

    return {
      guests: items
        .filter((item) => item.template !== 1)
        .map((item) => ({
          vmid: item.vmid,
          name: item.name ?? `${type}-${item.vmid}`,
          type,
          node,
          status: item.status ?? "unknown",
          cpu: item.cpu ?? 0,
          cpus: item.cpus ?? 1,
          mem: item.mem ?? 0,
          maxmem: item.maxmem ?? 0,
          disk: item.disk ?? 0,
          maxdisk: item.maxdisk ?? 0,
          uptime: item.uptime ?? 0,
        })),
    };
  } catch (error) {
    return {
      guests: [],
      error:
        error instanceof Error
          ? `${node}/${type}: ${error.message}`
          : `${node}/${type}: list failed`,
    };
  }
}

async function discoverGuests(
  config: ProxmoxConfig,
  nodes: NodeStatus[],
): Promise<{ guests: GuestStatus[]; errors: string[] }> {
  const results = await Promise.all(
    nodes.flatMap((node) => [
      listGuestsOnNode(config, node.node, "qemu"),
      listGuestsOnNode(config, node.node, "lxc"),
    ]),
  );

  return {
    guests: results.flatMap((r) => r.guests).sort((a, b) => a.vmid - b.vmid),
    errors: results.map((r) => r.error).filter((e): e is string => Boolean(e)),
  };
}

function mergeGuests(
  primary: GuestStatus[],
  secondary: GuestStatus[],
): GuestStatus[] {
  const byKey = new Map<string, GuestStatus>();
  for (const guest of [...secondary, ...primary]) {
    byKey.set(`${guest.type}:${guest.vmid}`, guest);
  }
  return [...byKey.values()].sort((a, b) => a.vmid - b.vmid);
}

function mergeNodeLists(
  primary: NodeStatus[],
  secondary: NodeStatus[],
): NodeStatus[] {
  const byName = new Map<string, NodeStatus>();
  for (const node of primary) {
    byName.set(node.node, node);
  }
  for (const node of secondary) {
    const existing = byName.get(node.node);
    byName.set(node.node, existing ? mergeNodeStats(existing, node) : node);
  }
  return [...byName.values()].sort((a, b) => a.node.localeCompare(b.node));
}

export async function listResources(
  serverId?: string | null,
): Promise<ClusterResource[]> {
  const config = await getProxmoxConfig(serverId);
  if (config.mock) return getMockResources();

  const [all, vms, nodes] = await Promise.all([
    proxmoxFetch<ClusterResource[]>(config, "/cluster/resources"),
    proxmoxFetch<ClusterResource[]>(config, "/cluster/resources?type=vm").catch(
      () => [] as ClusterResource[],
    ),
    proxmoxFetch<ClusterResource[]>(
      config,
      "/cluster/resources?type=node",
    ).catch(() => [] as ClusterResource[]),
  ]);

  const byId = new Map<string, ClusterResource>();
  for (const resource of [...all, ...vms, ...nodes]) {
    byId.set(resource.id, { ...byId.get(resource.id), ...resource });
  }
  return [...byId.values()];
}

export async function getClusterOverview(
  serverId?: string | null,
): Promise<ClusterOverview> {
  const config = await getProxmoxConfig(serverId);
  if (config.mock) return getMockOverview();

  const warnings: string[] = [];
  const resources = await listResources(serverId);
  let overview = buildOverview(resources, "live");

  // /nodes usually returns cpu/mem/uptime even when /cluster/resources is sparse.
  const indexed = await listNodesIndex(config);
  if (indexed.error) {
    warnings.push(indexed.error);
  }
  let nodes = mergeNodeLists(overview.nodes, indexed.nodes);

  // Fill any remaining gaps from per-node /status.
  const enriched = await Promise.all(
    nodes.map((node) => enrichNodeFromStatus(config, node)),
  );
  nodes = enriched.map((item) => item.node);
  for (const item of enriched) {
    if (item.error) warnings.push(item.error);
  }

  const stillEmpty = nodes.filter(nodeStatsMissing);
  if (stillEmpty.length > 0) {
    warnings.push(
      `Node stats empty for ${stillEmpty.map((n) => n.node).join(", ")}. Grant the API token Sys.Audit on /nodes (or each node).`,
    );
  }

  let guests = overview.guests;
  const discovered = await discoverGuests(config, nodes);
  guests = mergeGuests(guests, discovered.guests);
  // Only surface guest-list errors when we found no guests at all.
  if (guests.length === 0 && discovered.errors.length > 0) {
    warnings.push(
      "No VMs/LXCs visible. Grant VM.Audit (and VM.PowerMgmt for power actions) on /vms or each guest.",
    );
    warnings.push(...discovered.errors.slice(0, 3));
  }

  return {
    mode: "live",
    nodes,
    guests,
    summary: summarize(nodes, guests),
    warnings: warnings.length ? warnings : undefined,
  };
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
  const config = await getProxmoxConfig();
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
