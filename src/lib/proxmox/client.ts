import { resolveProxmoxConfig } from "@/lib/servers/resolve";
import {
  buildTokenAuthorization,
  createTicket,
  grantTokenDashboardAccess,
  isPermissionDenied,
  normalizeTokenCredentials,
  pveumRepairHint,
  userIdFromTokenId,
  type TicketSession,
} from "./auth";
import {
  getCachedOverview,
  invalidateOverviewCache,
  overviewCacheKey,
} from "./overview-cache";
import {
  getMockOverview,
  getMockResources,
  mockPowerAction,
} from "./mock";
import { proxmoxTlsFetch } from "./tls-fetch";
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
  /** Backing user password — used to repair token ACLs / ticket fallback. */
  authPassword?: string;
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

type FetchAuth =
  | { kind: "token" }
  | { kind: "ticket"; session: TicketSession };

export async function getProxmoxConfig(
  serverId?: string | null,
): Promise<ResolvedProxmoxConfig> {
  return resolveProxmoxConfig(serverId);
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

function credentialsOf(config: ProxmoxConfig): {
  tokenId: string;
  tokenSecret: string;
  authorization: string;
} {
  const { tokenId, tokenSecret } = normalizeTokenCredentials(
    config.tokenId,
    config.tokenSecret,
  );
  return {
    tokenId,
    tokenSecret,
    authorization: buildTokenAuthorization(tokenId, tokenSecret),
  };
}

async function proxmoxFetch<T>(
  config: ProxmoxConfig,
  path: string,
  init?: RequestInit,
  auth: FetchAuth = { kind: "token" },
): Promise<T> {
  if (!config.host) {
    throw new ProxmoxApiError("PROXMOX_HOST is not configured.");
  }

  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${proxmoxApiBase(config.host)}${apiPath}`;
  const headers = new Headers(init?.headers);

  if (auth.kind === "ticket") {
    headers.set("Cookie", `PVEAuthCookie=${auth.session.ticket}`);
    if (init?.method && init.method.toUpperCase() !== "GET") {
      headers.set("CSRFPreventionToken", auth.session.csrf);
    }
  } else {
    const { authorization } = credentialsOf(config);
    headers.set("Authorization", authorization);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PROXMOX_FETCH_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  init?.signal?.addEventListener("abort", onAbort);

  try {
    const response = await proxmoxTlsFetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      rejectUnauthorized: config.rejectUnauthorized,
    });

    // Auth headers are dropped on cross-origin redirects; fail loudly instead.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(unknown)";
      throw new ProxmoxApiError(
        `Proxmox API redirected (${response.status}) to ${location}. Use the final https://host:8006 URL with no path.`,
        response.status,
      );
    }

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

/**
 * If node status is denied, use the user password (when available) to grant the
 * token dashboard ACL roles on `/`, then verify. Falls back to ticket auth for
 * the remainder of the request when ACL repair is not enough.
 */
export async function ensureNodeAccess(config: ProxmoxConfig): Promise<{
  auth: FetchAuth;
  repaired: boolean;
  message?: string;
}> {
  const { tokenId } = credentialsOf(config);
  const apiBase = proxmoxApiBase(config.host);

  const probe = async (auth: FetchAuth) => {
    const nodes = await proxmoxFetch<NodeIndexItem[]>(
      config,
      "/nodes",
      undefined,
      auth,
    );
    const first = nodes.find((n) => Boolean(n.node));
    if (!first) return;
    await proxmoxFetch<NodeStatusApi>(
      config,
      `/nodes/${encodeURIComponent(first.node)}/status`,
      undefined,
      auth,
    );
  };

  try {
    await probe({ kind: "token" });
    return { auth: { kind: "token" }, repaired: false };
  } catch (tokenError) {
    if (!isPermissionDenied(tokenError)) {
      throw tokenError;
    }
  }

  const password = config.authPassword?.trim();
  if (!password) {
    return {
      auth: { kind: "token" },
      repaired: false,
      message:
        `Token ${tokenId} is authenticated but Proxmox denied Sys.Audit on /nodes. ` +
        `Add the Proxmox user password in Setup and click “Repair token access”, or ` +
        pveumRepairHint(tokenId),
    };
  }

  let session: TicketSession;
  try {
    session = await createTicket({
      host: config.host,
      username: userIdFromTokenId(tokenId),
      password,
      rejectUnauthorized: config.rejectUnauthorized,
      apiBase,
    });
  } catch (loginError) {
    return {
      auth: { kind: "token" },
      repaired: false,
      message:
        `Token lacks Sys.Audit, and user login failed: ` +
        `${loginError instanceof Error ? loginError.message : String(loginError)}. ` +
        pveumRepairHint(tokenId),
    };
  }

  let grantedRoles = "PVEAuditor,PVEVMAdmin";
  try {
    const grant = await grantTokenDashboardAccess({
      apiBase,
      rejectUnauthorized: config.rejectUnauthorized,
      tokenId,
      auth: { kind: "ticket", session },
    });
    grantedRoles = grant.roles;
  } catch (aclError) {
    // Ticket still works for reads even if ACL write failed.
    try {
      await probe({ kind: "ticket", session });
      return {
        auth: { kind: "ticket", session },
        repaired: false,
        message:
          `Using password session for API calls (could not write token ACL: ` +
          `${aclError instanceof Error ? aclError.message : String(aclError)}).`,
      };
    } catch {
      return {
        auth: { kind: "token" },
        repaired: false,
        message:
          `Could not repair token ACL: ` +
          `${aclError instanceof Error ? aclError.message : String(aclError)}. ` +
          pveumRepairHint(tokenId),
      };
    }
  }

  // Brief pause so pveproxy reloads ACL.
  await new Promise((r) => setTimeout(r, 400));

  try {
    await probe({ kind: "token" });
    return {
      auth: { kind: "token" },
      repaired: true,
      message: `Granted ${grantedRoles} on / to token ${tokenId} (and user). Node stats should work now.`,
    };
  } catch {
    // ACL write succeeded but token still blocked — use ticket for this run.
    try {
      await probe({ kind: "ticket", session });
      return {
        auth: { kind: "ticket", session },
        repaired: true,
        message:
          `Repaired ACL for ${tokenId}; using password session this request because token probe still failed.`,
      };
    } catch (ticketError) {
      return {
        auth: { kind: "token" },
        repaired: false,
        message:
          `Repair attempted but access still denied: ` +
          `${ticketError instanceof Error ? ticketError.message : String(ticketError)}. ` +
          pveumRepairHint(tokenId),
      };
    }
  }
}

