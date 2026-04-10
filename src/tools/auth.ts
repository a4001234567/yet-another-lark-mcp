/**
 * feishu_auth_* MCP tools — OAuth device flow.
 *
 * Usage:
 *   1. Call feishu_auth_init  → get verification_url + user_code
 *   2. User visits URL and enters user_code (or scans QR)
 *   3. Call feishu_auth_complete → polls until token arrives
 *   4. All subsequent tool calls use the stored token automatically
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import https from 'https';
import { startDeviceFlow, pollDeviceToken, isAuthed, getUserToken, getOwnerOpenId, saveOwnerOpenId, getScopesForModule, MODULE_SCOPES, saveGrantedScopes, hasScopes, getGrantedScopes } from '../auth.js';
import { getLarkClient } from '../client.js';
import { buildAuthCard, buildAuthSuccessCard, buildAuthFailCard } from '../cards/auth.js';
import { getMessageQueue } from '../ws.js';


// Shared state for in-progress device flow
let pendingDeviceCode: string | null = null;
let pendingInterval: number = 5;

export function registerAuthTools(server: McpServer) {
  // ── status ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_auth_status',
    'Check current Lark authentication status and which modules have been authorized.',
    {},
    async () => {
      const authed = isAuthed();
      const grantedModules = authed
        ? Object.entries(MODULE_SCOPES)
            .filter(([, scopes]) => hasScopes(scopes))
            .map(([mod]) => mod)
        : [];
      const pendingModules = authed
        ? Object.keys(MODULE_SCOPES).filter(m => !grantedModules.includes(m))
        : Object.keys(MODULE_SCOPES);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ authenticated: authed, granted_modules: grantedModules, pending_modules: pendingModules }),
        }],
      };
    },
  );

  // ── init ───────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_auth_init',
    [
      'Start Lark OAuth. Blocks until authorized (up to 10 min), then returns success or failure.',
      'If open_id is known: sends a blue auth card in Feishu (turns green/grey on result).',
      'If open_id is unknown: returns the auth link as text — user can open it directly OR send any message to the bot to receive the card. Either path saves the open_id for next time.',
    ].join('\n'),
    {
      module:          z.enum(['im', 'calendar', 'task', 'docs', 'people', 'all']).optional()
                         .describe('Which module to authorize. Defaults to all. Use a specific module to request only the minimum required scopes.'),
      scope:           z.string().optional().describe('Override with explicit space-separated OAuth scopes. Overrides module if provided.'),
      receive_id: z.string().optional().describe('open_id (ou_xxx) or chat_id (oc_xxx) to send the auth card to. Falls back to saved owner_open_id.'),
    },
    async ({ module, scope, receive_id }) => {
      const appId     = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) {
        return { content: [{ type: 'text' as const, text: 'Error: LARK_APP_ID and LARK_APP_SECRET must be set in environment.' }] };
      }
      const resolvedScope = scope ?? getScopesForModule(module);
      // Track which scopes we're requesting for this module
      const grantedOnSuccess = module && module !== 'all'
        ? MODULE_SCOPES[module] ?? []
        : Object.values(MODULE_SCOPES).flat();
      try {
        const result = await startDeviceFlow(appId, appSecret, resolvedScope);
        pendingDeviceCode = result.device_code;
        pendingInterval   = result.interval ?? 5;

        const knownOpenId = receive_id ?? getOwnerOpenId() ?? process.env.LARK_OWNER_OPEN_ID ?? null;
        const savedCode     = pendingDeviceCode;
        const savedInterval = pendingInterval;
        const authUrl       = result.verification_url;

        /** Send the auth card and return the message_id (best-effort, null on failure) */
        async function sendAuthCard(openId: string): Promise<string | null> {
          try {
            const client = getLarkClient();
            const sendRes = await client.im.message.create({
              params: { receive_id_type: (openId.startsWith('oc_') ? 'chat_id' : 'open_id') },
              data: {
                receive_id: openId,
                msg_type:   'interactive',
                content:    JSON.stringify(buildAuthCard(authUrl,
                  module && module !== 'all'
                    ? `需要授权${({ calendar: '日历', task: '任务', docs: '文档' } as Record<string,string>)[module] ?? module}权限，请点击授权`
                    : '需要完成用户授权才能使用全部功能，请点击授权'
                )),
              },
            });
            return (sendRes as any)?.data?.message_id ?? null;
          } catch { return null; }
        }

        /** Patch card on poll completion */
        async function patchCard(messageId: string, success: boolean): Promise<void> {
          try {
            const client = getLarkClient();
            await client.im.message.patch({
              path: { message_id: messageId },
              data: { content: JSON.stringify(success ? buildAuthSuccessCard() : buildAuthFailCard()) },
            });
          } catch { /* best-effort */ }
        }

        let messageId: string | null = null;

        if (knownOpenId) {
          messageId = await sendAuthCard(knownOpenId);
        } else {
          // open_id unknown — watch queue in background: if user messages the bot, send the card
          ;(async () => {
            const queueSnapshot = getMessageQueue().length;
            const deadline = Date.now() + 10 * 60_000;
            while (Date.now() < deadline) {
              await new Promise<void>(r => setTimeout(r, 1000));
              const newMsg = getMessageQueue().slice(queueSnapshot).find(m => m.sender_id);
              if (newMsg) {
                saveOwnerOpenId(newMsg.sender_id);
                messageId = await sendAuthCard(newMsg.sender_id);
                break;
              }
            }
          })();
        }

        // Block until auth completes
        try {
          await pollDeviceToken(appId, appSecret, savedCode, savedInterval);
          pendingDeviceCode = null;
          saveGrantedScopes(grantedOnSuccess);
          // If user authorized via link (no message sent), fetch open_id from whoami now
          if (!getOwnerOpenId()) {
            try {
              const token = getUserToken();
              const data = await new Promise<any>((resolve, reject) => {
                const req = https.request(
                  { hostname: 'open.feishu.cn', path: '/open-apis/authen/v1/user_info', method: 'GET',
                    headers: { Authorization: `Bearer ${token}` } },
                  r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); },
                );
                req.on('error', reject);
                req.end();
              });
              if (data.code === 0 && data.data?.open_id) saveOwnerOpenId(data.data.open_id);
            } catch { /* best-effort */ }
          }
          if (messageId) await patchCard(messageId, true);
          return { content: [{ type: 'text' as const, text: 'Authentication successful. All tools are now available.' }] };
        } catch (err: any) {
          if (messageId) await patchCard(messageId, false);
          const isDenied = String(err.message).includes('access_denied');
          const msg = isDenied
            ? '用户拒绝了授权。如需使用该功能，请重新调用 feishu_auth_init 并在飞书中点击授权。'
            : `Auth failed: ${err.message}`;
          return { content: [{ type: 'text' as const, text: msg }] };
        }
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error starting auth: ${err.message}` }] };
      }
    },
  );

  // ── whoami ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_auth_whoami',
    'Return the open_id, name, and user_id of the authenticated user. Use this to get the app owner\'s open_id for sending direct messages without needing a chat_id.',
    {},
    async () => {
      try {
        // Use cached open_id first (set at startup via TAT, or saved after prior OAuth)
        const cachedOpenId = getOwnerOpenId();
        if (cachedOpenId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ open_id: cachedOpenId }) }] };
        }
        // Fall back to UAT call if no cached open_id
        const token = getUserToken();
        const data = await new Promise<any>((resolve, reject) => {
          const req = https.request(
            { hostname: 'open.feishu.cn', path: '/open-apis/authen/v1/user_info', method: 'GET',
              headers: { Authorization: `Bearer ${token}` } },
            r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); },
          );
          req.on('error', reject);
          req.end();
        });
        if (data.code !== 0) throw new Error(`Lark API ${data.code}: ${data.msg}`);
        const u = data.data;
        if (u.open_id) saveOwnerOpenId(u.open_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ open_id: u.open_id, name: u.name, en_name: u.en_name, user_id: u.user_id }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
      }
    },
  );

}
