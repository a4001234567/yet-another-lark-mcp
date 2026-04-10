# lark-mcp-server

Personal MCP server for Lark/Feishu — calendar, tasks, messaging, docs, and people search.

Runs as a stdio process. Any MCP-compatible client (Claude Desktop, Cursor, Zed, etc.) can connect to it.

**First-time setup:** Ask your AI assistant to read [SETUP.md](SETUP.md) and follow the steps interactively. It will walk you through app creation, credentials, MCP config, and the minimal `CLAUDE.md` snippet needed for autonomous watch-loop operation.

---

## Requirements

- Node.js 18+
- A Lark self-built app — create one at **https://open.feishu.cn/page/openclaw**

---

## Setup

```bash
cd lark-mcp-server
npm install
```

---

## Claude Code config

```bash
claude mcp add lark -- npx tsx /absolute/path/to/lark-mcp-server/src/index.ts
```

Then add env vars to `.claude/settings.json`:

**Optional: watch-loop recovery hook**

If you run Claude Code in autonomous watch-loop mode, install the included hook so Claude automatically recovers `feishu_im_watch` after context compaction:

```bash
mkdir -p ~/.claude/hooks
cp hooks/feishu-watch-recover.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/feishu-watch-recover.sh
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "~/.claude/hooks/feishu-watch-recover.sh" }]
    }]
  }
}
```

When context compaction occurs, the hook injects a reminder into Claude's context on the next session start, prompting it to re-establish the watch loop before handling anything else.

```json
{
  "mcpServers": {
    "lark": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/lark-mcp-server/src/index.ts"],
      "env": {
        "LARK_APP_ID": "cli_xxx",
        "LARK_APP_SECRET": "your_secret",
        "LARK_TIMEZONE": "Asia/Shanghai"
      }
    }
  }
}
```

**Load a skill** (injects usage guidance into context):

```
/mcp__lark__lark-mcp-guide
```

Available skills: `lark-mcp-guide` · `feishu-calendar` · `feishu-task` · `feishu-people` · `feishu-im` · `feishu-interactive-cards` · `feishu-watch-loop` · `feishu-doc`

---

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lark": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/lark-mcp-server/src/index.ts"],
      "env": {
        "LARK_APP_ID": "cli_xxx",
        "LARK_APP_SECRET": "your_secret",
        "LARK_TIMEZONE": "Asia/Shanghai"
      }
    }
  }
}
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `LARK_APP_ID` | Yes | — | App ID from Lark developer console (`cli_xxx`) |
| `LARK_APP_SECRET` | Yes | — | App secret |
| `LARK_TIMEZONE` | No | `Asia/Shanghai` | Timezone for date parsing and display |

---

## First-time authentication

On first use, call `feishu_auth_init`. It returns a `verification_url` and `user_code`, then polls automatically until you complete the browser flow (up to 10 minutes). No second call needed.

Token is saved to `~/.config/lark-mcp/tokens.json` and auto-refreshes before expiry.

---

## Tools

### Auth

| Tool | Description |
|---|---|
| `feishu_auth_status` | Check if authenticated and token is valid |
| `feishu_auth_init` | Start OAuth — blocks until authorized (up to 10 min). Sends an auth card in Feishu if open_id is known, otherwise returns the auth URL as text. |
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
| `feishu_im_send` | Send text, rich-text post, interactive card, or file/image. Use `reply_to` (message_id) to thread a reply. |
| `feishu_im_read` | Read recent messages from a chat |
| `feishu_im_search` | Search messages by keyword |
| `feishu_im_fetch_resource` | Download a file or image from a message to a local temp path |
| `feishu_im_patch` | Edit an existing message |
| `feishu_im_watch` | Block until a new message, card callback, or schedule fires — returns all three in one response |

### Interactive Cards

Cards sent by these tools update themselves inline after user interaction.

| Tool | Description |
|---|---|
| `feishu_im_send_confirm` | Send a confirm/cancel dialog card; `blocking=true` waits for click |
| `feishu_im_send_form` | Send a form card with typed fields (supports password/hidden inputs); `blocking=true` waits for submit |
| `feishu_im_send_progress` | Send a multi-step progress tracker card |
| `feishu_im_patch_progress` | Advance the progress card to the next step |

### Schedule (used inside watch loops)

