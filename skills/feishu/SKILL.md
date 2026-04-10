---
name: lark-mcp-guide
description: |
  Overview of the personal Lark MCP server: key concepts, identifiers, authentication, and all tool modules.

  Use this skill when:
  (1) You are starting a new session and need orientation on what tools are available
  (2) User asks what this MCP server can do
  (3) You are unsure which module to use for a task
  (4) You need to look up how identifiers (open_id, chat_id, message_id) work
  (5) You need to know which tools require authentication
---

# Lark MCP Guide

This is a **personal** Lark/Feishu MCP server — built for single-user use by the owner of the Feishu app. All tools act on behalf of that one person; there is no multi-tenant or enterprise context.

---

## Key Concepts

### Identifiers

- **open_id** (`ou_xxx`) — identifies a Feishu user. Get yours with `feishu_auth_whoami`, or via `feishu_people_search` with your own name (no authentication needed).
- **chat_id** (`oc_xxx`) — identifies a conversation. Returned by `feishu_im_send`; also carried by incoming message events in the watch loop.
- **message_id** (`om_xxx`) — identifies a single message. Returned by send/reply tools. Needed for threading replies or editing a sent message.

### Authentication

Tools that act on behalf of the user — including calendar, tasks, and docs — require authentication. All other tools work without authentication unless otherwise specified.

**Auth flow:** Call `feishu_auth_init` — it blocks until authorized (up to 5 min) then returns. Either a card is sent for auth, or when the receiver is unknown, a link is returned as text — the user can open it directly to authorize, or send any message to the bot to receive the auth card.

---

## Tool Modules

- **Messaging** (`feishu_im_*`) — send, reply to, read, and search messages in Feishu chats.
- **Interactive Cards** (`feishu_im_send_confirm/form/progress`) — send cards that integrate user interaction; strongly recommended for confirmations, user forms, and progress tracking.
- **Calendar** (`feishu_calendar_*`) — create, list, edit, and delete personal calendar events. Requires auth.
- **Tasks** (`feishu_task_*`) — create and manage personal tasks and task lists. Requires auth.
- **Documents** (`feishu_doc_*`) — Managing/Editing Feishu docs. Requires authentication.
- **People** (`feishu_people_search`) — resolve a person's name to their `open_id`.
- **Auth** (`feishu_auth_*`) — authenticate with `feishu_auth_init`, check status with `feishu_auth_status`, get user's identity with `feishu_auth_whoami`.
- **Watch Loop** (`feishu_im_watch`, `feishu_schedule_*`) — autonomous loop that waits for messages, card callbacks, or scheduled reminders. See the **feishu-watch-loop** skill for behavioural rules.
