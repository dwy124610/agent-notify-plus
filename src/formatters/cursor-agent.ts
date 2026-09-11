import type { IncomingAgentEvent } from "../core/incoming-event.js";
import {
  EventFormatError,
  type FormattedAgentEvent,
} from "../core/formatted-event.js";
import {
  defaultNotificationLanguage,
  type NotificationLanguage,
} from "../core/language.js";
import { prefixTitleWithProject } from "./project-title.js";

const MAX_BODY_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 280;
const CURSOR_AGENT_ICON_URL = "https://www.cursor.com/apple-touch-icon.png";

type UnknownRecord = Record<string, unknown>;

export interface FormatterOptions {
  language?: NotificationLanguage;
  cwd?: string;
}

function languageFromOptions(options?: FormatterOptions): NotificationLanguage {
  return options?.language ?? defaultNotificationLanguage;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = MAX_BODY_LENGTH): string {
  const text = oneLine(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function requireRawRecord(raw: unknown): UnknownRecord {
  if (!isRecord(raw)) {
    throw new EventFormatError("Cursor Agent raw payload must be an object");
  }
  return raw;
}

export function normalizeCursorHookEvent(value: unknown): string | undefined {
  const name = getString(value);
  if (!name) return undefined;
  const aliases: Record<string, string> = {
    beforesubmitprompt: "beforeSubmitPrompt",
    userpromptsubmit: "beforeSubmitPrompt",
    stop: "stop",
    afteragentresponse: "afterAgentResponse",
    agentresponse: "afterAgentResponse",
    sessionend: "sessionEnd",
  };
  return aliases[name.toLowerCase()] ?? name;
}

function requireHookEvent(raw: UnknownRecord): string {
  const hookEvent = normalizeCursorHookEvent(raw.hook_event_name);
  if (!hookEvent) {
    throw new EventFormatError("Cursor Agent raw payload is missing hook_event_name");
  }
  return hookEvent;
}

function sessionId(raw: UnknownRecord): string | undefined {
  return getString(raw.session_id) ?? getString(raw.conversation_id);
}

function stopStatus(raw: UnknownRecord): string {
  return (getString(raw.status) ?? getString(raw.reason) ?? "completed").toLowerCase();
}

function completedTitle(language: NotificationLanguage): string {
  return language === "zh" ? "待审阅" : "Ready to review";
}

function completedFallback(language: NotificationLanguage): string {
  return language === "zh" ? "看看结果或下一步" : "Review results or next steps";
}

function failedTitle(language: NotificationLanguage): string {
  return language === "zh" ? "失败" : "Failed";
}

function failedFallback(language: NotificationLanguage): string {
  return language === "zh" ? "任务异常终止" : "Task failed";
}

function completionBody(raw: UnknownRecord, language: NotificationLanguage): string {
  return truncate(
    getString(raw.last_assistant_message) ??
      getString(raw.text) ??
      completedFallback(language),
    MAX_SUMMARY_LENGTH,
  );
}

function failureBody(raw: UnknownRecord, language: NotificationLanguage): string {
  return truncate(
    getString(raw.error_message) ??
      getString(raw.error) ??
      getString(raw.last_assistant_message) ??
      getString(raw.text) ??
      failedFallback(language),
    MAX_SUMMARY_LENGTH,
  );
}

function isFailureStatus(status: string): boolean {
  return status === "error" || status === "aborted";
}

export function formatCursorAgentEvent(
  event: IncomingAgentEvent,
  options?: FormatterOptions,
): FormattedAgentEvent {
  const language = languageFromOptions(options);
  const raw = requireRawRecord(event.raw);
  const sourceEvent = requireHookEvent(raw);
  const cwd =
    options?.cwd ??
    raw.cwd ??
    (Array.isArray(raw.workspace_roots) ? raw.workspace_roots[0] : undefined);
  const title = (value: string) => prefixTitleWithProject(value, cwd);

  if (sourceEvent === "stop") {
    const status = stopStatus(raw);
    if (isFailureStatus(status)) {
      return {
        agent: event.agent,
        kind: "failed",
        sourceEvent,
        sessionId: sessionId(raw),
        notification: {
          title: title(failedTitle(language)),
          body: failureBody(raw, language),
          urgency: "time_sensitive",
          group: "Cursor Agent",
          icon: CURSOR_AGENT_ICON_URL,
        },
      };
    }

    return {
      agent: event.agent,
      kind: "completed",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(completedTitle(language)),
        body: completionBody(raw, language),
        urgency: "time_sensitive",
        group: "Cursor Agent",
        icon: CURSOR_AGENT_ICON_URL,
      },
    };
  }

  throw new EventFormatError(`Unsupported Cursor Agent hook event: ${sourceEvent}`);
}
