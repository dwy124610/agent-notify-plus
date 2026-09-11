import { describe, expect, it } from "vitest";
import { formatIncomingEvent } from "../../src/formatters/index.js";
import { formatCursorAgentEvent } from "../../src/formatters/cursor-agent.js";

describe("Cursor Agent formatter", () => {
  it("formats stop using last_assistant_message", () => {
    const formatted = formatCursorAgentEvent({
      agent: "cursor-agent",
      raw: {
        hook_event_name: "stop",
        conversation_id: "cursor_session_1",
        status: "completed",
        cwd: "/Users/1874w/@1874/agent-notify",
        last_assistant_message: "Added Cursor Agent completion notifications.",
      },
    });

    expect(formatted).toMatchObject({
      agent: "cursor-agent",
      kind: "completed",
      sourceEvent: "stop",
      sessionId: "cursor_session_1",
      notification: {
        title: "agent-notify Ready to review",
        body: "Added Cursor Agent completion notifications.",
        urgency: "time_sensitive",
        group: "Cursor Agent",
      },
    });
  });

  it("formats aborted stop as a failed notification", () => {
    const formatted = formatCursorAgentEvent(
      {
        agent: "cursor-agent",
        raw: {
          hook_event_name: "Stop",
          session_id: "cursor_session_2",
          status: "aborted",
          error_message: "User stopped the agent",
        },
      },
      { language: "zh" },
    );

    expect(formatted.kind).toBe("failed");
    expect(formatted.notification.title).toBe("失败");
    expect(formatted.notification.body).toBe("User stopped the agent");
  });

  it("dispatches incoming events to the Cursor Agent formatter", () => {
    const formatted = formatIncomingEvent({
      agent: "cursor-agent",
      raw: {
        hook_event_name: "stop",
        conversation_id: "cursor_session_3",
        last_assistant_message: "done",
      },
    });

    expect(formatted.kind).toBe("completed");
    expect(formatted.notification.group).toBe("Cursor Agent");
  });
});
