# Installation Guide

## Requirements

- Node.js 18+
- A Lark self-built app with the permissions listed below

---

## 1. Create a Lark app

1. Go to [open.feishu.cn/app](https://open.feishu.cn/app) and create a **self-built app**.
2. Under **Credentials & Basic Info**, note your **App ID** (`cli_xxx`) and **App Secret**.
3. Under **Features**, enable **Bot**.
4. Under **Permissions & Scopes**, add the app-level scopes:
   - `im:message` `im:message:send_as_bot` `im:resource` `contact:user.base:readonly`
5. Under **Security Settings → OAuth**, enable **User OAuth (device flow)** and add the user-level scopes listed at the end of this file.
6. Publish the app (or use in development mode — either works for personal use).

---

## 2. Clone and install

```bash
git clone https://github.com/a4001234567/yet-another-lark-mcp
cd yet-another-lark-mcp
npm install
```

---

## 3. Configure your MCP client

### Claude Code

```bash
claude mcp add lark -- npx tsx /absolute/path/to/lark-mcp-server/src/index.ts
```

Then add the environment variables. In `.claude/settings.json` (or `settings.local.json`):

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

### OpenAI Codex

Add to your Codex MCP configuration:

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

> **Important — increase MCP tool timeout:**
> Codex defaults to a 120-second timeout per MCP tool call. `feishu_im_watch` is a blocking long-poll that can run up to 6 hours. You must raise the timeout, or the watch loop will break every 2 minutes.
>
> In `~/.codex/config.json` (or your Codex project config), set:
> ```json
> { "mcpToolTimeout": 21600000 }
> ```
> (21 600 000 ms = 6 hours)

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LARK_APP_ID` | Yes | — | App ID from Lark developer console (`cli_xxx`) |
| `LARK_APP_SECRET` | Yes | — | App secret |
| `LARK_TIMEZONE` | No | `Asia/Shanghai` | Timezone for date parsing and display |
| `LARK_NO_WATCH` | No | — | Set to `1` to skip the WebSocket connection. Emergency kill switch — disables the WS connection even if `.lark-mcp.json` says `enableWatch: true`. |

### Enabling the WebSocket watch loop

The WebSocket long connection (required for `feishu_im_watch`) must be explicitly enabled via a per-project config file. Create `.lark-mcp.json` **in the directory where you launch your AI client**:

```json
{ "enableWatch": true }
```

This file is scoped to that directory — it is not inherited from parent directories. Without it, the server starts without a WS connection and `feishu_im_watch` is not registered.

**WS lock:** only one MCP server instance per App ID can hold the WebSocket connection at a time. If a second instance starts (e.g. a second Claude Code window using the same app), it detects the lock and skips the connection silently. This prevents duplicate message delivery. The lock file is at `~/.config/lark-mcp/<app_id>-ws.lock` and is removed automatically when the owning process exits.

---

## 4. First-time authentication

Messaging and people search work immediately with the App Token — no login needed.

For calendar, tasks, and docs, call `feishu_auth_init` once. It will:
1. Send an auth card to you in Feishu (if your open_id is known), or return a `verification_url` + `user_code` in text.
2. Block and poll until you complete the browser authorization (up to 10 minutes).

Token is saved to `~/.config/lark-mcp/tokens.json` and refreshes automatically.

---

## 5. Watch-loop recovery hook (optional)

If you use Claude Code in autonomous watch-loop mode, install the session hook so Claude automatically re-establishes `feishu_im_watch` after context compaction:

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

---

## OAuth scopes required

Add these under **Security Settings → OAuth → User Scopes** in the Lark developer console.

**Calendar**
```
calendar:calendar:read
calendar:calendar.event:create
calendar:calendar.event:delete
calendar:calendar.event:read
calendar:calendar.event:reply
calendar:calendar.event:update
calendar:calendar.free_busy:read
```

**Tasks**
```
task:task:read
task:task:write
task:task:writeonly
task:tasklist:read
task:tasklist:write
```

**Docs**
```
docx:document:readonly
docx:document:create
docx:document:write_only
search:docs:read
space:document:delete
space:document:move
space:document:retrieve
drive:drive.metadata:readonly
drive:file:download
drive:file:upload
docs:document:export
docs:document.media:download
docs:document.media:upload
docs:document:copy
wiki:member:create
wiki:node:copy
wiki:node:create
wiki:node:move
wiki:node:read
wiki:node:retrieve
wiki:space:read
wiki:space:retrieve
wiki:space:write_only
wiki:wiki
```

**Always required**
```
offline_access
```
