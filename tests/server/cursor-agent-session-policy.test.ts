import { describe, expect, it } from "vitest";
import { CursorAgentSessionPolicy } from "../../src/server/cursor-agent-session-policy.js";

function cursorEvent(
  hook_event_name: string,
  extra: Record<string, unknown> = {},
  session_id = "session_1",
) {
  return {
    agent: "cursor-agent" as const,
    raw: { hook_event_name, conversation_id: session_id, ...extra },
  };
}

describe("CursorAgentSessionPolicy", () => {
  it("records beforeSubmitPrompt without continuing to formatter", () => {
    const policy = new CursorAgentSessionPolicy({
      completionMinSeconds: 120,
      nowMs: () => 1_000,
    });

    expect(policy.apply(cursorEvent("beforeSubmitPrompt"), "macbook")).toEqual({
      action: "suppress",
      reason: "state_recorded",
      sourceEvent: "beforeSubmitPrompt",
      sessionId: "session_1",
    });
    expect(policy.sessionCount()).toBe(1);
  });

  it("continues completed stop after threshold", () => {
    let nowMs = 1_000;
    const policy = new CursorAgentSessionPolicy({
      completionMinSeconds: 5,
      nowMs: () => nowMs,
    });

    policy.apply(cursorEvent("beforeSubmitPrompt"), "macbook");
    nowMs += 6_000;

    expect(policy.apply(cursorEvent("stop", { status: "completed" }), "macbook")).toEqual({
      action: "continue",
    });
    expect(policy.sessionCount()).toBe(0);
  });

  it("continues aborted stop without the completion threshold", () => {
    const policy = new CursorAgentSessionPolicy({
      completionMinSeconds: 120,
      nowMs: () => 1_000,
    });

    policy.apply(cursorEvent("beforeSubmitPrompt"), "macbook");

    expect(policy.apply(cursorEvent("stop", { status: "aborted" }), "macbook")).toEqual({
      action: "continue",
    });
    expect(policy.sessionCount()).toBe(0);
  });
});
