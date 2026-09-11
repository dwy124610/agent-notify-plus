// Grok Build hook adapter: forwards completion and abort events to agent-notify.
// Required config: ~/.config/agent-notify/grok-build.json.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORWARD_EVENT_NAMES = new Set([
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
]);
const DURATION_RE = /^(\d+)([smhd])$/;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_DISABLED_SESSIONS = 5;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeGrokBuildHookEvent(raw) {
  if (!isRecord(raw)) return undefined;
  const name = getString(raw.hook_event_name) ?? getString(raw.hookEventName);
  if (!name) return undefined;
  const aliases = {
    userpromptsubmit: "UserPromptSubmit",
    stop: "Stop",
    stopfailure: "StopFailure",
    stopcancelled: "StopCancelled",
  };
  return aliases[name.replace(/_/g, "").toLowerCase()] ?? name;
}

export function getGrokBuildSessionId(raw) {
  if (!isRecord(raw)) return undefined;
  return getString(raw.session_id) ?? getString(raw.sessionId);
}

function getGrokBuildCwd(raw) {
  if (!isRecord(raw)) return undefined;
  return getString(raw.cwd) ?? getString(raw.workspaceRoot);
}

function getSubagentType(raw) {
  if (!isRecord(raw)) return undefined;
  return getString(raw.subagentType) ?? getString(raw.subagent_type);
}

function getStopReason(raw) {
  if (!isRecord(raw)) return undefined;
  return getString(raw.reason);
}

export function shouldForwardGrokBuildEvent(raw) {
  const hookEventName = normalizeGrokBuildHookEvent(raw);
  if (typeof hookEventName !== "string" || !FORWARD_EVENT_NAMES.has(hookEventName)) {
    return false;
  }
  if (getSubagentType(raw)) return false;
  if (hookEventName === "Stop") {
    const reason = getStopReason(raw);
    if (reason && reason !== "end_turn") return false;
  }
  return true;
}

export function summarizeGrokBuildEventForDebug(raw) {
  return {
    hookEventName: normalizeGrokBuildHookEvent(raw) ?? "unknown",
    sessionId: getGrokBuildSessionId(raw),
    raw,
  };
}

