import type {
  RequestEnvelope,
  Response,
  ResponseEnvelope,
  Slot,
} from "ask-sdk-model";
import {
  findGuest,
  getClusterOverview,
  getNodeStatus,
  powerGuest,
} from "@/lib/proxmox/client";
import type { GuestType, PowerAction } from "@/lib/proxmox/types";
import {
  formatBytes,
  formatPercent,
  formatUptime,
  speakName,
} from "./speech";

function slotValue(
  slots: Record<string, Slot> | undefined,
  name: string,
): string | undefined {
  const slot = slots?.[name];
  const resolution =
    slot?.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value
      ?.name;
  const value = resolution || slot?.value;
  return value?.trim() || undefined;
}

function speak(text: string, shouldEndSession = true): Response {
  return {
    outputSpeech: {
      type: "PlainText",
      text,
    },
    shouldEndSession,
  };
}

function speakReprompt(text: string, reprompt: string): Response {
  return {
    outputSpeech: {
      type: "PlainText",
      text,
    },
    reprompt: {
      outputSpeech: {
        type: "PlainText",
        text: reprompt,
      },
    },
    shouldEndSession: false,
  };
}

function resolveGuestType(raw?: string): GuestType | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (
    value.includes("container") ||
    value.includes("lxc") ||
    value.includes("c t") ||
    value === "ct"
  ) {
    return "lxc";
  }
  if (
    value.includes("virtual") ||
    value.includes("vm") ||
    value.includes("qemu") ||
    value.includes("machine")
  ) {
    return "qemu";
  }
  return undefined;
}

function resolvePowerAction(raw?: string): PowerAction | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value.includes("start") || value.includes("boot") || value.includes("power on")) {
    return "start";
  }
  if (value.includes("force") || value === "stop" || value.includes("kill")) {
    return "stop";
  }
  if (value.includes("shut")) {
    return "shutdown";
  }
  if (value.includes("reboot") || value.includes("restart")) {
    return "reboot";
  }
  if (value.includes("reset")) {
    return "reset";
  }
  return undefined;
}

async function handleLaunch(): Promise<Response> {
  return speakReprompt(
    "Welcome to Voxmox. You can ask for cluster status, node stats, or tell me to start, stop, shutdown, or reboot a virtual machine or container.",
    "What would you like to do with your Proxmox cluster?",
  );
}

async function handleHelp(): Promise<Response> {
  return speakReprompt(
    "Try saying: cluster status, node stats for P V E 1, stats for docker host, or start the pihole container.",
    "What would you like to check or control?",
  );
}

async function handleClusterStatus(): Promise<Response> {
  const overview = await getClusterOverview();
  const { summary } = overview;
  const modeNote =
    overview.mode === "mock"
      ? " Running in demo mode with sample cluster data."
      : "";

  return speak(
    `Your cluster has ${summary.onlineNodes} of ${summary.nodeCount} nodes online, ` +
      `${summary.vmCount} virtual machines, and ${summary.lxcCount} containers. ` +
      `${summary.runningGuests} guests are running and ${summary.stoppedGuests} are stopped.` +
      modeNote,
  );
}

async function handleNodeStats(nodeName?: string): Promise<Response> {
  const overview = await getClusterOverview();

  if (!nodeName) {
    if (overview.nodes.length === 0) {
      return speak("I could not find any nodes in the cluster.");
    }
    const lines = overview.nodes.map((node) => {
      return `${speakName(node.node)} is ${node.status}, CPU ${formatPercent(node.cpu)}, memory ${formatPercent(node.mem / Math.max(node.maxmem, 1))}`;
    });
    return speak(`Node summary: ${lines.join(". ")}.`);
  }

  const node = await getNodeStatus(nodeName);
  if (!node) {
    return speak(`I could not find a node named ${speakName(nodeName)}.`);
  }

  return speak(
    `${speakName(node.node)} is ${node.status}. ` +
      `CPU is ${formatPercent(node.cpu)} across ${node.maxcpu} cores. ` +
      `Memory is ${formatBytes(node.mem)} of ${formatBytes(node.maxmem)}. ` +
      `Uptime is ${formatUptime(node.uptime)}.`,
  );
}

