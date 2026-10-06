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
  authPassword: string;
  allowSelfSigned: boolean;
  enabled: boolean;
  setActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  host: "https://",
  tokenId: "",
  tokenSecret: "",
  authPassword: "",
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
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [repairing, setRepairing] = useState(false);
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
      setConfigPath(json.configPath ?? null);
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
      authPassword: "",
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
      if (form.authPassword.trim()) {
        payload.authPassword = form.authPassword.trim();
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
    setServers((prev) => prev.filter((item) => item.id !== server.id));
    if (editingId === server.id) cancelForm();
    try {
      const res = await fetch(`/api/servers/${server.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
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
        ? { serverId: opts.serverId, repair: true }
        : {
            host: form.host.trim(),
            tokenId: form.tokenId.trim(),
            tokenSecret: form.tokenSecret.trim() || undefined,
            authPassword: form.authPassword.trim() || undefined,
            allowSelfSigned: form.allowSelfSigned,
            repair: true,
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
      const base = json.version
        ? `Connected — Proxmox ${json.version}`
        : "Connection successful.";
      if (json.repaired) {
        setMessage(`${base}. ${json.warning || "Token ACL repaired."}`);
      } else if (json.warning) {
        setMessage(`${base}. ${json.warning}`);
      } else {
        setMessage(base);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Connection test failed",
      );
    } finally {
      setTesting(false);
    }
  }

  async function repairAccess(opts?: { serverId?: string }) {
    setRepairing(true);
    setError(null);
    setMessage(null);
    try {
      const password = form.authPassword.trim();
      const body = opts?.serverId
        ? {
            serverId: opts.serverId,
            authPassword: password || undefined,
            savePassword: true,
          }
        : {
            host: form.host.trim(),
            tokenId: form.tokenId.trim(),
            tokenSecret: form.tokenSecret.trim() || undefined,
            authPassword: password,
            allowSelfSigned: form.allowSelfSigned,
            ...(editingId ? { serverId: editingId, savePassword: true } : {}),
          };

      if (!body.authPassword && !opts?.serverId) {
        throw new Error(
          "Enter the Proxmox user password (the account that owns the token) to repair access.",
        );
      }

      const res = await fetch("/api/servers/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.message || json.error || "Repair failed");
      }
      setMessage(json.message || "Token access repaired.");
      await loadServers();
      onServersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Repair failed");
    } finally {
      setRepairing(false);
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
      {/* TRUNCATED_FOR_PUSH - will fail if truncated */}
    </div>
  );
}
