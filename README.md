# lark-mcp-server

Personal MCP server for Lark/Feishu — calendar, tasks, messaging, docs, and people search.

Runs as a stdio process. Connect it to Claude Code, Claude Desktop, Cursor, Zed, or any MCP-compatible client.

→ **[Installation guide](INSTALL.md)**

---

## Why this one?

Most Lark/Feishu integrations are enterprise plugins or read-only bots. This server is built for a single personal account and prioritizes autonomous AI use:

- **Watch loop** — `feishu_im_watch` blocks until a message, card callback, or scheduled reminder arrives. One tool call drives the entire event loop; no polling, no webhooks to configure.
- **Interactive cards** — confirm dialogs, input forms, and live-updating progress trackers. The AI can ask clarifying questions or request confirmation without leaving Feishu.
- **Scheduled reminders** — cron-style schedules fire inside the watch loop. Works without a separate process or cron daemon.
- **OAuth on demand** — calendar, tasks, and docs require user authorization. When credentials are missing, the server sends an auth card to the owner in Feishu automatically — no manual token management.
- **No external dependencies** — stdlib only beyond the Lark SDK and MCP SDK. No database, no Redis, no persistent process beyond the stdio server itself.

This is a personal productivity tool, not enterprise middleware. It won't scale to multiple users, but it gives one person full programmatic access to their Lark workspace from any AI assistant.

---

## Tools

### Auth

| Tool | Description |
|---|---|
| `feishu_auth_status` | Check if authenticated and token is valid |
| `feishu_auth_init` | Start OAuth — blocks until authorized (up to 10 min). Sends an auth card in Feishu if open_id is known. |
| `feishu_auth_whoami` | Return the authenticated user's open_id and name |

### People

| Tool | Description |
|---|---|
| `feishu_people_search` | Search users by name → returns open_id for use in other tools |

### Calendar

| Tool | Description |
|---|---|
| `feishu_calendar_create` | Create event (supports reminders, location, RRule recurrence) |
| `feishu_calendar_list` | List or search events; default range is this week Mon – next week Sun |
| `feishu_calendar_patch` | Update event fields; handles recurring instance materialisation |
| `feishu_calendar_delete` | Delete event; handles recurring instance materialisation |

### Tasks

| Tool | Description |
|---|---|
| `feishu_task_create` | Create task (auto-assigned to you) |
| `feishu_task_list` | List My Tasks, or tasks in a specific tasklist |
| `feishu_task_patch` | Update task: title, due date, completion, assignee |
| `feishu_task_delete` | Delete task |
| `feishu_task_list_lists` | List all tasklists |
| `feishu_task_create_list` | Create a tasklist |
| `feishu_task_patch_list` | Rename a tasklist |
| `feishu_task_delete_list` | Delete a tasklist |

### Messaging (IM)

| Tool | Description |
|---|---|
| `feishu_im_send` | Send text, rich-text post, interactive card, or file/image. Accepts open_id, chat_id, or message_id (for replies). |
| `feishu_im_read` | Read recent messages from a chat |
| `feishu_im_search` | Search messages by keyword |
| `feishu_im_fetch_resource` | Download a file or image from a message to a local path |
| `feishu_im_patch` | Edit an existing message |
| `feishu_im_watch` | Block until a new message, card callback, or schedule fires |

### Interactive Cards

| Tool | Description |
|---|---|
| `feishu_im_send_confirm` | Send a confirm/cancel dialog; optionally block until clicked |
| `feishu_im_send_form` | Send a form card with typed fields (supports hidden/password inputs) |
| `feishu_im_send_progress` | Send a multi-step progress tracker card |
| `feishu_im_patch_progress` | Advance the progress card to the next step |

### Schedules

| Tool | Description |
|---|---|
| `feishu_schedule_create` | Create a one-shot or recurring (cron) reminder that fires in the watch loop |
| `feishu_schedule_list` | List pending schedules |
| `feishu_schedule_delete` | Delete a schedule |

### Docs

| Tool | Description |
|---|---|
| `feishu_doc_search` | Search documents and wiki pages by keyword |
| `feishu_doc_fetch` | Fetch document content (plain text + block list with IDs) |
| `feishu_doc_create` | Create a new document |
| `feishu_doc_append` | Append a block (paragraph, heading, bullet, code, callout, image…) |
| `feishu_doc_patch` | Edit or replace an existing block |
| `feishu_doc_delete` | Delete a block |
| `feishu_doc_delete_file` | Permanently delete an entire document from Drive |

---

## Skills (MCP prompts)

The server exposes SKILL.md files as MCP prompts. Inject them into context with `/mcp__lark__feishu-calendar` or via your client's prompt picker.

| Prompt | Description |
|---|---|
| `lark-mcp-guide` | Overview: key concepts, identifiers, auth, all tool modules |
| `feishu-calendar` | Calendar: create, list, patch, delete |
| `feishu-task` | Tasks: create, list, patch, delete, tasklists |
| `feishu-people` | User search and open_id resolution |
| `feishu-im` | Messaging: send, reply, read, search, files, edit |
| `feishu-interactive-cards` | Confirm dialogs, forms, progress tracker cards |
| `feishu-watch-loop` | Autonomous watch-loop rules and patterns |
| `feishu-doc` | Documents: create, fetch, append, edit, delete, search |

---

## Known limitations

- `feishu_calendar_list` time range is capped at 40 days by the Lark `instance_view` API
- `feishu_doc_search` requires user auth (not available with app token only)
- `feishu_doc_fetch` plain-text output omits inline equation content

---

## License

MIT — see [LICENSE](LICENSE).
