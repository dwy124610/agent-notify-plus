import { describe, expect, it, vi } from "vitest";

const adapter = await import("../../examples/grok-build/grok-build-agent-notify.mjs");

describe("Grok Build adapter example", () => {
  it("forwards turn start, completion, failure, and cancel", () => {
    expect(
      adapter.shouldForwardGrokBuildEvent({ hook_event_name: "UserPromptSubmit" }),
    ).toBe(true);
    expect(
      adapter.shouldForwardGrokBuildEvent({
        hook_event_name: "Stop",
        reason: "end_turn",
      }),
    ).toBe(true);
    expect(
      adapter.shouldForwardGrokBuildEvent({ hook_event_name: "StopFailure" }),
    ).toBe(true);
    expect(
      adapter.shouldForwardGrokBuildEvent({
        hook_event_name: "StopCancelled",
        reason: "user_interrupt",
      }),
    ).toBe(true);
  });

  it("skips subagent turns and session-end Stop fires", () => {
    expect(
      adapter.shouldForwardGrokBuildEvent({
        hook_event_name: "Stop",
        reason: "end_turn",
        subagentType: "explore",
      }),
    ).toBe(false);
    expect(
      adapter.shouldForwardGrokBuildEvent({
        hook_event_name: "Stop",
        reason: "shutdown",
      }),
    ).toBe(false);
  });

  it("posts camelCase lastAssistantMessage as last_assistant_message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await adapter.handleGrokBuildEvent(
      {
        serverUrl: "http://127.0.0.1:8787",
        token: "secret",
        timeoutMs: 2_000,
      },
      {
        hookEventName: "stop",
        sessionId: "grok_session_9",
        reason: "end_turn",
        lastAssistantMessage: "Grok Build finished the requested change.",
      },
      { fetchImpl: fetchMock, statePath: "/tmp/agent-notify-grok-state.json" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.agent).toBe("grok-build");
    expect(body.raw.hook_event_name).toBe("Stop");
    expect(body.raw.last_assistant_message).toBe(
      "Grok Build finished the requested change.",
    );
  });
});
