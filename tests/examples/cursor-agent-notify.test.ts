import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const adapter = await import("../../examples/cursor-agent/cursor-agent-notify.mjs");

describe("Cursor Agent adapter example", () => {
  it("forwards start and stop events and caches afterAgentResponse locally", () => {
    expect(
      adapter.shouldForwardCursorAgentEvent({
        hook_event_name: "beforeSubmitPrompt",
      }),
    ).toBe(true);
    expect(
      adapter.shouldForwardCursorAgentEvent({
        hook_event_name: "stop",
      }),
    ).toBe(true);
    expect(
      adapter.shouldForwardCursorAgentEvent({
        hook_event_name: "afterAgentResponse",
      }),
    ).toBe(false);
  });

  it("returns continue for beforeSubmitPrompt so Cursor is not blocked", () => {
    expect(
      adapter.cursorHookResponse({ hook_event_name: "beforeSubmitPrompt" }),
    ).toEqual({ continue: true });
    expect(adapter.cursorHookResponse({ hook_event_name: "stop" })).toEqual({});
  });

  it("attaches the cached assistant summary onto stop payloads", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-notify-cursor-"));
    const summaryPath = join(tmp, "summaries.json");
    const statePath = join(tmp, "state.json");
    writeFileSync(statePath, JSON.stringify({ persistentDisabled: false, disabledSessions: {} }));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await adapter.handleCursorAgentEvent(
      {
        serverUrl: "http://127.0.0.1:8787",
        token: "secret",
        timeoutMs: 2_000,
      },
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: "cursor_session_9",
        text: "Wired Cursor stop hooks and included the final summary.",
      },
      { summaryPath, statePath, fetchImpl: fetchMock },
    );

    await adapter.handleCursorAgentEvent(
      {
        serverUrl: "http://127.0.0.1:8787",
        token: "secret",
        timeoutMs: 2_000,
      },
      {
        hook_event_name: "stop",
        conversation_id: "cursor_session_9",
        status: "completed",
      },
      { summaryPath, statePath, fetchImpl: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.agent).toBe("cursor-agent");
    expect(body.raw.last_assistant_message).toBe(
      "Wired Cursor stop hooks and included the final summary.",
    );
  });
});
