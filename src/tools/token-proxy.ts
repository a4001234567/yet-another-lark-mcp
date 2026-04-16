/**
 * feishu_auth_issue_token — local proxy gateway for third-party tool access.
 *
 * Issues a time-limited token + starts a local HTTP proxy (127.0.0.1:PORT).
 * Third-party scripts use the proxy instead of calling the Feishu API directly,
 * so they never see the real user access token.
 *
 * Transparent reverse proxy — same URL paths and methods as official Feishu API:
 *   Replace https://open.feishu.cn → http://127.0.0.1:<port>
 *   Set Authorization: Bearer <issued_token>
 *
 *   Example: GET http://127.0.0.1:<port>/open-apis/calendar/v4/calendars/primary
 *
 * A Feishu card is sent to the owner on each token issuance, showing:
 *   - Reason, port, expiry, call count, recent calls, status
 *   - A [停止] button to revoke the token early
 *
 * Card is patched on: revocation, expiry, and debounced 2 s after the last API call in a burst.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import { randomBytes } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserToken, getOwnerOpenId } from '../auth.js';
import { getLarkClient } from '../client.js';
import { registerCardActionHook, QueuedCallback } from '../ws.js';

// ---------------------------------------------------------------------------
// Token registry
// ---------------------------------------------------------------------------

interface TokenEntry {
  token:           string;
  reason:          string;
  issued_at:       number;   // epoch ms
  expires_at:      number;   // epoch ms
  call_count:      number;
  call_types:      Map<string, number>;  // "METHOD /path/prefix" → count
  revoked:         boolean;
  card_message_id: string | null;
  patch_timer:     ReturnType<typeof setTimeout> | null;  // debounce timer
}

const tokenRegistry = new Map<string, TokenEntry>();
let proxyPort = 0;

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function buildTokenCard(entry: TokenEntry, final = false): object {
  const inactive = entry.revoked || Date.now() > entry.expires_at;
  const status   = entry.revoked           ? '🔴 已撤销'
                 : Date.now() > entry.expires_at ? '⏰ 已过期'
                 : '🟢 活跃';

  const typeLines = entry.call_types.size > 0
    ? [...entry.call_types.entries()].map(([k, n]) => `${k}  ×${n}`).join('\n')
    : '（暂无）';

  const elements: object[] = [
    {
      tag: 'markdown',
      content: [
        `**理由** ${entry.reason}`,
        `**代理端口** 127.0.0.1:${proxyPort}`,
        `**有效至** ${fmtTime(entry.expires_at)}`,
        `**调用次数** ${entry.call_count}`,
        `**状态** ${status}`,
      ].join('\n'),
    },
    { tag: 'hr' },
    { tag: 'markdown', content: `**调用明细**\n${typeLines}` },
    { tag: 'hr' },
    inactive || final
      ? {
          tag: 'button',
          type: 'default',
          disabled: true,
          disabled_tips: { tag: 'plain_text', content: '令牌已失效' },
          text: { tag: 'plain_text', content: '停止' },
        }
      : {
          tag: 'button',
          type: 'danger',
          text: { tag: 'plain_text', content: '停止' },
          behaviors: [{ type: 'callback', value: { action: 'stop_token' } }],
        },
  ];

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: inactive ? 'grey' : 'yellow',
      title:    { tag: 'plain_text', content: '🔑 临时访问令牌' },
      subtitle: { tag: 'plain_text', content: entry.reason },
    },
    body: { elements },
  };
}

// ---------------------------------------------------------------------------
// Card patching (best-effort)
// ---------------------------------------------------------------------------

async function patchCard(entry: TokenEntry, final = false): Promise<void> {
  if (!entry.card_message_id) return;
  try {
    const client = getLarkClient();
    await (client.im.message as any).patch({
      path: { message_id: entry.card_message_id },
      data: { content: JSON.stringify(buildTokenCard(entry, final)) },
    });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Local HTTP proxy server
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function handleProxyRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    try {
      const authHeader = req.headers['authorization'] ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const entry = tokenRegistry.get(token);

      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      if (entry.revoked) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'token_revoked' }));
        return;
      }
      if (Date.now() > entry.expires_at) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'token_expired' }));
        return;
      }

      const bodyBuf = await readBody(req);
      // Use request URL directly as Feishu API path — transparent reverse proxy
      const feishuPath = req.url ?? '/';
      const method     = req.method ?? 'GET';

      let feishuToken: string;
      try { feishuToken = getUserToken(); }
      catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_feishu_auth' }));
        return;
      }

      const fwdHeaders: Record<string, string> = {
        'Authorization': `Bearer ${feishuToken}`,
        'Content-Type':  req.headers['content-type'] ?? 'application/json',
      };
      if (bodyBuf.length > 0) fwdHeaders['Content-Length'] = String(bodyBuf.length);

      const feishuRes = await new Promise<{ statusCode: number; body: Buffer }>((resolve, reject) => {
        const proxyReq = https.request(
          { hostname: 'open.feishu.cn', path: feishuPath, method, headers: fwdHeaders },
          r => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => resolve({ statusCode: r.statusCode ?? 200, body: Buffer.concat(chunks) }));
          },
        );
        proxyReq.on('error', reject);
        if (bodyBuf.length > 0) proxyReq.write(bodyBuf);
        proxyReq.end();
      });

      // Track
      // Derive a short path key: method + /segment/segment (strip IDs after 3rd segment)
      const pathParts = feishuPath.split('?')[0].split('/').slice(0, 5);
      const pathKey = `${method} ${pathParts.join('/')}`;
      entry.call_count++;
      entry.call_types.set(pathKey, (entry.call_types.get(pathKey) ?? 0) + 1);

      // Debounced card patch: 2 s after the last call in a burst
      if (entry.patch_timer) clearTimeout(entry.patch_timer);
      entry.patch_timer = setTimeout(() => {
        entry.patch_timer = null;
        if (!entry.revoked && Date.now() <= entry.expires_at) {
          patchCard(entry).catch(() => {});
        }
      }, 2_000);

      res.writeHead(feishuRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(feishuRes.body);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_error', message: String(err?.message) }));
    }
  })();
}

// ---------------------------------------------------------------------------
// Proxy server init (lazy, starts once)
// ---------------------------------------------------------------------------

let _startPromise: Promise<void> | null = null;

function ensureProxyStarted(): Promise<void> {
  if (proxyPort > 0) return Promise.resolve();
  if (!_startPromise) {
    _startPromise = new Promise<void>((resolve, reject) => {
      const srv = createServer(handleProxyRequest);
      srv.listen(0, '127.0.0.1', () => {
        proxyPort = (srv.address() as { port: number }).port;
        process.stderr.write(`[lark-mcp] Token proxy listening on 127.0.0.1:${proxyPort}\n`);
        resolve();
      });
      srv.on('error', reject);
    });
  }
  return _startPromise;
}

// ---------------------------------------------------------------------------
// Card action hook — Stop button
// ---------------------------------------------------------------------------

function onCardAction(
  messageId: string,
  action: string,
  _cb: QueuedCallback,
): { handled: true; toast?: any; card?: any } | { handled: false } {
  if (action !== 'stop_token') return { handled: false };
  for (const entry of tokenRegistry.values()) {
    if (entry.card_message_id === messageId && !entry.revoked) {
      entry.revoked = true;
      return {
        handled: true,
        toast: { type: 'success', content: '令牌已撤销' },
        card:  { type: 'raw', data: buildTokenCard(entry, true) },
      };
    }
  }
  return { handled: false };
}

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

export async function registerTokenProxyTools(server: McpServer): Promise<void> {
  await ensureProxyStarted();
  registerCardActionHook(onCardAction);

  server.tool(
    'feishu_auth_issue_token',
    [
      'Issue a time-limited proxy token for third-party scripts to access the Feishu API',
      'without exposing the real user token.',
      '',
      'The proxy is a transparent reverse proxy: use the same URL paths and methods as',
      'the official Feishu API, but replace https://open.feishu.cn with http://127.0.0.1:<port>.',
      'Add Authorization: Bearer <issued_token> instead of the real token.',
      '',
      'Example: GET http://127.0.0.1:<port>/open-apis/calendar/v4/calendars/primary',
      '',
      'A monitoring card is sent to Feishu showing call counts and a Stop button.',
    ].join('\n'),
    {
      ttl_minutes: z.number().min(1).max(1440).default(5)
        .describe('Token validity in minutes (1–1440, default 5).'),
      reason: z.string().min(1).max(100)
        .describe('Why this token is being issued — shown on the monitoring card.'),
    },
    async ({ ttl_minutes, reason }) => {
      await ensureProxyStarted();

      const token     = `lmk_${randomBytes(8).toString('hex')}`;
      const now       = Date.now();
      const expiresAt = now + ttl_minutes * 60_000;

      const entry: TokenEntry = {
        token,
        reason,
        issued_at:       now,
        expires_at:      expiresAt,
        call_count:      0,
        call_types:      new Map(),
        revoked:         false,
        card_message_id: null,
        patch_timer:     null,
      };
      tokenRegistry.set(token, entry);

      // Auto-patch card on expiry
      const delay = expiresAt - now;
      setTimeout(() => {
        if (!entry.revoked) patchCard(entry, true).catch(() => {});
      }, delay + 500);

      // Send monitoring card to owner
      const ownerOpenId = getOwnerOpenId();
      if (ownerOpenId) {
        try {
          const client  = getLarkClient();
          const cardContent = JSON.stringify(buildTokenCard(entry));
          const sendRes = await (client.im.message as any).create({
            params: { receive_id_type: 'open_id' },
            data:   {
              receive_id: ownerOpenId,
              msg_type:   'interactive',
              content:    cardContent,
            },
          });
          entry.card_message_id = (sendRes as any)?.data?.message_id ?? null;
          process.stderr.write(`[token-proxy] Card sent, message_id=${entry.card_message_id}\n`);
        } catch (err) {
          process.stderr.write(`[token-proxy] Card send failed: ${err}\n`);
        }
      } else {
        process.stderr.write(`[token-proxy] ownerOpenId is null — card not sent\n`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            token,
            proxy_url:   `http://127.0.0.1:${proxyPort}`,
            expires_at:  new Date(expiresAt).toISOString(),
            expires_str: fmtTime(expiresAt),
            ttl_minutes,
            usage: `Replace https://open.feishu.cn with http://127.0.0.1:${proxyPort} and set Authorization: Bearer ${token}`,
          }, null, 2),
        }],
      };
    },
  );
}