function writeDebugLog(config, raw, forwarded, sent, extra = {}) {
  if (!config.debugLogPath) return;
  try {
    appendFileSync(
      config.debugLogPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        forwarded,
        sent,
        ...extra,
        ...summarizeGrokBuildEventForDebug(raw),
      })}\n`,
    );
  } catch {
    // Fail-safe.
  }
}

export function enrichGrokBuildRaw(raw) {
  if (!isRecord(raw)) return raw;
  const next = { ...raw };
  const hookEventName = normalizeGrokBuildHookEvent(raw);
  if (hookEventName) next.hook_event_name = hookEventName;
  const sessionId = getGrokBuildSessionId(raw);
  if (sessionId && !next.session_id) next.session_id = sessionId;
  const cwd = getGrokBuildCwd(raw);
  if (cwd && !next.cwd) next.cwd = cwd;
  const last =
    getString(next.last_assistant_message) ?? getString(next.lastAssistantMessage);
  if (last) next.last_assistant_message = last;
  return next;
}

export async function sendGrokBuildEvent(
  serverUrl,
  token,
  timeoutMs,
  raw,
  fetchImpl = fetch,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${serverUrl.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agent: "grok-build", raw }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function readRequiredString(raw, key) {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`agent-notify config requires ${key}`);
  }
  return value;
}

function readOptionalNumber(raw, key) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`agent-notify config ${key} must be a non-negative number`);
  }
  return value;
}

function readOptionalString(raw, key) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`agent-notify config ${key} must be a non-empty string`);
  }
  return value;
}

function emptySwitchState() {
  return { persistentDisabled: false, disabledSessions: {} };
}

function withSwitchStateReadError(message) {
  return { ...emptySwitchState(), readError: `state-read: ${message}` };
}

function readDisabledSessions(value) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("invalid disabledSessions");
  const disabledSessions = {};
  for (const [sessionId, sessionState] of Object.entries(value)) {
    if (!isRecord(sessionState) || typeof sessionState.disabledAt !== "string") {
      throw new Error(`invalid disabledSessions.${sessionId}`);
    }
    disabledSessions[sessionId] = { disabledAt: sessionState.disabledAt };
  }
  return disabledSessions;
}

function trimDisabledSessions(disabledSessions) {
  return Object.fromEntries(
    Object.entries(disabledSessions)
      .sort(([, left], [, right]) => Date.parse(right.disabledAt) - Date.parse(left.disabledAt))
      .slice(0, MAX_DISABLED_SESSIONS),
  );
}

function addDuration(now, amount, unit) {
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(now.getTime() + amount * multipliers[unit]);
}

export function parseAgentNotifyCommand(prompt, now = new Date()) {
  if (typeof prompt !== "string") return { type: "none" };
  const parts = prompt.trim().split(/\s+/);
  if (parts[0] !== "/agent-notify") return { type: "none" };
  const action = parts[1] ?? "status";
  const arg = parts[2];
  if (parts.length > 3) {
    return { type: "invalid", message: "Usage: /agent-notify on|off|clear|status" };
  }
  if (action === "on" && !arg) return { type: "on" };
  if (action === "status" && !arg) return { type: "status" };
  if (action === "clear" && !arg) return { type: "clear-sessions" };
  if (action !== "off") {
    return { type: "invalid", message: "Usage: /agent-notify on|off|clear|status" };
  }
  if (!arg) return { type: "off-session" };
  if (arg === "persist") return { type: "off-persist" };
  const match = arg.match(DURATION_RE);
  if (!match) {
    return { type: "invalid", message: "Use a duration like 30m, 2h, or persist" };
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { type: "invalid", message: "Duration must be positive" };
  }
  return { type: "off-until", until: addDuration(now, amount, match[2]).toISOString() };
}

export function getGrokBuildSwitchStatePath(home = homedir()) {
  return join(home, ".config", "agent-notify", "state", "grok-build.json");
}

export function readGrokBuildSwitchState(statePath) {
  try {
    if (!existsSync(statePath)) return emptySwitchState();
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (!isRecord(raw)) throw new Error("invalid state root");
    return {
      persistentDisabled: raw.persistentDisabled === true,
      temporaryDisabledUntil:
        typeof raw.temporaryDisabledUntil === "string"
          ? raw.temporaryDisabledUntil
          : undefined,
      currentSessionId:
        typeof raw.currentSessionId === "string" ? raw.currentSessionId : undefined,
      disabledSessions: readDisabledSessions(raw.disabledSessions),
    };
  } catch (error) {
    return withSwitchStateReadError(error instanceof Error ? error.message : String(error));
  }
}

export function writeGrokBuildSwitchState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function applyGrokBuildSwitchCommand(state, command, sessionId, now = new Date()) {
  const next = {
    persistentDisabled: state.persistentDisabled === true,
    temporaryDisabledUntil: state.temporaryDisabledUntil,
    currentSessionId: state.currentSessionId,
    disabledSessions: isRecord(state.disabledSessions) ? { ...state.disabledSessions } : {},
  };
  if (command.type === "on") {
    next.persistentDisabled = false;
    delete next.temporaryDisabledUntil;
    if (sessionId) delete next.disabledSessions[sessionId];
    return { state: next, message: "AgentNotify is on for Grok Build." };
  }
  if (command.type === "off-persist") {
    next.persistentDisabled = true;
    return { state: next, message: "AgentNotify is persistently muted for Grok Build." };
  }
  if (command.type === "off-until") {
    next.temporaryDisabledUntil = command.until;
    return {
      state: next,
      message: `AgentNotify is muted for Grok Build until ${command.until}.`,
    };
  }
  if (command.type === "clear-sessions") {
    next.disabledSessions = {};
    return { state: next, message: "AgentNotify session mutes are cleared for Grok Build." };
  }
  if (command.type === "off-session") {
    if (!sessionId) {
      return {
        state: next,
        message:
          "Session mute requires a session id. Use /agent-notify off 30m or /agent-notify off persist.",
      };
    }
    next.disabledSessions[sessionId] = { disabledAt: now.toISOString() };
    next.disabledSessions = trimDisabledSessions(next.disabledSessions);
    return { state: next, message: "AgentNotify is muted for this Grok Build session." };
  }
  return { state: next, message: command.message ?? "Invalid AgentNotify command." };
}

export function getGrokBuildMuteReason(state, sessionId, now = new Date()) {
  if (state.persistentDisabled === true) return "persistent";
  if (typeof state.temporaryDisabledUntil === "string") {
    const untilMs = Date.parse(state.temporaryDisabledUntil);
    if (Number.isFinite(untilMs) && untilMs > now.getTime()) return "timed";
  }
  if (sessionId && isRecord(state.disabledSessions) && state.disabledSessions[sessionId]) {
    return "session";
  }
  return undefined;
}

export function parseGrokBuildConfig(raw) {
  return {
    serverUrl: readRequiredString(raw, "serverUrl"),
    token: readRequiredString(raw, "token"),
    timeoutMs: readOptionalNumber(raw, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    debugLogPath: readOptionalString(raw, "debugLogPath"),
  };
}

function readAgentNotifyConfig() {
  const configPath = join(homedir(), ".config", "agent-notify", "grok-build.json");
  return parseGrokBuildConfig(JSON.parse(readFileSync(configPath, "utf8")));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getPrompt(raw) {
  if (!isRecord(raw)) return undefined;
  return typeof raw.prompt === "string" ? raw.prompt : undefined;
}

export async function handleGrokBuildEvent(config, raw, deps = {}) {
  const now = deps.now ?? new Date();
  const statePath = deps.statePath ?? getGrokBuildSwitchStatePath();
  const readState = deps.readState ?? readGrokBuildSwitchState;
  const writeState = deps.writeState ?? writeGrokBuildSwitchState;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hookEventName = normalizeGrokBuildHookEvent(raw);
  const sessionId = getGrokBuildSessionId(raw);
  let state;
  let debug;
  try {
    state = readState(statePath);
    if (typeof state?.readError === "string") {
      debug = { switchStateReadError: state.readError };
    }
  } catch (error) {
    state = emptySwitchState();
    debug = {
      switchStateReadError: `state-read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const command = parseAgentNotifyCommand(getPrompt(raw), now);
  if (hookEventName === "UserPromptSubmit" && command.type !== "none") {
    if (command.type === "status") {
      return {
        forwarded: false,
        sent: false,
        command: command.type,
        ...(debug ? { debug } : {}),
      };
    }
    const result = applyGrokBuildSwitchCommand(state, command, sessionId, now);
    if (command.type !== "invalid" && sessionId) {
      result.state.currentSessionId = sessionId;
    }
    if (command.type !== "invalid") {
      try {
        writeState(statePath, result.state);
      } catch {
        return {
          forwarded: false,
          sent: false,
          command: command.type,
          error: "state-write",
          ...(debug ? { debug } : {}),
        };
      }
    }
    return {
      forwarded: false,
      sent: false,
      command: command.type,
      message: result.message,
      ...(debug ? { debug } : {}),
    };
  }

  const forwarded = shouldForwardGrokBuildEvent(raw);
  if (!forwarded) return { forwarded: false, sent: false };

  const muted = getGrokBuildMuteReason(state, sessionId, now);
  if (muted) {
    return { forwarded: true, sent: false, muted, ...(debug ? { debug } : {}) };
  }

  const sent = await sendGrokBuildEvent(
    config.serverUrl,
    config.token,
    config.timeoutMs,
    enrichGrokBuildRaw(raw),
    fetchImpl,
  );
  return { forwarded: true, sent, ...(debug ? { debug } : {}) };
}

async function main() {
  let config;
  try {
    config = readAgentNotifyConfig();
  } catch {
    return;
  }

  let raw;
  try {
    raw = JSON.parse(await readStdin());
  } catch {
    return;
  }

  const result = await handleGrokBuildEvent(config, raw);
  writeDebugLog(config, raw, result.forwarded, result.sent, result.debug);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
