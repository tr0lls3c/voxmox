export interface ProxmoxServer {
  id: string;
  name: string;
  /** Base URL, e.g. https://192.168.1.10:8006 */
  host: string;
  tokenId: string;
  tokenSecret: string;
  /**
   * Optional password for the token’s user (the part before `!`).
   * Used to auto-grant token ACLs when privilege separation blocks Sys.Audit.
   */
  authPassword?: string;
  allowSelfSigned: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServersConfig {
  activeServerId: string | null;
  servers: ProxmoxServer[];
}

export interface ProxmoxServerPublic {
  id: string;
  name: string;
  host: string;
  tokenId: string;
  /** True when a token secret is stored (value is never returned). */
  hasTokenSecret: boolean;
  /** True when a user password is stored for ACL repair (value is never returned). */
  hasAuthPassword: boolean;
  allowSelfSigned: boolean;
  enabled: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerInput {
  name: string;
  host: string;
  tokenId: string;
  tokenSecret?: string;
  /** Pass empty string to clear a stored password. */
  authPassword?: string;
  allowSelfSigned?: boolean;
  enabled?: boolean;
  setActive?: boolean;
}
