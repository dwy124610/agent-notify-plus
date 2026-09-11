---
name: agent-notify
description: "Handle explicit AgentNotify control commands in Grok Build."
---

# AgentNotify Grok Build Command

You are handling an AgentNotify notification switch command inside Grok Build.

The Grok Build AgentNotify hook adapter handles the local side effects when the
prompt is submitted:

- It writes `~/.config/agent-notify/state/grok-build.json`.
- It mutes or unmutes forwarding to the AgentNotify server.
- It keeps AgentNotify server behavior unchanged.

Do not call the AgentNotify server. Do not edit project files. Do not rewrite
the state file unless the user explicitly asks for manual repair.

## Command Forms

Only treat the message as an AgentNotify command when it exactly matches one of
the supported command forms below.

Supported commands:

- no arguments, equivalent to `status`
- `clear`
- `off`
- `off <duration>`, where duration uses `s`, `m`, `h`, or `d`
- `off persist`
- `on`
- `status`

Use these templates:

- `clear`: `AgentNotify: Grok Build 会话静音记录已清除。`
- `off`: `AgentNotify: Grok Build 当前会话通知已关闭。`
- `off <duration>`: `AgentNotify: Grok Build 通知已关闭，持续 <duration>。`
- `off persist`: `AgentNotify: Grok Build 通知已持久关闭。`
- `on`: `AgentNotify: Grok Build 通知已开启。`
