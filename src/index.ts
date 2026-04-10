/**
 * Lark/Feishu MCP Server
 *
 * Exposes Lark tools (calendar, tasks, IM, docs, people) via the Model Context Protocol.
 * Runs as a long-lived stdio process — ideal for Claude Desktop, Cursor, or any MCP client.
 *
 * Usage:
 *   LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx npx tsx src/index.ts
 *
 * On first run:
 *   1. Call feishu_auth_init  → get a browser URL
 *   2. Authorize in the browser
 *   3. Call feishu_auth_complete  → saves token, enables all tools
 *
 * Token is persisted at ~/.config/lark-mcp/tokens.json and auto-refreshed.
 *
 * Environment variables:
 *   LARK_APP_ID       (required) Lark app ID
 *   LARK_APP_SECRET   (required) Lark app secret
 *   LARK_TIMEZONE     (optional) Timezone for calendar/task times, default Asia/Shanghai
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initAuth, fetchOwnerOpenIdFromApp } from './auth.js';
import { startWsClient } from './ws.js';
import { logToolCall } from './logger.js';
import { registerAuthTools } from './tools/auth.js';
import { registerPeopleTools } from './tools/people.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerTaskTools } from './tools/task.js';
import { registerImTools } from './tools/im.js';
import { registerLoopTools } from './tools/loop.js';
import { registerDocTools } from './tools/docs.js';
import { registerPrompts } from './prompts.js';

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'lark-mcp',
  version: '0.1.0',
});

// Load persisted token and schedule auto-refresh
initAuth();

// Attempt WebSocket long connection for real-time IM events.
// Set LARK_NO_WATCH=1 to skip — useful for a send-only instance sharing the same app
// with a separate watch-loop instance (avoids event delivery collisions).
const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
if (appId && appSecret) {
  fetchOwnerOpenIdFromApp(appId, appSecret).catch(() => { /* error logged inside */ });
  if (!process.env.LARK_NO_WATCH) {
    startWsClient(appId, appSecret).catch(() => { /* fallback handled inside */ });
  }
}

// Wrap server.tool to log every tool call before registering tools
const _origTool = server.tool.bind(server);
(server as any).tool = function (name: string, ...rest: any[]) {
  const handler = rest[rest.length - 1];
  if (typeof handler === 'function') {
    rest[rest.length - 1] = async (params: any, extra: any) => {
      const t0 = Date.now();
      try {
        const result = await handler(params, extra);
        logToolCall(name, params ?? {}, true, Date.now() - t0);
        return result;
      } catch (err) {
        logToolCall(name, params ?? {}, false, Date.now() - t0);
        throw err;
      }
    };
  }
  return _origTool(name, ...rest);
};

// Tools
registerAuthTools(server);
registerPeopleTools(server);
registerCalendarTools(server);
registerTaskTools(server);
registerImTools(server);
registerLoopTools(server);
registerDocTools(server);

// Prompts (skill guides)
registerPrompts(server);

// ---------------------------------------------------------------------------
// Connect via stdio
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[lark-mcp] Server ready\n');
