"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
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
  Lock,
  Mic,
  RefreshCw,
  Server,
} from "lucide-react";

interface ClusterResponse {
  configured: boolean;
  mock: boolean;
  host: string | null;
  apiBase?: string | null;
  source?: "server" | "env" | "mock";
  serverName?: string | null;
  overview: ClusterOverview;
  cache?: {
    hit: boolean;
    fetchedAt: number;
    ageMs: number;
    ttlMs: number;
  };
  error?: string;
}

interface AuthStatus {
  required: boolean;
  configured: boolean;
  authenticated: boolean;
  insecureProduction?: boolean;
}

const POLL_MS = 5_000;

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

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

export function Dashboard() {
  const [data, setData] = useState<ClusterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [speech, setSpeech] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [customUtterance, setCustomUtterance] = useState("cluster status");
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState("cluster");
  const [live, setLive] = useState(true);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [unlockSecret, setUnlockSecret] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refreshAuth = useCallback(async () => {
    const res = await fetch("/api/auth", { cache: "no-store" });
    const json = (await res.json()) as AuthStatus;
    setAuth(json);
    return json;
  }, []);

  const load = useCallback(
    async (opts?: { fresh?: boolean; soft?: boolean }) => {
      if (!opts?.soft) setLoading(true);
      setError(null);
      try {
        const qs = opts?.fresh ? "?fresh=1" : "";
        const res = await fetch(`/api/cluster${qs}`, { cache: "no-store" });
        const json = (await res.json()) as ClusterResponse & {
          error?: string;
          code?: string;
        };
        if (res.status === 401) {
          setAuth((prev) =>
            prev
              ? { ...prev, authenticated: false, required: true }
              : {
                  required: true,
                  configured: json.code !== "DASHBOARD_SECRET_MISSING",
                  authenticated: false,
                },
          );
          throw new Error(json.error || "Unauthorized");
        }
        if (!res.ok) throw new Error(json.error || "Failed to load cluster");
        setData(json);
        setLastUpdated(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load cluster");
      } finally {
        if (!opts?.soft) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        await refreshAuth();
      } catch {
        // ignore
      }
      await load();
    })();
  }, [load, refreshAuth]);

  // Live soft-poll while Cluster tab is visible — server cache collapses Proxmox load.
  useEffect(() => {
    if (!live || tab !== "cluster") return;
    if (auth?.required && !auth.authenticated) return;

    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      void load({ soft: true });
    };

    const id = window.setInterval(tick, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [live, tab, load, auth]);

  const overview = data?.overview;

  const guestsByType = useMemo(() => {
    const vms = overview?.guests.filter((g) => g.type === "qemu") ?? [];
    const lxcs = overview?.guests.filter((g) => g.type === "lxc") ?? [];
    return { vms, lxcs };
  }, [overview]);

  async function unlock() {
    setUnlocking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: unlockSecret }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Unlock failed");
      setUnlockSecret("");
      await refreshAuth();
      await load({ fresh: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlock failed");
    } finally {
      setUnlocking(false);
    }
  }

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
      await load({ fresh: true, soft: true });
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
      await load({ soft: true });
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

  const needsUnlock = Boolean(auth?.required && !auth.authenticated);

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
            {live && tab === "cluster" && !needsUnlock ? (
              <Badge variant="secondary" className="font-mono text-[10px]">
                live · {POLL_MS / 1000}s
                {data?.cache?.hit ? " · cached" : ""}
              </Badge>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLive((v) => !v)}
              disabled={needsUnlock}
            >
              {live ? "Pause live" : "Resume live"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load({ fresh: true })}
              disabled={loading || pending || needsUnlock}
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </header>

        {needsUnlock ? (
          <Card className="border-[var(--accent-glow)]/40 bg-card/80 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="size-4 text-[var(--accent-glow)]" />
                Unlock dashboard
              </CardTitle>
              <CardDescription>
                {auth?.configured
                  ? "Enter VOXMOX_DASHBOARD_SECRET to access control-plane APIs."
                  : "Production mode requires VOXMOX_DASHBOARD_SECRET in .env (or set VOXMOX_ALLOW_ANONYMOUS=1 on a trusted LAN)."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row">
              <Input
                type="password"
                value={unlockSecret}
                onChange={(e) => setUnlockSecret(e.target.value)}
                placeholder="Dashboard secret"
                className="font-mono sm:max-w-sm"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void unlock();
                }}
              />
              <Button
                onClick={() => void unlock()}
                disabled={unlocking || !unlockSecret.trim() || !auth?.configured}
              >
                {unlocking ? "Unlocking…" : "Unlock"}
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {auth?.insecureProduction ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
            Production mode has no{" "}
            <code className="font-mono">VOXMOX_DASHBOARD_SECRET</code>. Set one
            (LXC <code className="font-mono">update</code> auto-generates it) so
            the control plane is not open on the network.
          </div>
        ) : null}

        {overview?.warnings?.length ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
            <p className="mb-1 font-medium text-amber-200">Proxmox API warnings</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {overview.warnings.map((warning) => (
                <li key={warning} className="whitespace-pre-wrap break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Tabs value={tab} onValueChange={setTab} className="gap-6">
          <TabsList>
            <TabsTrigger value="cluster">Cluster</TabsTrigger>
            <TabsTrigger value="alexa">Alexa simulator</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
          </TabsList>

          <TabsContent value="cluster" className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                  icon: Cpu,
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
              ].map((stat) => (
                <Card
                  key={stat.label}
                  className="border-border/60 bg-card/70 backdrop-blur-sm"
                >
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="rounded-lg bg-secondary p-2 text-[var(--accent-glow)]">
                      <stat.icon className="size-4" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{stat.label}</p>
                      <p className="font-mono text-lg text-foreground">
                        {stat.value}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {lastUpdated ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                Updated {new Date(lastUpdated).toLocaleTimeString()}
                {data?.cache
                  ? ` · Proxmox fetch age ${Math.round(data.cache.ageMs / 1000)}s`
                  : ""}
              </p>
            ) : null}

            <section className="space-y-3">
              <h2 className="font-[family-name:var(--font-display)] text-xl text-foreground">
                Nodes
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {overview?.nodes.map((node) => (
                  <Card
                    key={node.node}
                    className="border-border/60 bg-card/70 backdrop-blur-sm"
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base">{node.node}</CardTitle>
                        <Badge
                          variant={
                            node.status === "online" ? "default" : "secondary"
                          }
                          className={
                            node.status === "online"
                              ? "bg-[var(--accent-glow)] text-slate-950"
                              : undefined
                          }
                        >
                          {node.status}
                        </Badge>
                      </div>
                      <CardDescription className="font-mono text-xs">
                        {node.maxcpu} cores · {formatBytesShort(node.maxmem)} RAM
                        · uptime {formatUptime(node.uptime)}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Meter label="CPU" value={pct(node.cpu)} />
                      <Meter
                        label="Memory"
                        value={pct(node.maxmem ? node.mem / node.maxmem : 0)}
                      />
                    </CardContent>
                  </Card>
                ))}
                {!overview?.nodes.length && !loading ? (
                  <p className="text-sm text-muted-foreground">No nodes found.</p>
                ) : null}
              </div>
            </section>

            {(["vms", "lxcs"] as const).map((key) => {
              const list = guestsByType[key];
              const title = key === "vms" ? "Virtual machines" : "LXC containers";
              return (
                <section key={key} className="space-y-3">
                  <h2 className="font-[family-name:var(--font-display)] text-xl text-foreground">
                    {title}
                  </h2>
                  <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/70 backdrop-blur-sm">
                    {list.map((guest) => (
                      <div
                        key={`${guest.type}-${guest.vmid}`}
                        className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{guest.name}</p>
                            <Badge variant="secondary" className="font-mono text-[10px]">
                              {guest.vmid}
                            </Badge>
                            <Badge
                              variant={
                                guest.status === "running" ? "default" : "secondary"
                              }
                              className={
                                guest.status === "running"
                                  ? "bg-[var(--accent-glow)] text-slate-950"
                                  : undefined
                              }
                            >
                              {guest.status}
                            </Badge>
                          </div>
                          <p className="font-mono text-xs text-muted-foreground">
                            {guest.node} · CPU {pct(guest.cpu)}% ·{" "}
                            {formatBytesShort(guest.mem)} /{" "}
                            {formatBytesShort(guest.maxmem)}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {(
                            [
                              ["start", "Start"],
                              ["shutdown", "Shutdown"],
                              ["reboot", "Reboot"],
                              ["stop", "Stop"],
                              ["reset", "Reset"],
                            ] as const
                          ).map(([action, label]) => (
                            <Button
                              key={action}
                              size="sm"
                              variant="outline"
                              disabled={pending || needsUnlock}
                              onClick={() => void runPower(guest, action)}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {!list.length ? (
                      <p className="px-4 py-6 text-sm text-muted-foreground">
                        No guests in this category.
                      </p>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </TabsContent>

          <TabsContent value="alexa" className="space-y-4">
            <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mic className="size-4" />
                  Utterance simulator
                </CardTitle>
                <CardDescription>
                  Hits the same intent handler Alexa uses (no Amazon signature).
                  Requires dashboard unlock in production.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={customUtterance}
                    onChange={(e) => setCustomUtterance(e.target.value)}
                    placeholder="cluster status"
                    disabled={needsUnlock}
                  />
                  <Button
                    onClick={() => void simulateFromUtterance()}
                    disabled={simulating || needsUnlock}
                  >
                    {simulating ? "Running…" : "Simulate"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SIMULATIONS.map((item) => (
                    <Button
                      key={item.label}
                      size="sm"
                      variant="secondary"
                      disabled={simulating || needsUnlock}
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
                  <>
                    <Separator />
                    <p className="rounded-lg bg-secondary/60 px-3 py-2 text-sm leading-relaxed text-foreground">
                      {speech}
                    </p>
                  </>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="setup">
            {needsUnlock ? (
              <p className="text-sm text-muted-foreground">
                Unlock the dashboard to manage Proxmox servers.
              </p>
            ) : (
              <ServersSetup
                activeHost={data?.host ?? null}
                apiBase={data?.apiBase}
                mock={Boolean(data?.mock)}
                source={data?.source}
                serverName={data?.serverName}
                onServersChanged={() => void load({ fresh: true })}
              />
            )}
          </TabsContent>
        </Tabs>

        <footer className="flex items-center gap-2 pb-4 text-xs text-muted-foreground">
          <HardDrive className="size-3.5" />
          Stats refresh live while this tab is visible; Proxmox calls are cached
          server-side (~4s) so multiple polls share one fan-out.
        </footer>
      </main>
    </div>
  );
}
