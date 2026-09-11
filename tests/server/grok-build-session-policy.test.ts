import { describe, expect, it } from "vitest";
import { GrokBuildSessionPolicy } from "../../src/server/grok-build-session-policy.js";

function grokEvent(hook_event_name: string, extra: Record<string, unknown> = {}) {
  return {
    agent: "grok-build" as const,
    raw: { hook_event_name, sessionId: "session_1", ...extra },
  };
}

describe("GrokBuildSessionPolicy", () => {
  it("records UserPromptSubmit without continuing to formatter", () => {
    const policy = new GrokBuildSessionPolicy({
      completionMinSeconds: 120,
      nowMs: () => 1_000,
    });

    expect(policy.apply(grokEvent("UserPromptSubmit"), "macbook")).toEqual({
      action: "suppress",
      reason: "state_recorded",
      sourceEvent: "UserPromptSubmit",
      sessionId: "session_1",
    });
    expect(policy.sessionCount()).toBe(1);
  });

  it("continues Stop after threshold", () => {
    let nowMs = 1_000;
    const policy = new GrokBuildSessionPolicy({
      completionMinSeconds: 5,
      nowMs: () => nowMs,
    });

    policy.apply(grokEvent("UserPromptSubmit"), "macbook");
    nowMs += 6_000;

    expect(policy.apply(grokEvent("Stop", { reason: "end_turn" }), "macbook")).toEqual({
      action: "continue",
    });
    expect(policy.sessionCount()).toBe(0);
  });

  it("continues StopCancelled without the completion threshold", () => {
    const policy = new GrokBuildSessionPolicy({
      completionMinSeconds: 120,
      nowMs: () => 1_000,
    });

    policy.apply(grokEvent("UserPromptSubmit"), "macbook");

    expect(policy.apply(grokEvent("StopCancelled", { reason: "user_interrupt" }), "macbook")).toEqual({
      action: "continue",
    });
    expect(policy.sessionCount()).toBe(0);
  });
});
