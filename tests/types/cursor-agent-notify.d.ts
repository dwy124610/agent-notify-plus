declare module "*cursor-agent/cursor-agent-notify.mjs" {
  export interface CursorAgentConfig {
    serverUrl: string;
    token: string;
    timeoutMs: number;
    debugLogPath?: string;
  }
  export type AgentNotifyCommand =
    | { type: "none" }
    | { type: "on" }
    | { type: "status" }
    | { type: "clear-sessions" }
    | { type: "off-session" }
    | { type: "off-persist" }
    | { type: "off-until"; until: string }
    | { type: "invalid"; message: string };
  export interface AgentNotifySwitchState {
    persistentDisabled: boolean;
    temporaryDisabledUntil?: string;
    currentSessionId?: string;
    disabledSessions: Record<string, { disabledAt: string }>;
    readError?: string;
  }
  export function parseCursorAgentConfig(raw: Record<string, unknown>): CursorAgentConfig;
  export function normalizeCursorHookEvent(raw: unknown): string | undefined;
  export function getCursorSessionId(raw: unknown): string | undefined;
  export function shouldForwardCursorAgentEvent(raw: unknown): boolean;
  export function summarizeCursorAgentEventForDebug(raw: unknown): Record<string, unknown>;
  export function rememberCursorSummary(
    summaryPath: string,
    sessionId: string | undefined,
    text: string | undefined,
    now?: Date,
  ): void;
  export function consumeCursorSummary(
    summaryPath: string,
    sessionId: string | undefined,
  ): string | undefined;
  export function enrichCursorAgentRaw(raw: unknown, summaryPath: string): unknown;
  export function sendCursorAgentEvent(
    serverUrl: string,
    token: string,
    timeoutMs: number,
    raw: unknown,
    fetchImpl?: typeof fetch,
  ): Promise<boolean>;
  export function parseAgentNotifyCommand(
    prompt: unknown,
    now?: Date,
  ): AgentNotifyCommand;
  export function getCursorAgentSwitchStatePath(home?: string): string;
  export function getCursorSummaryPath(home?: string): string;
  export function readCursorAgentSwitchState(statePath: string): AgentNotifySwitchState;
  export function writeCursorAgentSwitchState(
    statePath: string,
    state: AgentNotifySwitchState,
  ): void;
  export function applyCursorAgentSwitchCommand(
    state: AgentNotifySwitchState,
    command: AgentNotifyCommand,
    sessionId?: string,
    now?: Date,
  ): { state: AgentNotifySwitchState; message: string };
  export function getCursorAgentMuteReason(
    state: AgentNotifySwitchState,
    sessionId?: string,
    now?: Date,
  ): "persistent" | "timed" | "session" | undefined;
  export function cursorHookResponse(raw: unknown): Record<string, unknown>;
  export function handleCursorAgentEvent(
    config: CursorAgentConfig,
    raw: unknown,
    deps?: {
      fetchImpl?: typeof fetch;
      now?: Date;
      statePath?: string;
      summaryPath?: string;
      readState?: (statePath: string) => AgentNotifySwitchState;
      writeState?: (statePath: string, state: AgentNotifySwitchState) => void;
    },
  ): Promise<Record<string, unknown>>;
}
