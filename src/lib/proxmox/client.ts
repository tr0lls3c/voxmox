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
