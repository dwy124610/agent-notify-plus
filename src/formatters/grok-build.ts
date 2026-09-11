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
const GROK_BUILD_ICON_URL = "https://grok.com/apple-touch-icon.png";

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
    throw new EventFormatError("Grok Build raw payload must be an object");
  }
  return raw;
}

export function normalizeGrokBuildHookEvent(value: unknown): string | undefined {
  const name = getString(value);
  if (!name) return undefined;
  const aliases: Record<string, string> = {
    userpromptsubmit: "UserPromptSubmit",
    stop: "Stop",
    stopfailure: "StopFailure",
    stopcancelled: "StopCancelled",
  };
  return aliases[name.replace(/_/g, "").toLowerCase()] ?? name;
}

function requireHookEvent(raw: UnknownRecord): string {
  const hookEvent =
    normalizeGrokBuildHookEvent(raw.hook_event_name) ??
    normalizeGrokBuildHookEvent(raw.hookEventName);
  if (!hookEvent) {
    throw new EventFormatError("Grok Build raw payload is missing hook_event_name");
  }
  return hookEvent;
}

function sessionId(raw: UnknownRecord): string | undefined {
  return getString(raw.session_id) ?? getString(raw.sessionId);
}

function lastAssistantMessage(raw: UnknownRecord): string | undefined {
  return getString(raw.last_assistant_message) ?? getString(raw.lastAssistantMessage);
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
  return truncate(lastAssistantMessage(raw) ?? completedFallback(language), MAX_SUMMARY_LENGTH);
}

function cancelledReasonLabel(
  reason: string | undefined,
  language: NotificationLanguage,
): string | undefined {
  if (!reason) return undefined;
  if (reason === "user_interrupt") {
    return language === "zh" ? "用户中断" : "Interrupted by user";
  }
  if (reason === "permission_rejected" || reason === "permission_cancelled") {
    return language === "zh" ? "权限被拒绝" : "Permission declined";
  }
  return undefined;
}

function failureBody(raw: UnknownRecord, language: NotificationLanguage): string {
  return truncate(
    getString(raw.errorDetails) ??
      getString(raw.error_details) ??
      getString(raw.reasonDetails) ??
      getString(raw.reason_details) ??
      lastAssistantMessage(raw) ??
      getString(raw.error) ??
      cancelledReasonLabel(getString(raw.reason), language) ??
      failedFallback(language),
    MAX_SUMMARY_LENGTH,
  );
}

export function formatGrokBuildEvent(
  event: IncomingAgentEvent,
  options?: FormatterOptions,
): FormattedAgentEvent {
  const language = languageFromOptions(options);
  const raw = requireRawRecord(event.raw);
  const sourceEvent = requireHookEvent(raw);
  const cwd = options?.cwd ?? raw.cwd ?? raw.workspaceRoot;
  const title = (value: string) => prefixTitleWithProject(value, cwd);

  if (sourceEvent === "Stop") {
    return {
      agent: event.agent,
      kind: "completed",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(completedTitle(language)),
        body: completionBody(raw, language),
        urgency: "time_sensitive",
        group: "Grok Build",
        icon: GROK_BUILD_ICON_URL,
      },
    };
  }

  if (sourceEvent === "StopFailure" || sourceEvent === "StopCancelled") {
    return {
      agent: event.agent,
      kind: "failed",
      sourceEvent,
      sessionId: sessionId(raw),
      notification: {
        title: title(failedTitle(language)),
        body: failureBody(raw, language),
        urgency: "time_sensitive",
        group: "Grok Build",
        icon: GROK_BUILD_ICON_URL,
      },
    };
  }

  throw new EventFormatError(`Unsupported Grok Build hook event: ${sourceEvent}`);
}
