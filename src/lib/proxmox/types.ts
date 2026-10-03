export type GuestType = "qemu" | "lxc";

export type PowerAction =
  | "start"
  | "stop"
  | "shutdown"
  | "reboot"
  | "reset";

export type ClusterResourceType =
  | "node"
  | "qemu"
  | "lxc"
  | "storage"
  | "sdn";

export interface ClusterResource {
  id: string;
  type: ClusterResourceType;
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  maxcpu?: number;
  cpu?: number;
  maxmem?: number;
  mem?: number;
  maxdisk?: number;
  disk?: number;
  uptime?: number;
  template?: number;
}

export interface NodeStatus {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
  loadavg?: [string, string, string];
}

export interface GuestStatus {
  vmid: number;
  name: string;
  type: GuestType;
  node: string;
  status: string;
  cpu: number;
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
}

export interface ClusterOverview {
  mode: "live" | "mock";
  nodes: NodeStatus[];
  guests: GuestStatus[];
  summary: {
    nodeCount: number;
    onlineNodes: number;
    vmCount: number;
    lxcCount: number;
    runningGuests: number;
    stoppedGuests: number;
  };
}

export interface PowerResult {
  ok: boolean;
  message: string;
  guest?: GuestStatus;
}
