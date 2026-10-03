"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ClusterOverview, GuestStatus, PowerAction } from "@/lib/proxmox/types";
import { ServersSetup } from "@/components/servers-setup";
import {
  Activity,
  Box,
  Cpu,
  HardDrive,
  Mic,
  RefreshCw,
  Server,
} from "lucide-react";

interface ClusterResponse {
  configured: boolean;
  mock: boolean;
  host: string | null;
  source?: "server" | "env" | "mock";
  serverName?: string | null;
  overview: ClusterOverview;
  error?: string;
}

function formatBytesShort(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`;
}

function pct(ratio: number): number {
  return Math.round(Math.max(0, ratio) * 100);
}

function Meter({ label, value }: { label: string; value: number }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-foreground">{clamped}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-[var(--accent-glow)] transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

const SIMULATIONS = [
  { label: "Cluster status", intent: "ClusterStatusIntent" },
  { label: "Node stats", intent: "NodeStatsIntent", slots: {} },
  {
    label: "Docker host stats",
    intent: "GuestStatsIntent",
    slots: { guestName: "docker host" },
  },
  {
    label: "Start pihole",
    intent: "StartGuestIntent",
    slots: { guestName: "pihole" },
  },
  {
    label: "Reboot docker host",
    intent: "RebootGuestIntent",
    slots: { guestName: "docker host" },
  },
  { label: "Performance", intent: "PerformanceIntent" },
] as const;

export function Dashboard() {
  const [data, setData] = useState<ClusterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [speech, setSpeech] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [customUtterance, setCustomUtterance] = useState("cluster status");
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cluster", { cache: "no-store" });
      const json = (await res.json()) as ClusterResponse & { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load cluster");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cluster");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const overview = data?.overview;

  const guestsByType = useMemo(() => {
    const vms = overview?.guests.filter((g) => g.type === "qemu") ?? [];
    const lxcs = overview?.guests.filter((g) => g.type === "lxc") ?? [];
    return { vms, lxcs };
  }, [overview]);

  async function runPower(guest: GuestStatus, action: PowerAction) {
    startTransition(async () => {
      setError(null);
      const res = await fetch("/api/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vmid: guest.vmid,
          type: guest.type,
          action,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Power action failed");
        return;
      }
      await load();
    });
  }

  async function simulate(intent: string, slots?: Record<string, string>) {
    setSimulating(true);
    setSpeech(null);
    try {
      const res = await fetch("/api/alexa/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, slots }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Simulation failed");
      setSpeech(json.speech ?? "No speech returned.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setSimulating(false);
    }
  }

  async function simulateFromUtterance() {
    const text = customUtterance.trim().toLowerCase();
    if (!text) return;

    if (text.includes("performance") || text.includes("cpu usage")) {
      const match = text.match(/(?:for|of)\s+(.+)$/);
      await simulate("PerformanceIntent", match?.[1] ? { target: match[1] } : undefined);
      return;
    }
    if (text.includes("cluster") || text.includes("overview") || text.includes("what's running")) {
      await simulate("ClusterStatusIntent");
      return;
    }
    if (text.includes("list") || text.startsWith("what ")) {
      const guestType = text.includes("container") || text.includes("lxc")
        ? "container"
        : text.includes("virtual") || text.includes("vm")
          ? "virtual machine"
          : undefined;
      await simulate("ListGuestsIntent", guestType ? { guestType } : undefined);
      return;
    }
    if (text.includes("node")) {
      const match = text.match(/node\s+(.+)$/);
      await simulate("NodeStatsIntent", match?.[1] ? { nodeName: match[1] } : undefined);
      return;
    }

    const powerMatch = text.match(
      /\b(start|stop|shutdown|shut down|reboot|restart|reset)\b\s+(?:the\s+)?(.+)/i,
    );
    if (powerMatch) {
      const action = powerMatch[1]
        .toLowerCase()
        .replace("shut down", "shutdown")
        .replace("restart", "reboot");
      const intent =
        action === "start"
          ? "StartGuestIntent"
          : action === "stop"
            ? "StopGuestIntent"
            : action === "shutdown"
              ? "ShutdownGuestIntent"
              : action === "reboot"
                ? "RebootGuestIntent"
                : "ResetGuestIntent";
      await simulate(intent, { guestName: powerMatch[2] });
      return;
    }

    const statsMatch = text.match(/(?:stats|status|how is)\s+(?:for\s+)?(.+)/i);
    if (statsMatch) {
      await simulate("GuestStatsIntent", { guestName: statsMatch[1] });
      return;
    }

    await simulate("ClusterStatusIntent");
  }

  return (
    <div className="relative min-h-full">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 top-0 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(45,212,191,0.18),transparent_70%)] blur-2xl" />
        <div className="absolute right-0 top-40 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.12),transparent_70%)] blur-2xl" />
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-[var(--accent-glow)]">
              Homelab control
            </p>
            <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-foreground sm:text-5xl">
              Voxmox
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Voice-control your Proxmox cluster from Alexa — nodes, VMs, LXCs,
              power actions, and performance stats. This dashboard mirrors the
              same backend the skill uses.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {data?.mock ? (
              <Badge variant="secondary" className="font-mono">
                Demo mode
              </Badge>
            ) : (
              <Badge className="bg-[var(--accent-glow)] text-slate-950 hover:bg-[var(--accent-glow)]">
                Live Proxmox
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading || pending}
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "Nodes online",
              value: overview
                ? `${overview.summary.onlineNodes}/${overview.summary.nodeCount}`
                : "—",
              icon: Server,
            },
            {
              label: "Virtual machines",
              value: overview?.summary.vmCount ?? "—",
              icon: HardDrive,
            },
            {
              label: "Containers",
              value: overview?.summary.lxcCount ?? "—",
              icon: Box,
            },
            {
              label: "Guests running",
              value: overview?.summary.runningGuests ?? "—",
              icon: Activity,
            },
          ].map((stat, index) => (
            <Card
              key={stat.label}
              className="border-border/60 bg-card/70 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2"
              style={{ animationDelay: `${index * 60}ms`, animationFillMode: "both" }}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>{stat.label}</CardDescription>
                <stat.icon className="size-4 text-[var(--accent-glow)]" />
              </CardHeader>
              <CardContent>
                <p className="font-mono text-3xl font-semibold tracking-tight">
                  {loading && !overview ? "…" : stat.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </section>

        <Tabs defaultValue="cluster" className="gap-4">
          <TabsList className="bg-secondary/70">
            <TabsTrigger value="cluster">Cluster</TabsTrigger>
            <TabsTrigger value="alexa">Alexa simulator</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
          </TabsList>

          <TabsContent value="cluster" className="space-y-6">
            <section className="space-y-3">
              <h2 className="font-[family-name:var(--font-display)] text-xl">Nodes</h2>
              <div className="grid gap-4 md:grid-cols-2">
                {overview?.nodes.map((node) => (
                  <Card key={node.node} className="border-border/60 bg-card/70 backdrop-blur-sm">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <CardTitle className="font-mono text-lg">{node.node}</CardTitle>
                        <Badge
                          variant={node.status === "online" ? "default" : "secondary"}
                          className={
                            node.status === "online"
                              ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20"
                              : undefined
                          }
                        >
                          {node.status}
                        </Badge>
                      </div>
                      <CardDescription>
                        {node.maxcpu} cores · {formatBytesShort(node.maxmem)} RAM
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Meter label="CPU" value={pct(node.cpu)} />
                      <Meter
                        label="Memory"
                        value={pct(node.mem / Math.max(node.maxmem, 1))}
                      />
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Cpu className="size-3.5" />
                        <span className="font-mono">
                          uptime {Math.floor(node.uptime / 86400)}d{" "}
                          {Math.floor((node.uptime % 86400) / 3600)}h
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {!loading && overview?.nodes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No nodes found.</p>
                ) : null}
              </div>
            </section>

            <Separator className="bg-border/60" />

            <section className="space-y-3">
              <h2 className="font-[family-name:var(--font-display)] text-xl">
                Virtual machines
              </h2>
              <GuestTable
                guests={guestsByType.vms}
                pending={pending}
                onPower={runPower}
              />
            </section>

            <section className="space-y-3">
              <h2 className="font-[family-name:var(--font-display)] text-xl">
                LXC containers
              </h2>
              <GuestTable
                guests={guestsByType.lxcs}
                pending={pending}
                onPower={runPower}
              />
            </section>
          </TabsContent>

          <TabsContent value="alexa" className="space-y-4">
            <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mic className="size-5 text-[var(--accent-glow)]" />
                  Try skill utterances
                </CardTitle>
                <CardDescription>
                  Simulates Alexa intents against the same handler your skill
                  endpoint uses. Power actions update the live/demo cluster.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={customUtterance}
                    onChange={(e) => setCustomUtterance(e.target.value)}
                    placeholder="start docker host"
                    className="font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void simulateFromUtterance();
                    }}
                  />
                  <Button
                    onClick={() => void simulateFromUtterance()}
                    disabled={simulating}
                  >
                    Speak
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SIMULATIONS.map((item) => (
                    <Button
                      key={item.label}
                      variant="secondary"
                      size="sm"
                      disabled={simulating}
                      onClick={() =>
                        void simulate(
                          item.intent,
                          "slots" in item ? { ...item.slots } : undefined,
                        )
                      }
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                {speech ? (
                  <div className="rounded-xl border border-[var(--accent-glow)]/30 bg-[var(--accent-glow)]/10 px-4 py-3 text-sm leading-relaxed text-foreground animate-in fade-in zoom-in-95">
                    <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--accent-glow)]">
                      Alexa says
                    </p>
                    {speech}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="setup" className="space-y-4">
            <ServersSetup
              activeHost={data?.host ?? null}
              mock={data?.mock ?? true}
              source={data?.source ?? null}
              serverName={data?.serverName ?? null}
              onServersChanged={() => void load()}
            />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function GuestTable({
  guests,
  pending,
  onPower,
}: {
  guests: GuestStatus[];
  pending: boolean;
  onPower: (guest: GuestStatus, action: PowerAction) => void;
}) {
  if (guests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No guests in this category.</p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/70 backdrop-blur-sm">
      <div className="divide-y divide-border/50">
        {guests.map((guest) => (
          <div
            key={`${guest.type}-${guest.vmid}`}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium">{guest.name}</p>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {guest.vmid}
                </Badge>
                <Badge
                  variant="secondary"
                  className={
                    guest.status === "running"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : undefined
                  }
                >
                  {guest.status}
                </Badge>
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                {guest.node} · CPU {pct(guest.cpu)}% · RAM{" "}
                {formatBytesShort(guest.mem)}/{formatBytesShort(guest.maxmem)}
              </p>
              {guest.status === "running" ? (
                <div className="grid max-w-md grid-cols-2 gap-3 pt-1">
                  <Meter label="CPU" value={pct(guest.cpu)} />
                  <Meter
                    label="Memory"
                    value={pct(guest.mem / Math.max(guest.maxmem, 1))}
                  />
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["start", "Start"],
                  ["shutdown", "Shutdown"],
                  ["stop", "Stop"],
                  ["reboot", "Reboot"],
                  ["reset", "Reset"],
                ] as const
              ).map(([action, label]) => (
                <Button
                  key={action}
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onPower(guest, action)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
