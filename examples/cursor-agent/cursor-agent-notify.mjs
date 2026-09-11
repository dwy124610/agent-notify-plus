// Cursor Agent hook adapter: forwards completion and abort events to agent-notify.
// Configure Cursor command hooks to run this file with node.
// Required config: ~/.config/agent-notify/cursor-agent.json.

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

const FORWARD_EVENT_NAMES = new Set(["beforeSubmitPrompt", "stop"]);
const MAX_CACHED_SUMMARIES = 20;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeCursorHookEvent(raw) {
  if (!isRecord(raw)) return undefined;
  const name = getString(raw.hook_event_name);
  if (!name) return undefined;
  const aliases = {
    beforesubmitprompt: "beforeSubmitPrompt",
    userpromptsubmit: "beforeSubmitPrompt",
    stop: "stop",
    afteragentresponse: "afterAgentResponse",
    agentresponse: "afterAgentResponse",
  };
  return aliases[name.toLowerCase()] ?? name;
}

export function getCursorSessionId(raw) {
  if (!isRecord(raw)) return undefined;
  return getString(raw.session_id) ?? getString(raw.conversation_id);
}

function getCursorCwd(raw) {
  if (!isRecord(raw)) return undefined;
  const cwd = getString(raw.cwd);
  if (cwd) return cwd;
  if (Array.isArray(raw.workspace_roots)) {
    return getString(raw.workspace_roots[0]);
  }
  return undefined;
}

export function shouldForwardCursorAgentEvent(raw) {
  const hookEventName = normalizeCursorHookEvent(raw);
  return typeof hookEventName === "string" && FORWARD_EVENT_NAMES.has(hookEventName);
}

