"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { ProxmoxServerPublic } from "@/lib/servers/types";
import { Check, Pencil, Plus, Trash2, Zap } from "lucide-react";

interface ServersSetupProps {
  activeHost: string | null;
  apiBase?: string | null;
  mock: boolean;
  source?: string | null;
  serverName?: string | null;
  onServersChanged: () => void;
}

interface FormState {
  name: string;
  host: string;
  tokenId: string;
  tokenSecret: string;
  allowSelfSigned: boolean;
  enabled: boolean;
  setActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  host: "https://",
  tokenId: "",
  tokenSecret: "",
  allowSelfSigned: true,
  enabled: true,
  setActive: true,
};

export function ServersSetup({
  activeHost,
  apiBase,
  mock,
  source,
  serverName,
  onServersChanged,
}: ServersSetupProps) {
  const [servers, setServers] = useState<ProxmoxServerPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/servers", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load servers");
      setServers(json.servers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  function startCreate() {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      setActive: servers.length === 0,
    });
    setShowForm(true);
    setMessage(null);
    setError(null);
  }

  function startEdit(server: ProxmoxServerPublic) {
    setEditingId(server.id);
    setForm({
      name: server.name,
      host: server.host,
      tokenId: server.tokenId,
      tokenSecret: "",
      allowSelfSigned: server.allowSelfSigned,
      enabled: server.enabled,
      setActive: server.isActive,
    });
    setShowForm(true);
    setMessage(null);
    setError(null);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function saveServer() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        host: form.host.trim(),
        tokenId: form.tokenId.trim(),
        allowSelfSigned: form.allowSelfSigned,
        enabled: form.enabled,
        setActive: form.setActive,
      };
      if (form.tokenSecret.trim()) {
        payload.tokenSecret = form.tokenSecret.trim();
      } else if (!editingId) {
        throw new Error("Token secret is required for new servers.");
      }

      const res = await fetch(
        editingId ? `/api/servers/${editingId}` : "/api/servers",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save server");

      setMessage(editingId ? "Server updated." : "Server added.");
      cancelForm();
      await loadServers();
      onServersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save server");
    } finally {
      setSaving(false);
    }
  }

  async function removeServer(server: ProxmoxServerPublic) {
    if (removingId) return;
    if (
      !window.confirm(
        `Remove “${server.name}”? Saved token credentials will be deleted.`,
      )
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    setRemovingId(server.id);
    // Drop from the list immediately so a slow cluster refresh cannot leave a stale row.
    setServers((prev) => prev.filter((item) => item.id !== server.id));
    if (editingId === server.id) cancelForm();
    try {
      const res = await fetch(`/api/servers/${server.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      // 404 means it is already gone — treat as success.
      if (!res.ok && res.status !== 404) {
        throw new Error(json.error || "Failed to remove server");
      }
      setMessage(`Removed ${server.name}.`);
      await loadServers();
      onServersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove server");
      await loadServers();
    } finally {
      setRemovingId(null);
    }
  }

  async function activateServer(server: ProxmoxServerPublic) {
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/activate`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to activate server");
      setMessage(`${server.name} is now active.`);
      await loadServers();
      onServersChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to activate server",
      );
    }
  }

  async function testConnection(opts?: { serverId?: string }) {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const body = opts?.serverId
        ? { serverId: opts.serverId }
        : {
            host: form.host.trim(),
            tokenId: form.tokenId.trim(),
            tokenSecret: form.tokenSecret.trim() || undefined,
            allowSelfSigned: form.allowSelfSigned,
            ...(editingId ? { serverId: editingId } : {}),
          };

      const res = await fetch("/api/servers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Connection test failed");
      }
      setMessage(
        json.version
          ? `Connected — Proxmox ${json.version}`
          : "Connection successful.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Connection test failed",
      );
    } finally {
      setTesting(false);
    }
  }

  const sourceLabel =
    source === "server"
      ? serverName
        ? `Using saved server “${serverName}”`
        : "Using a saved server"
      : source === "env"
        ? "Using environment variables"
        : "Demo mode (no live credentials)";

  return (
    <div className="space-y-4">
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Proxmox servers</CardTitle>
          <CardDescription>
            Add, edit, or remove API endpoints from this dashboard. Active
            credentials are stored in{" "}
            <code className="font-mono">data/servers.json</code> on the Voxmox
            host (not in git). Env vars still work as a fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge
              className={
                mock
                  ? undefined
                  : "bg-[var(--accent-glow)] text-slate-950 hover:bg-[var(--accent-glow)]"
              }
              variant={mock ? "secondary" : "default"}
            >
              {mock ? "Demo" : "Live"}
            </Badge>
            <span>{sourceLabel}</span>
            {activeHost ? (
              <>
                <span>·</span>
                <code className="font-mono text-foreground">{activeHost}</code>
              </>
            ) : null}
            {apiBase ? (
              <>
                <span>·</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  calls {apiBase}/…
                </span>
              </>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="rounded-xl border border-[var(--accent-glow)]/30 bg-[var(--accent-glow)]/10 px-4 py-3 text-sm text-foreground">
              {message}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {loading
                ? "Loading servers…"
                : servers.length === 0
                  ? "No saved servers yet."
                  : `${servers.length} saved server${servers.length === 1 ? "" : "s"}`}
            </p>
            <Button size="sm" onClick={startCreate}>
              <Plus className="size-4" />
              Add server
            </Button>
          </div>

          <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
            {servers.map((server) => (
              <div
                key={server.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{server.name}</p>
                    {server.isActive ? (
                      <Badge className="bg-[var(--accent-glow)] text-slate-950 hover:bg-[var(--accent-glow)]">
                        Active
                      </Badge>
                    ) : null}
                    {!server.enabled ? (
                      <Badge variant="secondary">Disabled</Badge>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {server.host}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {server.tokenId}
                    {server.hasTokenSecret ? " · secret saved" : " · no secret"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {!server.isActive && server.enabled ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void activateServer(server)}
                    >
                      <Check className="size-4" />
                      Use
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testing}
                    onClick={() => void testConnection({ serverId: server.id })}
                  >
                    <Zap className="size-4" />
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startEdit(server)}
                  >
                    <Pencil className="size-4" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={removingId === server.id}
                    onClick={() => void removeServer(server)}
                  >
                    <Trash2 className="size-4" />
                    {removingId === server.id ? "Removing…" : "Remove"}
                  </Button>
                </div>
              </div>
            ))}
            {!loading && servers.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Add your first Proxmox API URL and token to leave demo mode.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {showForm ? (
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2">
          <CardHeader>
            <CardTitle>
              {editingId ? "Edit server" : "Add Proxmox server"}
            </CardTitle>
            <CardDescription>
              Enter the Proxmox web UI base URL only (usually{" "}
              <code className="font-mono">https://host:8006</code>). Voxmox
              always calls{" "}
              <code className="font-mono">{"{host}/api2/json/..."}</code> —
              do not include <code className="font-mono">/api2/json</code> in
              the field. Leave the token secret blank when editing to keep the
              saved value.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="text-muted-foreground">Display name</span>
                <Input
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="Home cluster"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted-foreground">
                  Proxmox base URL
                </span>
                <Input
                  value={form.host}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, host: e.target.value }))
                  }
                  placeholder="https://192.168.1.10:8006"
                  className="font-mono"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted-foreground">Token ID</span>
                <Input
                  value={form.tokenId}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, tokenId: e.target.value }))
                  }
                  placeholder="root@pam!voxmox"
                  className="font-mono"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="text-muted-foreground">
                  Token secret
                  {editingId ? " (leave blank to keep)" : ""}
                </span>
                <Input
                  type="password"
                  value={form.tokenSecret}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      tokenSecret: e.target.value,
                    }))
                  }
                  placeholder={editingId ? "••••••••" : "xxxxxxxx-xxxx-…"}
                  className="font-mono"
                  autoComplete="off"
                />
              </label>
            </div>

            <div className="flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent-glow)]"
                  checked={form.allowSelfSigned}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      allowSelfSigned: e.target.checked,
                    }))
                  }
                />
                Allow self-signed TLS
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent-glow)]"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      enabled: e.target.checked,
                    }))
                  }
                />
                Enabled
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent-glow)]"
                  checked={form.setActive}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      setActive: e.target.checked,
                    }))
                  }
                />
                Make active after save
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveServer()} disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Add server"}
              </Button>
              <Button
                variant="secondary"
                disabled={testing}
                onClick={() => void testConnection()}
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
              <Button variant="outline" onClick={cancelForm} disabled={saving}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Alexa endpoint</CardTitle>
          <CardDescription>
            Skill path: <code className="font-mono">/api/alexa</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Create a Proxmox API token with VM/LXC audit + power privileges.
            </li>
            <li>
              Add the server above (or set env vars in{" "}
              <code className="font-mono">.env.local</code> /{" "}
              <code className="font-mono">.env</code>).
            </li>
            <li>
              Expose this app over HTTPS (Cloudflare Tunnel, Tailscale Funnel,
              or a reverse proxy).
            </li>
            <li>
              In Alexa Developer Console, import{" "}
              <code className="font-mono">alexa/interaction-model.json</code>{" "}
              and point the endpoint to{" "}
              <code className="font-mono">https://your-host/api/alexa</code>.
            </li>
          </ol>
          <p>
            Example:{" "}
            <span className="text-foreground">
              “Alexa, ask vox mox to start docker host.”
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
