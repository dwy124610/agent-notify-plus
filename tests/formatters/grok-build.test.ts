import { describe, expect, it } from "vitest";
import { formatIncomingEvent } from "../../src/formatters/index.js";
import { formatGrokBuildEvent } from "../../src/formatters/grok-build.js";

describe("Grok Build formatter", () => {
  it("formats Stop using lastAssistantMessage", () => {
    const formatted = formatGrokBuildEvent({
      agent: "grok-build",
      raw: {
        hook_event_name: "Stop",
        sessionId: "grok_session_1",
        cwd: "/Users/1874w/@1874/agent-notify",
        reason: "end_turn",
        lastAssistantMessage: "Added Grok Build completion notifications.",
      },
    });

    expect(formatted).toMatchObject({
      agent: "grok-build",
      kind: "completed",
      sourceEvent: "Stop",
      sessionId: "grok_session_1",
      notification: {
        title: "agent-notify Ready to review",
        body: "Added Grok Build completion notifications.",
        group: "Grok Build",
      },
    });
  });

  it("formats StopCancelled as a failed notification", () => {
    const formatted = formatGrokBuildEvent(
      {
        agent: "grok-build",
        raw: {
          hookEventName: "stop_cancelled",
          session_id: "grok_session_2",
          reason: "user_interrupt",
          lastAssistantMessage: "Interrupted mid-task",
        },
      },
      { language: "zh" },
    );

    expect(formatted.kind).toBe("failed");
    expect(formatted.sourceEvent).toBe("StopCancelled");
    expect(formatted.notification.title).toBe("失败");
    expect(formatted.notification.body).toBe("Interrupted mid-task");
  });

  it("dispatches incoming events to the Grok Build formatter", () => {
    const formatted = formatIncomingEvent({
      agent: "grok-build",
      raw: {
        hook_event_name: "StopFailure",
        sessionId: "grok_session_3",
        errorDetails: "rate limited",
      },
    });

    expect(formatted.kind).toBe("failed");
    expect(formatted.notification.group).toBe("Grok Build");
    expect(formatted.notification.body).toBe("rate limited");
  });
});