function parseGuestQuery(raw?: string): {
  name?: string;
  preferredType?: GuestType;
} {
  if (!raw) return {};
  const preferredType = resolveGuestType(raw);
  let name = raw.trim();

  // Strip type words speakers often include, e.g. "pihole container".
  name = name
    .replace(
      /\b(virtual\s*machines?|containers?|v\s*m|vms|lxc|l\s*x\s*c|c\s*t|qemu|machines?)\b/gi,
      " ",
    )
    .replace(/\b(the|my|a|an)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { name: name || undefined, preferredType };
}

async function handleGuestStats(
  guestName?: string,
  guestTypeRaw?: string,
): Promise<Response> {
  const parsed = parseGuestQuery(guestName);
  const preferredType =
    resolveGuestType(guestTypeRaw) ?? parsed.preferredType;
  const name = parsed.name;

  if (!name) {
    return speakReprompt(
      "Which virtual machine or container should I check?",
      "Tell me the name or ID of the guest.",
    );
  }

  const guest = await findGuest(name, preferredType);
  if (!guest) {
    return speak(`I could not find a guest named ${speakName(name)}.`);
  }

  const kind = guest.type === "lxc" ? "container" : "virtual machine";
  if (guest.status !== "running") {
    return speak(
      `${speakName(guest.name)} is a ${kind} on ${speakName(guest.node)} and is currently ${guest.status}.`,
    );
  }

  return speak(
    `${speakName(guest.name)} is a ${kind} on ${speakName(guest.node)}. ` +
      `It is running. CPU is ${formatPercent(guest.cpu)} of ${guest.cpus} cores. ` +
      `Memory is ${formatBytes(guest.mem)} of ${formatBytes(guest.maxmem)}. ` +
      `Disk is ${formatBytes(guest.disk)} of ${formatBytes(guest.maxdisk)}. ` +
      `Uptime is ${formatUptime(guest.uptime)}.`,
  );
}

async function handleListGuests(guestTypeRaw?: string): Promise<Response> {
  const overview = await getClusterOverview();
  const preferredType = resolveGuestType(guestTypeRaw);
  const guests = preferredType
    ? overview.guests.filter((g) => g.type === preferredType)
    : overview.guests;

  if (guests.length === 0) {
    return speak("I could not find any matching guests.");
  }

  const label = preferredType === "lxc"
    ? "containers"
    : preferredType === "qemu"
      ? "virtual machines"
      : "guests";

  const running = guests.filter((g) => g.status === "running");
  const stopped = guests.filter((g) => g.status !== "running");

  const runningNames = running.slice(0, 8).map((g) => speakName(g.name));
  const stoppedNames = stopped.slice(0, 8).map((g) => speakName(g.name));

  let speech = `There are ${guests.length} ${label}. ${running.length} running`;
  if (runningNames.length) speech += `: ${runningNames.join(", ")}`;
  speech += `. ${stopped.length} stopped`;
  if (stoppedNames.length) speech += `: ${stoppedNames.join(", ")}`;
  speech += ".";

  return speak(speech);
}

async function handlePowerControl(
  actionRaw?: string,
  guestName?: string,
  guestTypeRaw?: string,
): Promise<Response> {
  const action = resolvePowerAction(actionRaw);
  if (!action) {
    return speakReprompt(
      "I can start, stop, shut down, reboot, or reset a guest. Which action should I take?",
      "Say something like start docker host.",
    );
  }

  const parsed = parseGuestQuery(guestName);
  const preferredType =
    resolveGuestType(guestTypeRaw) ?? parsed.preferredType;
  const name = parsed.name;

  if (!name) {
    return speakReprompt(
      `Which virtual machine or container should I ${action}?`,
      "Tell me the guest name or ID.",
    );
  }

  const guest = await findGuest(name, preferredType);
  if (!guest) {
    return speak(`I could not find a guest named ${speakName(name)}.`);
  }

  const result = await powerGuest(guest.vmid, guest.type, guest.node, action);
  return speak(result.message);
}

async function handlePerformance(target?: string): Promise<Response> {
  const overview = await getClusterOverview();

  if (!target) {
    const hottestNode = [...overview.nodes].sort((a, b) => b.cpu - a.cpu)[0];
    const hottestGuest = [...overview.guests]
      .filter((g) => g.status === "running")
      .sort((a, b) => b.cpu - a.cpu)[0];

    let speech = "Cluster performance summary. ";
    if (hottestNode) {
      speech += `The busiest node is ${speakName(hottestNode.node)} at ${formatPercent(hottestNode.cpu)} CPU. `;
    }
    if (hottestGuest) {
      speech += `The busiest guest is ${speakName(hottestGuest.name)} at ${formatPercent(hottestGuest.cpu)} CPU.`;
    }
    return speak(speech.trim());
  }

  const node = await getNodeStatus(target);
  if (node) {
    return speak(
      `${speakName(node.node)} performance: CPU ${formatPercent(node.cpu)}, memory ${formatPercent(node.mem / Math.max(node.maxmem, 1))}, uptime ${formatUptime(node.uptime)}.`,
    );
  }

  const guest = await findGuest(target);
  if (guest) {
    if (guest.status !== "running") {
      return speak(`${speakName(guest.name)} is ${guest.status}, so there are no live performance stats.`);
    }
    return speak(
      `${speakName(guest.name)} performance: CPU ${formatPercent(guest.cpu)}, memory ${formatPercent(guest.mem / Math.max(guest.maxmem, 1))}, disk ${formatPercent(guest.disk / Math.max(guest.maxdisk, 1))}.`,
    );
  }

  return speak(`I could not find a node or guest named ${speakName(target)}.`);
}

export async function handleAlexaRequest(
  envelope: RequestEnvelope,
): Promise<ResponseEnvelope> {
  const request = envelope.request;
  let response: Response;

  try {
    switch (request.type) {
      case "LaunchRequest":
        response = await handleLaunch();
        break;
      case "SessionEndedRequest":
        response = speak("Goodbye.", true);
        break;
      case "IntentRequest": {
        const intentName = request.intent.name;
        const slots = request.intent.slots;

        switch (intentName) {
          case "AMAZON.HelpIntent":
            response = await handleHelp();
            break;
          case "AMAZON.CancelIntent":
          case "AMAZON.StopIntent":
            response = speak("Okay, closing Voxmox.");
            break;
          case "AMAZON.FallbackIntent":
            response = speakReprompt(
              "I did not catch that. You can ask for cluster status, node stats, guest stats, or power controls.",
              "What would you like to do?",
            );
            break;
          case "ClusterStatusIntent":
            response = await handleClusterStatus();
            break;
          case "NodeStatsIntent":
            response = await handleNodeStats(slotValue(slots, "nodeName"));
            break;
          case "GuestStatsIntent":
            response = await handleGuestStats(
              slotValue(slots, "guestName"),
            );
            break;
          case "ListGuestsIntent":
            response = await handleListGuests(slotValue(slots, "guestType"));
            break;
          case "PowerControlIntent":
            response = await handlePowerControl(
              slotValue(slots, "action"),
              slotValue(slots, "guestName"),
              slotValue(slots, "guestType"),
            );
            break;
          case "StartGuestIntent":
            response = await handlePowerControl(
              "start",
              slotValue(slots, "guestName"),
            );
            break;
          case "StopGuestIntent":
            response = await handlePowerControl(
              "stop",
              slotValue(slots, "guestName"),
            );
            break;
          case "ShutdownGuestIntent":
            response = await handlePowerControl(
              "shutdown",
              slotValue(slots, "guestName"),
            );
            break;
          case "RebootGuestIntent":
            response = await handlePowerControl(
              "reboot",
              slotValue(slots, "guestName"),
            );
            break;
          case "ResetGuestIntent":
            response = await handlePowerControl(
              "reset",
              slotValue(slots, "guestName"),
            );
            break;
          case "PerformanceIntent":
            response = await handlePerformance(slotValue(slots, "target"));
            break;
          default:
            response = speak(
              `I do not know how to handle the ${intentName} intent yet.`,
            );
        }
        break;
      }
      default:
        response = speak("Unsupported Alexa request type.");
    }
  } catch (error) {
    console.error("Alexa handler error:", error);
    response = speak(
      "Something went wrong talking to Proxmox. Check the Voxmox dashboard and your API token settings.",
    );
  }

  return {
    version: "1.0",
    response,
  };
}