| Tool | Description |
|---|---|
| `feishu_schedule_create` | Create a one-shot or recurring (cron) reminder that fires inside the watch loop |
| `feishu_schedule_list` | List pending schedules |
| `feishu_schedule_delete` | Delete a schedule |

### Docs

| Tool | Description |
|---|---|
| `feishu_doc_search` | Search documents and wiki pages by keyword |
| `feishu_doc_fetch` | Fetch document content (plain text + block list with IDs) |
| `feishu_doc_create` | Create a new document |
| `feishu_doc_append` | Append a block to a document (paragraph, heading, bullet, code, callout, image…) |
| `feishu_doc_patch` | Edit or replace an existing block |
| `feishu_doc_delete` | Delete a block |
| `feishu_doc_delete_file` | Permanently delete an entire doc (or file/sheet/bitable) from Drive |

---

## Prompts (skills)

The server exposes SKILL.md files as MCP prompts. Inject them into context with "use the feishu-calendar skill" or via your client's prompt picker.

| Prompt | Description |
|---|---|
| `lark-mcp-guide` | Overview: key concepts, identifiers, auth, all tool modules |
| `feishu-calendar` | Calendar operations: create, list, patch, delete |
| `feishu-task` | Task management: create, list, patch, delete, tasklists |
| `feishu-people` | User search and open_id resolution |
| `feishu-im` | Messaging: send (incl. threaded replies), read, search, files, attachments, edit |
| `feishu-interactive-cards` | Confirm dialogs, forms, progress tracker cards |
| `feishu-watch-loop` | Autonomous watch-loop rules: loop structure, Feishu replies, schedules |
| `feishu-doc` | Documents: create, fetch, append, edit, delete, search |

---

## OAuth scopes required

Configure these in your Lark app's **Security Settings → OAuth Scopes** and enable **User OAuth** (device flow).

**Calendar**
```
calendar:calendar:read
calendar:calendar.event:create  calendar:calendar.event:delete
calendar:calendar.event:read    calendar:calendar.event:reply
calendar:calendar.event:update  calendar:calendar.free_busy:read
```

**Tasks**
```
task:task:read  task:task:write  task:task:writeonly
task:tasklist:read  task:tasklist:write
```

**Docs**
```
docx:document:readonly  docx:document:create  docx:document:write_only
search:docs:read
space:document:delete  space:document:move  space:document:retrieve
drive:drive.metadata:readonly  drive:file:download  drive:file:upload
docs:document:export  docs:document.media:download  docs:document.media:upload  docs:document:copy
wiki:node:copy  wiki:node:create  wiki:node:move  wiki:node:read  wiki:node:retrieve
wiki:space:read  wiki:space:retrieve  wiki:space:write_only
```

**Always required**
```
offline_access
```

IM and people search use the App Token (TAT) — no OAuth scopes needed for those.

---

## Token storage

`~/.config/lark-mcp/tokens.json` — plain JSON, refreshed automatically 5 minutes before expiry.

---

## Logging

The server writes an append-only NDJSON log to `~/.config/lark-mcp/lark-mcp.log`.

Two event types are recorded:

```
{"ts":"2024-01-01T00:00:00.000Z","event":"message","from":"ou_xxx","chat_id":"oc_xxx","text":"hello"}
{"ts":"2024-01-01T00:00:00.000Z","event":"tool_call","tool":"feishu_im_send","params":{...},"ok":true,"ms":142}
```

**What is omitted / truncated:**

- Params `card`, `post_rows`, `image_path`, `file_path`, `file_name` are replaced with `"[omitted]"` (large or not useful to log)
- String param values longer than 200 characters are truncated with `…`
- Incoming messages are truncated to 300 characters

**Rotation:** When `lark-mcp.log` reaches 5 MB it is renamed to `lark-mcp.log.old` (overwriting any previous `.old` file) and a fresh log is started. At most ~10 MB of disk space is used at any time.

---

## Known limitations

- `feishu_calendar_list` time range is capped at 40 days by the Lark `instance_view` API
- `feishu_doc_search` requires user auth (not available with app token only)
- `feishu_doc_fetch` plain-text output omits inline equation content — equations appear as blank spaces in the `content` string (they are stored correctly as `equation` elements; only the text extraction is incomplete)
