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

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initAuth, fetchOwnerOpenIdFromApp } from './auth.js';
import { startWsClient, setWsEnabled } from './ws.js';
import { logToolCall } from './logger.js';
import { registerAuthTools } from './tools/auth.js';
import { registerPeopleTools } from './tools/people.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerTaskTools } from './tools/task.js';
import { registerImTools } from './tools/im.js';
import { registerLoopTools } from './tools/loop.js';
import { registerDocTools, registerCommentTools } from './tools/docs.js';
import { registerTokenProxyTools } from './tools/token-proxy.js';
import { registerPrompts } from './prompts.js';

// ---------------------------------------------------------------------------
// Global error safety — prevent unhandled rejections from crashing the process
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[lark-mcp] Unhandled rejection (kept alive): ${reason}\n`);
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[lark-mcp] Uncaught exception (kept alive): ${err?.message ?? err}\n`);
});

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'lark-mcp',
  version: '0.1.0',
});

// Load persisted token and schedule auto-refresh
initAuth();

// Read cwd-local config — scoped to the directory where claude was invoked,
// NOT inherited from parent directories (unlike .mcp.json env vars).
// enableWatch must be explicitly true here; default is false (no long connection).
// LARK_NO_WATCH=1 overrides as an emergency kill switch even if config says true.
let localConfig: { enableWatch?: boolean } = {};
try {
  localConfig = JSON.parse(readFileSync(join(process.cwd(), '.lark-mcp.json'), 'utf8'));
} catch {}

// Acquire a per-APPID PID lockfile so only one MCP instance per app holds the WS connection.
// Uses atomic O_CREAT|O_EXCL write; checks if the lock holder PID is still alive on conflict.
function acquireWsLock(appId: string): boolean {
  const dir = join(homedir(), '.config', 'lark-mcp');
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `${appId}-ws.lock`);
  const myPid = String(process.pid);

  const write = () => {
    try { writeFileSync(lockPath, myPid, { flag: 'wx' }); return true; } catch { return false; }
  };

  if (write()) {
    process.on('exit', () => { try { unlinkSync(lockPath); } catch {} });
    return true;
  }

  // Lock exists — check if holder is still alive
  try {
    const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (!isNaN(pid)) {
      try { process.kill(pid, 0); return false; } catch { /* dead */ }
    }
    unlinkSync(lockPath);
    if (write()) {
      process.on('exit', () => { try { unlinkSync(lockPath); } catch {} });
      return true;
    }
  } catch {}
  return false;
}

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
if (appId && appSecret) {
  fetchOwnerOpenIdFromApp(appId, appSecret).catch(() => { /* error logged inside */ });
  if (localConfig.enableWatch === true && !process.env.LARK_NO_WATCH && acquireWsLock(appId)) {
    setWsEnabled();
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
  return (_origTool as any)(name, ...rest);
};

// Tools
registerAuthTools(server);
registerPeopleTools(server);
registerCalendarTools(server);
registerTaskTools(server);
registerImTools(server);
registerLoopTools(server);
registerDocTools(server);
registerCommentTools(server);
await registerTokenProxyTools(server);

// Prompts (skill guides)
registerPrompts(server);

// ---------------------------------------------------------------------------
// Connect via stdio
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[lark-mcp] Server ready\n');

// Exit when the MCP client disconnects (stdin closes).
// Without this, the WS long-connection keeps Node alive indefinitely,
// leaving zombie processes after Claude Desktop exits.
process.stdin.on('end', () => {
  process.stderr.write('[lark-mcp] stdin closed — exiting\n');
  process.exit(0);
});
