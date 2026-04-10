# lark-mcp-server — First-Time Setup Guide

> **For AI assistants:** Read this file to guide the user through setup. Walk through each step interactively — ask the user to confirm before moving to the next step. All shell commands can be run with `! <command>` directly in the chat.

---

## Architecture overview (read this first)

This server has **three layers of capability**, each requiring different setup:

**Layer 1 — App messaging (always available)**
The bot can send and receive Feishu messages using its own App Token. No user login needed. This is what enables the watch-loop: the bot polls for new messages and replies autonomously.

**Layer 2 — Watch loop (enabled by MCP config)**
The agent connects to this MCP server and runs `feishu_im_watch` in a loop — waiting for messages, acting on them, replying, then waiting again. This is the core interaction model. Once the MCP server is configured, it automatically collect incoming events and fires them through the `im_watch` tool.

**Layer 3 — User features (requires OAuth)**
Calendar, tasks, docs act on behalf of the user and require a one-time OAuth authorization (`feishu_auth_init`). This can be done at any time — tools automatically prompt for auth when needed.

---

## Step 1 — Create a Feishu self-built app

1. Go to **https://open.feishu.cn/page/openclaw** and create a new self-built app.
2. Note your **App ID** (`cli_xxx`) and **App Secret** — you will need them in Step 4.
3. In **Capabilities → Bot**, enable the bot feature.
4. In **Bot → Long Connection**, enable long connection mode (this allows real-time message delivery without a public webhook URL).
5. In **Security Settings → OAuth Scopes**, add these user scopes (needed for Layer 3).
   > **Note:** If you created the app via the openclaw link in step 1, the required scopes are pre-configured automatically — you can skip to step 6.

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
   IM and people search use the App Token — no OAuth scopes needed for those.
6. Enable **User OAuth → Device Flow** in Security Settings.
7. Publish the app (internal release is fine).

---

## Step 2 — Install dependencies

```bash
cd lark-mcp-server
npm install
```

---

## Step 3 — Verify directory layout and install skills

The two directories must be siblings:

```
<your-folder>/
├── lark-mcp-server/        ← MCP server
└── lark-skills/            ← skill files (loaded as MCP prompts at runtime)
    └── feishu/feishu-interactive-cards/cards-package/  ← card reference docs
```

If you extracted from the archive, this layout is already correct.

**Skills** are SKILL.md files in `lark-skills/` that the server reads at startup and registers as MCP prompts. No separate installation needed — extracting the archive gives you the correct layout automatically.

To verify skills are registered, ask your AI assistant to invoke one:
```
/mcp__lark__lark-mcp-guide
```
If it returns a skill overview, the layout is correct and skills are working.

---

## Step 4 — Configure your MCP client

### Claude Code

Run this once to register the server:

```bash
claude mcp add lark -- npx tsx /absolute/path/to/lark-mcp-server/src/index.ts
```

Then add your credentials to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "lark": {
      "env": {
        "LARK_APP_ID": "cli_your_app_id",
        "LARK_APP_SECRET": "your_app_secret"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lark": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/lark-mcp-server/src/index.ts"],
      "env": {
        "LARK_APP_ID": "cli_your_app_id",
        "LARK_APP_SECRET": "your_app_secret"
      }
    }
  }
}
```

---

## Step 5 — Add behavioral instructions to your AI client

The agent needs to know the usage rules. Copy the contents of `lark-mcp-server/USAGE.md` into your `CLAUDE.md` (or equivalent system prompt file).

For deeper per-tool guidance, load skills on demand: `feishu-calendar`, `feishu-task`, `feishu-im`, `feishu-watch-loop`, etc.

---

## Step 6 — Test Layer 1 (messaging)

Start a conversation with your bot in Feishu. Then ask your AI assistant to:

```
Run feishu_auth_whoami to get my open_id, then send me a test message via feishu_im_send.
```

If you receive the message, Layer 1 and 2 are working.

---

## Step 7 — Authorize Layer 3 (user features, optional)

To use calendar, tasks, or docs, run:

```
feishu_auth_init
```

If your open_id is known, an auth card is sent to you in Feishu — click it to authorize. Otherwise, a URL is returned — open it in your browser and approve. The tool blocks until authorization completes (up to 10 minutes). Token is saved to `~/.config/lark-mcp/tokens.json` and auto-refreshes.

Check status anytime: `feishu_auth_status`

---

## Step 8 — Install the watch-loop recovery hook (optional but recommended)

If you run Claude Code in autonomous watch-loop mode, install this hook so the watch loop recovers automatically after context compaction:

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

## Done

Once setup is complete:
- Send a message to your bot in Feishu — the AI will respond.
- Ask it to check your calendar, create tasks, or search documents.
- Say "stop" or close the AI session to end the loop.
