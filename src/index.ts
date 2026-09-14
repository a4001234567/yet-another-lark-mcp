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
import { registerDocTools, registerCommentTools } from './tools/docs.js';
import { registerTokenProxyTools } from './tools/token-proxy.js';
import { registerAihotTools } from './tools/aihot.js';
import { registerSshTools } from './tools/ssh.js';
import { registerAmapTools } from './tools/amap.js';
import { live2d } from './tools/live2d.js';
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

// Broker 模式下 MCP 每轮随 claude 重启一次，启动这一瞬就当作"收到消息"的触发点：
// 切「拿笔」，回复时再由 feishu_im_send 复位成「无」—— 复原旧 watch 的两拍。
// 用 fireExpression（spawn 版）而不是 expression，免得隧道不通时 execSync 卡住启动。
if (process.env.LARK_BROKER) {
  live2d.fireExpression(4);   // 4 = 拿笔
}

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

// Wrap server.tool to log every tool call and optionally push a Live2D bubble
const _origTool = server.tool.bind(server);
(server as any).tool = function (name: string, ...rest: any[]) {
  const handler = rest[rest.length - 1];
  if (typeof handler === 'function') {
    rest[rest.length - 1] = async (params: any, extra: any) => {
      const t0 = Date.now();
      try {
        const result = await handler(params, extra);
        logToolCall(name, params ?? {}, true, Date.now() - t0);
        // Fire-and-forget Live2D bubble for tool calls (skip noisy/internal ones)
        if (name !== 'feishu_im_watch') {
          if (name === 'win_exec' || name === 'pi_exec') {
            // Show the actual command being run, filter out live2d self-calls
            const cmd: string = (params as any)?.command ?? '';
            if (!cmd.includes('live2d.py') && !cmd.includes('live2d\\')) {
              live2d.fireToolBubble('⚡ ' + cmd.slice(0, 80), {});
            }
          } else {
            live2d.fireToolBubble(name, params ?? {});
          }
        }
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
registerAihotTools(server);
registerSshTools(server);
registerAmapTools(server);

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