/** Explicit repair entry-point used by Setup “Repair token access”. */
export async function repairProxmoxTokenAccess(input: {
  host: string;
  tokenId: string;
  tokenSecret: string;
  authPassword: string;
  allowSelfSigned?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const rejectUnauthorized = input.allowSelfSigned === false;
  const { tokenId, tokenSecret } = normalizeTokenCredentials(
    input.tokenId,
    input.tokenSecret,
  );
  const config: ProxmoxConfig = {
    host: normalizeProxmoxHost(input.host),
    tokenId,
    tokenSecret,
    authPassword: input.authPassword.trim(),
    rejectUnauthorized,
    mock: false,
  };

  const result = await ensureNodeAccess(config);
  if (result.repaired || result.auth.kind === "ticket") {
    return {
      ok: true,
      message: result.message ?? "Token access repaired.",
    };
  }
  return {
    ok: false,
    message: result.message ?? "Could not repair token access.",
  };
}

export async function testProxmoxConnection(input: {
  host: string;
  tokenId: string;
  tokenSecret: string;
  authPassword?: string;
  allowSelfSigned?: boolean;
  /** When true (default if password provided), attempt ACL repair on Sys.Audit 403. */
  repair?: boolean;
}): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
  warning?: string;
  repaired?: boolean;
  apiBase?: string;
}> {
  const rejectUnauthorized = input.allowSelfSigned === false;

  const { tokenId, tokenSecret } = normalizeTokenCredentials(
    input.tokenId,
    input.tokenSecret,
  );
  const config: ProxmoxConfig = {
    host: normalizeProxmoxHost(input.host),
    tokenId,
    tokenSecret,
    authPassword: input.authPassword?.trim() || undefined,
    rejectUnauthorized,
    mock: false,
  };
  const apiBase = proxmoxApiBase(config.host);

  try {
    const version = await proxmoxFetch<{ version?: string; release?: string }>(
      config,
      "/version",
    );
    const label = [version.version, version.release].filter(Boolean).join(" ");

    const access =
      input.repair === false
        ? await ensureNodeAccess({ ...config, authPassword: undefined })
        : await ensureNodeAccess(config);

    return {
      ok: true,
      version: label || "connected",
      apiBase,
      repaired: access.repaired,
      warning: access.message,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connection test failed";
    return {
      ok: false,
      apiBase,
      error: isPermissionDenied(error)
        ? `${message} — ${pveumRepairHint(tokenId)}`
        : message,
    };
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
  auth: FetchAuth,
): Promise<{ nodes: NodeStatus[]; error?: string }> {
  try {
    const items = await proxmoxFetch<NodeIndexItem[]>(
      config,
      "/nodes",
      undefined,
      auth,
    );
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
  auth: FetchAuth,
): Promise<{ node: NodeStatus; error?: string }> {
  if (!nodeStatsMissing(node)) return { node };

  try {
    const status = await proxmoxFetch<NodeStatusApi>(
      config,
      `/nodes/${encodeURIComponent(node.node)}/status`,
      undefined,
      auth,
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
  auth: FetchAuth,
): Promise<{ guests: GuestStatus[]; error?: string }> {
  try {
    const items = await proxmoxFetch<NodeGuestListItem[]>(
      config,
      `/nodes/${encodeURIComponent(node)}/${type}`,
      undefined,
      auth,
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
  auth: FetchAuth,
): Promise<{ guests: GuestStatus[]; errors: string[] }> {
  const results = await Promise.all(
    nodes.flatMap((node) => [
      listGuestsOnNode(config, node.node, "qemu", auth),
      listGuestsOnNode(config, node.node, "lxc", auth),
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

async function listResourcesWithAuth(
  config: ProxmoxConfig,
  auth: FetchAuth,
): Promise<ClusterResource[]> {
  // One /cluster/resources call is enough; typed variants were redundant fan-out.
  const all = await proxmoxFetch<ClusterResource[]>(
    config,
    "/cluster/resources",
    undefined,
    auth,
  );

  const byId = new Map<string, ClusterResource>();
  for (const resource of all) {
    if (!resource?.id) continue;
    byId.set(resource.id, { ...byId.get(resource.id), ...resource });
  }
  return [...byId.values()];
}

export async function listResources(
  serverId?: string | null,
): Promise<ClusterResource[]> {
  const config = await getProxmoxConfig(serverId);
  if (config.mock) return getMockResources();

  const access = await ensureNodeAccess(config);
  return listResourcesWithAuth(config, access.auth);
}

async function loadClusterOverviewUncached(
  serverId?: string | null,
): Promise<ClusterOverview> {
  const config = await getProxmoxConfig(serverId);
  if (config.mock) return getMockOverview();

  const warnings: string[] = [];
  const access = await ensureNodeAccess(config);
  if (access.message) warnings.push(access.message);

  const resources = await listResourcesWithAuth(config, access.auth);
  let overview = buildOverview(resources, "live");

  const indexed = await listNodesIndex(config, access.auth);
  if (indexed.error) {
    warnings.push(indexed.error);
  }
  let nodes = mergeNodeLists(overview.nodes, indexed.nodes);

  const enriched = await Promise.all(
    nodes.map((node) => enrichNodeFromStatus(config, node, access.auth)),
  );
  nodes = enriched.map((item) => item.node);
  for (const item of enriched) {
    if (item.error) warnings.push(item.error);
  }

  const stillEmpty = nodes.filter(nodeStatsMissing);
  const auditDenied = enriched.some(
    (item) =>
      item.error?.includes("Sys.Audit") || item.error?.includes(" 403 "),
  );
  if (stillEmpty.length > 0 && auditDenied) {
    const { tokenId } = credentialsOf(config);
    warnings.push(
      `Still no node stats for ${stillEmpty.map((n) => n.node).join(", ")}. ` +
        (config.authPassword
          ? "Password was tried for ACL repair — check that it belongs to the token’s user."
          : `Save the Proxmox user password in Setup and click “Repair token access”. ${pveumRepairHint(tokenId)}`),
    );
  } else if (stillEmpty.length > 0) {
    warnings.push(
      `Node stats empty for ${stillEmpty.map((n) => n.node).join(", ")}.`,
    );
  }

  let guests = overview.guests;
  const discovered = await discoverGuests(config, nodes, access.auth);
  guests = mergeGuests(guests, discovered.guests);
  if (guests.length === 0 && discovered.errors.length > 0) {
    warnings.push(
      "No VMs/LXCs visible. After token repair, guests should appear — or grant VM.Audit on /vms.",
    );
    warnings.push(discovered.errors[0]);
  }

  const filteredWarnings = auditDenied
    ? warnings.filter(
        (w) =>
          !w.includes("/status:") &&
          !w.includes("Failed to list /nodes") &&
          !/^[^:]+: Proxmox API 403/.test(w),
      )
    : warnings;

  // Dedupe while preserving order.
  const seen = new Set<string>();
  const unique = filteredWarnings.filter((w) => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  return {
    mode: "live",
    nodes,
    guests,
    summary: summarize(nodes, guests),
    warnings: unique.length ? unique : undefined,
  };
}

export async function getClusterOverview(
  serverId?: string | null,
  options?: { force?: boolean },
): Promise<ClusterOverview> {
  const key = overviewCacheKey(serverId);
  const result = await getCachedOverview(
    key,
    () => loadClusterOverviewUncached(serverId),
    { force: options?.force },
  );
  return result.value;
}

/** Same as getClusterOverview but includes cache metadata for the HTTP API. */
export async function getClusterOverviewWithMeta(
  serverId?: string | null,
  options?: { force?: boolean },
): Promise<{
  overview: ClusterOverview;
  cached: boolean;
  fetchedAt: number;
  ageMs: number;
}> {
  const key = overviewCacheKey(serverId);
  const result = await getCachedOverview(
    key,
    () => loadClusterOverviewUncached(serverId),
    { force: options?.force },
  );
  return {
    overview: result.value,
    cached: result.cached,
    fetchedAt: result.fetchedAt,
    ageMs: result.ageMs,
  };
}

export { invalidateOverviewCache };

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

  const access = await ensureNodeAccess(config);
  const path = `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`;
  await proxmoxFetch(config, path, { method: "POST" }, access.auth);
  invalidateOverviewCache();

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
