import type {
  ClusterOverview,
  ClusterResource,
  GuestStatus,
  GuestType,
  NodeStatus,
  PowerAction,
  PowerResult,
} from "./types";

const MOCK_RESOURCES: ClusterResource[] = [
  {
    id: "node/pve1",
    type: "node",
    node: "pve1",
    status: "online",
    cpu: 0.18,
    maxcpu: 16,
    mem: 28_000_000_000,
    maxmem: 64_000_000_000,
    uptime: 1_209_600,
  },
  {
    id: "node/pve2",
    type: "node",
    node: "pve2",
    status: "online",
    cpu: 0.42,
    maxcpu: 12,
    mem: 40_000_000_000,
    maxmem: 96_000_000_000,
    uptime: 864_000,
  },
  {
    id: "qemu/100",
    type: "qemu",
    node: "pve1",
    vmid: 100,
    name: "home-assistant",
    status: "running",
    cpu: 0.08,
    maxcpu: 2,
    mem: 2_100_000_000,
    maxmem: 4_000_000_000,
    disk: 12_000_000_000,
    maxdisk: 32_000_000_000,
    uptime: 345_600,
  },
  {
    id: "qemu/101",
    type: "qemu",
    node: "pve1",
    vmid: 101,
    name: "docker-host",
    status: "running",
    cpu: 0.35,
    maxcpu: 8,
    mem: 14_000_000_000,
    maxmem: 32_000_000_000,
    disk: 80_000_000_000,
    maxdisk: 200_000_000_000,
    uptime: 604_800,
  },
  {
    id: "qemu/110",
    type: "qemu",
    node: "pve2",
    vmid: 110,
    name: "windows-lab",
    status: "stopped",
    cpu: 0,
    maxcpu: 4,
    mem: 0,
    maxmem: 16_000_000_000,
    disk: 45_000_000_000,
    maxdisk: 120_000_000_000,
    uptime: 0,
  },
  {
    id: "lxc/200",
    type: "lxc",
    node: "pve1",
    vmid: 200,
    name: "pihole",
    status: "running",
    cpu: 0.02,
    maxcpu: 1,
    mem: 180_000_000,
    maxmem: 512_000_000,
    disk: 1_200_000_000,
    maxdisk: 8_000_000_000,
    uptime: 1_209_600,
  },
  {
    id: "lxc/201",
    type: "lxc",
    node: "pve2",
    vmid: 201,
    name: "nginx-proxy",
    status: "running",
    cpu: 0.05,
    maxcpu: 2,
    mem: 420_000_000,
    maxmem: 1_000_000_000,
    disk: 2_500_000_000,
    maxdisk: 16_000_000_000,
    uptime: 432_000,
  },
  {
    id: "lxc/210",
    type: "lxc",
    node: "pve2",
    vmid: 210,
    name: "backup-runner",
    status: "stopped",
    cpu: 0,
    maxcpu: 2,
    mem: 0,
    maxmem: 2_000_000_000,
    disk: 5_000_000_000,
    maxdisk: 40_000_000_000,
    uptime: 0,
  },
];

function cloneResources(): ClusterResource[] {
  return structuredClone(MOCK_RESOURCES);
}

let state = cloneResources();

function resourceToGuest(resource: ClusterResource): GuestStatus | null {
  if (resource.type !== "qemu" && resource.type !== "lxc") return null;
  if (resource.vmid == null || !resource.node || !resource.name) return null;

  return {
    vmid: resource.vmid,
    name: resource.name,
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
    loadavg: ["0.40", "0.55", "0.62"],
  };
}

export function resetMockCluster(): void {
  state = cloneResources();
}

export function getMockOverview(): ClusterOverview {
  const nodes = state
    .map(resourceToNode)
    .filter((n): n is NodeStatus => n !== null);
  const guests = state
    .map(resourceToGuest)
    .filter((g): g is GuestStatus => g !== null);

  return {
    mode: "mock",
    nodes,
    guests,
    summary: {
      nodeCount: nodes.length,
      onlineNodes: nodes.filter((n) => n.status === "online").length,
      vmCount: guests.filter((g) => g.type === "qemu").length,
      lxcCount: guests.filter((g) => g.type === "lxc").length,
      runningGuests: guests.filter((g) => g.status === "running").length,
      stoppedGuests: guests.filter((g) => g.status === "stopped").length,
    },
  };
}

export function getMockResources(): ClusterResource[] {
  return structuredClone(state);
}

export function mockPowerAction(
  vmid: number,
  type: GuestType,
  action: PowerAction,
): PowerResult {
  const guest = state.find(
    (r) => r.vmid === vmid && r.type === type,
  );

  if (!guest) {
    return { ok: false, message: `Could not find ${type} ${vmid}.` };
  }

  const name = guest.name ?? `${type} ${vmid}`;

  switch (action) {
    case "start":
      if (guest.status === "running") {
        return {
          ok: true,
          message: `${name} is already running.`,
          guest: resourceToGuest(guest) ?? undefined,
        };
      }
      guest.status = "running";
      guest.uptime = 5;
      guest.cpu = 0.05;
      guest.mem = Math.floor((guest.maxmem ?? 0) * 0.25);
      break;
    case "stop":
    case "shutdown":
      if (guest.status === "stopped") {
        return {
          ok: true,
          message: `${name} is already stopped.`,
          guest: resourceToGuest(guest) ?? undefined,
        };
      }
      guest.status = "stopped";
      guest.uptime = 0;
      guest.cpu = 0;
      guest.mem = 0;
      break;
    case "reboot":
    case "reset":
      if (guest.status !== "running") {
        return {
          ok: false,
          message: `${name} is not running, so it cannot be ${action === "reboot" ? "rebooted" : "reset"}.`,
          guest: resourceToGuest(guest) ?? undefined,
        };
      }
      guest.uptime = 3;
      guest.cpu = 0.12;
      break;
  }

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
    guest: resourceToGuest(guest) ?? undefined,
  };
}