export function summarizeCursorAgentEventForDebug(raw) {
  return {
    hookEventName: normalizeCursorHookEvent(raw) ?? "unknown",
    sessionId: getCursorSessionId(raw),
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
        ...summarizeCursorAgentEventForDebug(raw),
      })}\n`,
    );
  } catch {
    // Fail-safe: debug logging must never block Cursor Agent.
  }
}

export function getCursorSummaryPath(home = homedir()) {
  return join(home, ".config", "agent-notify", "state", "cursor-agent-summaries.json");
}

function readSummaryCache(summaryPath) {
  try {
    if (!existsSync(summaryPath)) return {};
    const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeSummaryCache(summaryPath, cache) {
  mkdirSync(dirname(summaryPath), { recursive: true });
  const entries = Object.entries(cache)
    .sort(([, left], [, right]) => {
      const leftMs = Date.parse(isRecord(left) ? left.updatedAt : "");
      const rightMs = Date.parse(isRecord(right) ? right.updatedAt : "");
      return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
    })
    .slice(0, MAX_CACHED_SUMMARIES);
  writeFileSync(summaryPath, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
}

export function rememberCursorSummary(summaryPath, sessionId, text, now = new Date()) {
  if (!sessionId || !text) return;
  const cache = readSummaryCache(summaryPath);
  cache[sessionId] = { text, updatedAt: now.toISOString() };
  writeSummaryCache(summaryPath, cache);
}

export function consumeCursorSummary(summaryPath, sessionId) {
  if (!sessionId) return undefined;
  const cache = readSummaryCache(summaryPath);
  const entry = cache[sessionId];
  if (!isRecord(entry) || typeof entry.text !== "string") return undefined;
  delete cache[sessionId];
  writeSummaryCache(summaryPath, cache);
  return entry.text;
}

export function enrichCursorAgentRaw(raw, summaryPath) {
  if (!isRecord(raw)) return raw;
  const next = { ...raw };
  const hookEventName = normalizeCursorHookEvent(raw);
  if (hookEventName) next.hook_event_name = hookEventName;
  const sessionId = getCursorSessionId(raw);
  if (sessionId && !next.session_id) next.session_id = sessionId;
  const cwd = getCursorCwd(raw);
  if (cwd && !next.cwd) next.cwd = cwd;
  if (hookEventName === "stop") {
    const cached = consumeCursorSummary(summaryPath, sessionId);
    const text = getString(next.last_assistant_message) ?? cached ?? getString(next.text);
    if (text) next.last_assistant_message = text;
  }
  return next;
}

export async function sendCursorAgentEvent(
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
      body: JSON.stringify({ agent: "cursor-agent", raw }),
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

const DEFAULT_TIMEOUT_MS = 2000;
const DURATION_RE = /^(\d+)([smhd])$/;
const MAX_DISABLED_SESSIONS = 5;

function emptySwitchState() {
  return {
    persistentDisabled: false,
    disabledSessions: {},
  };
}

function withSwitchStateReadError(message) {
  return {
    ...emptySwitchState(),
    readError: `state-read: ${message}`,
  };
}

function readDisabledSessions(value) {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error("invalid disabledSessions");
  }

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
      .sort(([, left], [, right]) => {
        const leftMs = Date.parse(left.disabledAt);
        const rightMs = Date.parse(right.disabledAt);
        return (
          (Number.isFinite(rightMs) ? rightMs : 0) -
          (Number.isFinite(leftMs) ? leftMs : 0)
        );
      })
      .slice(0, MAX_DISABLED_SESSIONS),
  );
}

function readOptionalBoolean(value, key) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function readOptionalStateString(value, key) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function addDuration(now, amount, unit) {
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(now.getTime() + amount * multipliers[unit]);
}

export function parseAgentNotifyCommand(prompt, now = new Date()) {
  if (typeof prompt !== "string") return { type: "none" };
  const trimmed = prompt.trim();
  const parts = trimmed.split(/\s+/);
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
    return {
      type: "invalid",
      message: "Use a duration like 30m, 2h, or persist",
    };
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { type: "invalid", message: "Duration must be positive" };
  }
  return {
    type: "off-until",
    until: addDuration(now, amount, match[2]).toISOString(),
  };
}

export function getCursorAgentSwitchStatePath(home = homedir()) {
  return join(home, ".config", "agent-notify", "state", "cursor-agent.json");
}

export function readCursorAgentSwitchState(statePath) {
  try {
    if (!existsSync(statePath)) return emptySwitchState();
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (!isRecord(raw)) {
      throw new Error("invalid state root");
    }
    return {
      persistentDisabled:
        readOptionalBoolean(raw.persistentDisabled, "persistentDisabled") ?? false,
      temporaryDisabledUntil: readOptionalStateString(
        raw.temporaryDisabledUntil,
        "temporaryDisabledUntil",
      ),
      currentSessionId: readOptionalStateString(
        raw.currentSessionId,
        "currentSessionId",
      ),
      disabledSessions: readDisabledSessions(raw.disabledSessions),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withSwitchStateReadError(message);
  }
}

export function writeCursorAgentSwitchState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function applyCursorAgentSwitchCommand(
  state,
  command,
  sessionId,
  now = new Date(),
) {
  const next = {
    persistentDisabled: state.persistentDisabled === true,
    temporaryDisabledUntil: state.temporaryDisabledUntil,
    currentSessionId: state.currentSessionId,
    disabledSessions: isRecord(state.disabledSessions)
      ? { ...state.disabledSessions }
      : {},
  };

  if (command.type === "on") {
    next.persistentDisabled = false;
    delete next.temporaryDisabledUntil;
    if (sessionId) delete next.disabledSessions[sessionId];
    return { state: next, message: "AgentNotify is on for Cursor Agent." };
  }

  if (command.type === "off-persist") {
    next.persistentDisabled = true;
    return {
      state: next,
      message: "AgentNotify is persistently muted for Cursor Agent.",
    };
  }

  if (command.type === "off-until") {
    next.temporaryDisabledUntil = command.until;
    return {
      state: next,
      message: `AgentNotify is muted for Cursor Agent until ${command.until}.`,
    };
  }

  if (command.type === "clear-sessions") {
    next.disabledSessions = {};
    return {
      state: next,
      message: "AgentNotify session mutes are cleared for Cursor Agent.",
    };
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
    return {
      state: next,
      message: "AgentNotify is muted for this Cursor Agent session.",
    };
  }

  return { state: next, message: command.message ?? "Invalid AgentNotify command." };
}

export function getCursorAgentMuteReason(state, sessionId, now = new Date()) {
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

function getCursorAgentStatusMessage(state, sessionId, now = new Date()) {
  const muted = getCursorAgentMuteReason(state, sessionId, now);
  if (muted === "persistent") {
    return "AgentNotify is persistently muted for Cursor Agent.";
  }
  if (muted === "timed") {
    return `AgentNotify is muted for Cursor Agent until ${state.temporaryDisabledUntil}.`;
  }
  if (muted === "session") {
    return "AgentNotify is muted for this Cursor Agent session.";
  }
  return "AgentNotify is on for Cursor Agent.";
}

export function parseCursorAgentConfig(raw) {
  return {
    serverUrl: readRequiredString(raw, "serverUrl"),
    token: readRequiredString(raw, "token"),
    timeoutMs: readOptionalNumber(raw, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    debugLogPath: readOptionalString(raw, "debugLogPath"),
  };
}

function readAgentNotifyConfig() {
  const configPath = join(homedir(), ".config", "agent-notify", "cursor-agent.json");
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  return parseCursorAgentConfig(raw);
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

export function cursorHookResponse(raw) {
  return normalizeCursorHookEvent(raw) === "beforeSubmitPrompt"
    ? { continue: true }
    : {};
}

export async function handleCursorAgentEvent(config, raw, deps = {}) {
  const now = deps.now ?? new Date();
  const statePath = deps.statePath ?? getCursorAgentSwitchStatePath();
  const summaryPath = deps.summaryPath ?? getCursorSummaryPath();
  const readState = deps.readState ?? readCursorAgentSwitchState;
  const writeState = deps.writeState ?? writeCursorAgentSwitchState;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hookEventName = normalizeCursorHookEvent(raw);
  const sessionId = getCursorSessionId(raw);
  let state;
  let debug;
  try {
    state = readState(statePath);
    if (typeof state?.readError === "string") {
      debug = { switchStateReadError: state.readError };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = emptySwitchState();
    debug = { switchStateReadError: `state-read: ${message}` };
  }

  if (hookEventName === "afterAgentResponse") {
    rememberCursorSummary(summaryPath, sessionId, getString(isRecord(raw) ? raw.text : undefined), now);
    return { forwarded: false, sent: false, cached: true, ...(debug ? { debug } : {}) };
  }

  const command = parseAgentNotifyCommand(getPrompt(raw), now);

  if (hookEventName === "beforeSubmitPrompt" && command.type !== "none") {
    if (command.type === "status") {
      const nextState = sessionId ? { ...state, currentSessionId: sessionId } : state;
      if (sessionId && !debug) {
        try {
          writeState(statePath, nextState);
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
        message: getCursorAgentStatusMessage(state, sessionId, now),
        ...(debug ? { debug } : {}),
      };
    }
    const result = applyCursorAgentSwitchCommand(state, command, sessionId, now);
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

  const forwarded = shouldForwardCursorAgentEvent(raw);
  if (!forwarded) return { forwarded: false, sent: false };

  const muted = getCursorAgentMuteReason(state, sessionId, now);
  if (muted) {
    return { forwarded: true, sent: false, muted, ...(debug ? { debug } : {}) };
  }

  const payload = enrichCursorAgentRaw(raw, summaryPath);
  const sent = await sendCursorAgentEvent(
    config.serverUrl,
    config.token,
    config.timeoutMs,
    payload,
    fetchImpl,
  );
  return { forwarded: true, sent, ...(debug ? { debug } : {}) };
}

function writeCursorHookResponse(raw) {
  try {
    process.stdout.write(`${JSON.stringify(cursorHookResponse(raw))}\n`);
  } catch {
    // Fail-safe: Cursor must never be blocked by adapter stdout errors.
  }
}

async function main() {
  let config;
  let raw;
  try {
    raw = JSON.parse(await readStdin());
  } catch {
    writeCursorHookResponse(undefined);
    return;
  }

  try {
    config = readAgentNotifyConfig();
  } catch {
    writeCursorHookResponse(raw);
    return;
  }

  const result = await handleCursorAgentEvent(config, raw);
  writeDebugLog(config, raw, result.forwarded, result.sent, result.debug);
  writeCursorHookResponse(raw);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
