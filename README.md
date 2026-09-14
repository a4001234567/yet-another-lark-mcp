# Yet Another Lark MCP

Personal MCP server for Lark/Feishu — calendar, tasks, messaging, docs, and people search.

Runs as a stdio process. Connect it to Claude Code, Claude Desktop, Cursor, Zed, or any MCP-compatible client.

→ **[Installation guide](INSTALL.md)**

---

## What makes this different

The Lark/Feishu open platform exposes hundreds of raw API endpoints. Most existing tools just re-wrap them one-to-one. This server **streamlines the interface for single-person use**, and ships with skill files that teach the AI model how to use it — closing the gap between "has the tool" and "actually uses it well".

### Three usage tiers

You can adopt as much or as little as you need:

| Tier | What you get | Auth required |
|---|---|---|
| **Send-only** | Send messages, search people. Use the AI as a Feishu notification bot. | App Token only (no OAuth) |
| **Interactive** | Full watch loop: receive messages, handle card callbacks, run cron schedules. The AI becomes a personal assistant reachable in Feishu. | App Token only |
| **Full** | Everything above plus calendar, tasks, and document read/write. | OAuth (device flow, guided) |

Each tier is a strict superset of the previous — start small, add OAuth when you need it.

### Highlights

- **Runs anywhere MCP runs.** Stdio transport: Claude Code, Claude Desktop, Cursor, Zed, or any other MCP client.
- **Watch loop.** `feishu_im_watch` surfaces messages, card callbacks, and cron schedules through one blocking call. No webhooks, no polling, no sidecar process.
- **Multiple card types.** Confirm/cancel dialogs, multi-field input forms (with password/hidden fields), and live-updating progress trackers. The AI can ask questions or request approval without leaving Feishu.
- **Skill files included.** SKILL.md files for each module expose as MCP prompts — inject them to give the model domain context on demand.
- **OAuth on demand.** When user auth is needed, the server sends an auth card to the owner in Feishu automatically. No manual token steps.
- **Token-efficient output.** Responses are formatted to be compact — IDs are compressed, recurring events are grouped, cancelled entries are filtered. Less noise for the model, fewer tokens per response.
- **Recurring event support.** The calendar API handles the full complexity of recurring events: search and list expand individual instances (not just templates). Patching or deleting a specific occurrence — for example, changing the location of next Tuesday's weekly standup without affecting any other date — automatically materialises that instance first, so only the target occurrence is modified, not the whole series.

**Known limitation:** Feishu Base (多维表格 / Bitable) editing is not supported.

---

## Tools

### Auth

| Tool | Description |
|---|---|
| `feishu_auth_status` | Check if authenticated and token is valid |
| `feishu_auth_init` | Start OAuth — blocks until authorized (up to 10 min). Sends an auth card in Feishu if open_id is known. |
| `feishu_auth_whoami` | Return the authenticated user's open_id and name |
| `feishu_auth_issue_token` | Issue a time-limited proxy token for third-party scripts to access the Feishu API without exposing the real user token |

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

### Comments

| Tool | Description |
|---|---|
| `feishu_doc_comment_list` | List comments on a document (filter by solved/whole, include reactions) |
| `feishu_doc_comment_get_replies` | Get replies for a comment |
| `feishu_doc_comment_add_whole` | Add a whole-document comment |
| `feishu_doc_comment_add_reply` | Add a reply to a comment (@mention optional) |
| `feishu_doc_comment_update_reply` | Update a reply |
| `feishu_doc_comment_delete_reply` | Delete a reply |
| `feishu_doc_comment_resolve` | Resolve / unresolve a comment |
| `feishu_doc_comment_reaction` | Add / remove an emoji reaction on a reply |

### Wiki

| Tool | Description |
|---|---|
| `feishu_wiki_list_spaces` | List wiki spaces (user token) |
| `feishu_wiki_get_space_tenant` | Get wiki space info (tenant token) |
| `feishu_wiki_get_space_user` | Get wiki space info (user token) |
| `feishu_wiki_list_nodes_tenant` | List child nodes of a space or parent node |
| `feishu_wiki_get_node_tenant` | Get node info by node or document token |
| `feishu_wiki_create_node_tenant` | Create a node (docx/sheet/mindnote/bitable/file/slides) |
| `feishu_wiki_copy_node_tenant` | Copy a node to a new location |
| `feishu_wiki_move_node_tenant` | Move a node (same or cross space) |
| `feishu_wiki_update_title_tenant` | Update a node title |
| `feishu_wiki_create_space` | Create a knowledge space (user token) |
| `feishu_wiki_add_member` | Add a member or admin to a space |
| `feishu_wiki_list_members_tenant` | List space members (tenant token) |
| `feishu_wiki_list_members_user` | List space members (user token) |

### AI HOT

| Tool | Description |
|---|---|
| `aihot_daily` | Get the latest (or a specific date's) AI daily digest; optional card format |
| `aihot_dailies` | List available daily digest dates |
| `aihot_items` | Query AI news items (category / keyword / time window) |

### Remote Machines

| Tool | Description |
|---|---|
| `win_exec` | Execute a command on the remote Windows machine (frp tunnel, port 2226) |
| `pi_exec` | Execute a command on the remote Raspberry Pi 5 (frp tunnel, port 2227) |

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

- **Do not run a separate `start-watch` process alongside this MCP server.** Lark delivers each event to only one connected WebSocket. A standalone watch process would split events with the server, causing randomly lost messages (some go to the background process the model can't see). If the watch loop runs through the MCP server directly, kill any standalone `start-watch` processes — remove the file too if needed.
- `feishu_calendar_list` time range is capped at 40 days by the Lark `instance_view` API
- `feishu_doc_search` requires user auth (not available with app token only)
- `feishu_doc_fetch` plain-text output omits inline equation content

---

## License

MIT — see [LICENSE](LICENSE).
