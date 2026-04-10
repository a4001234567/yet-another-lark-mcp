/**
 * Auth guard for module-scoped tools.
 *
 * Design:
 *   withModuleAuth(module, fn) — drop-in for withAuth() that also checks OAuth scopes.
 *   If the required scopes are missing, it BLOCKS inline:
 *     1. Starts an OAuth device flow
 *     2. Sends an auth card to the owner in Feishu (one card, not two)
 *     3. Polls until the user clicks Authorize or Deny
 *     4. On success → continues into fn() transparently (returns [Newly authorized: X] note to MCP client)
 *     5. On denial → returns an error string immediately
 *
 * Trade-off: Blocking here means the watch loop stalls during auth. This is acceptable
 * because auth is a user-initiated gate — the user must act before anything can proceed anyway.
 * Non-blocking auth (fire-and-forget poll) caused duplicate cards when callers also called
 * feishu_auth_init manually, which is why we consolidated here.
 *
 * Scope accumulation: each new OAuth token includes previously-granted scopes, so repeated
 * single-module auths (calendar, then docs) don't revoke prior grants.
 *
 * Pessimistic pass: if granted scopes for this session are unknown (e.g. after server restart),
 * always re-trigger OAuth so the user explicitly grants the required scopes. This avoids silent
 * failures from stale or revoked permissions.
 */

import {
  isAuthed, hasScopes, MODULE_SCOPES, startDeviceFlow, pollDeviceToken,
  getOwnerOpenId, saveGrantedScopes, getGrantedScopes,
} from './auth.js';
import { getLarkClient, withAuth } from './client.js';
import { buildAuthCard, buildAuthSuccessCard, buildAuthFailCard, buildAuthDeniedCard } from './cards/auth.js';

const MODULE_NAMES: Record<string, string> = {
  calendar: '日历', task: '任务', docs: '文档', people: '通讯录',
  im: '消息', bitable: '多维表格', sheets: '电子表格', all: '全部',
};

/** Returns null if auth is fine, an error string if auth failed/denied.
 *  Sets _newlyAuthorized = true if a fresh OAuth was just completed. */
let _newlyAuthorized = false;
let _newlyAuthorizedModule = '';

export async function requireModuleAuth(module: string): Promise<string | null> {
  const required = MODULE_SCOPES[module] ?? [];

  if (isAuthed()) {
    // If we have no scope info (token loaded from file after restart), let it through optimistically.
    // If we have scope info from this session and it's sufficient, let it through.
    // Only block if we have scope info AND it proves this module is missing.
    if (required.length === 0) return null;
    if (hasScopes(required)) return null;
    // scopes not granted this session → fall through to re-auth
  }
  // Not authed, or authed with confirmed-insufficient scopes → trigger auth

  const appId     = process.env.LARK_APP_ID!;
  const appSecret = process.env.LARK_APP_SECRET!;
  // Include already-granted scopes so the new token covers all modules
  const accumulated = Array.from(new Set([...getGrantedScopes(), ...required, 'offline_access']));
  const scopeStr = accumulated.join(' ');

  try {
    const flow = await startDeviceFlow(appId, appSecret, scopeStr);

    // Best-effort: send auth card to owner
    let messageId: string | null = null;
    const ownerOpenId = getOwnerOpenId();
    if (ownerOpenId) {
      try {
        const name = MODULE_NAMES[module] ?? module;
        const cardDesc = !isAuthed()
          ? `需要完成用户授权才能使用${name}功能，请点击授权`
          : `需要追加${name}权限，请点击重新授权`;
        const res = await getLarkClient().im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: ownerOpenId,
            msg_type:   'interactive',
            content:    JSON.stringify(buildAuthCard(flow.verification_url, cardDesc)),
          },
        });
        messageId = (res as any)?.data?.message_id ?? null;
      } catch { /* best effort */ }
    }

    // Block until user authorizes or denies
    try {
      await pollDeviceToken(appId, appSecret, flow.device_code, flow.interval);
      saveGrantedScopes(required);
      if (messageId) {
        try {
          await getLarkClient().im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(buildAuthSuccessCard()) },
          });
        } catch { /* best effort */ }
      }
      _newlyAuthorized = true;
      _newlyAuthorizedModule = MODULE_NAMES[module] ?? module;
      return null; // auth succeeded — proceed with tool call (note returned via withModuleAuth)
    } catch (err: any) {
      const isDenied = String(err?.message ?? '').includes('access_denied');
      const card = isDenied ? buildAuthDeniedCard() : buildAuthFailCard();
      if (messageId) {
        try {
          await getLarkClient().im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(card) },
          });
        } catch { /* best effort */ }
      }
      return isDenied ? '用户拒绝了授权。如需使用该功能，请重新调用并在飞书中点击授权。' : `授权失败：${err.message}`;
    }
  } catch (err: any) {
    return `启动授权失败：${err.message}`;
  }
}

/**
 * Drop-in replacement for withAuth that also checks module scopes first.
 * If auth/scope is missing, sends a Feishu card and returns an error immediately.
 */
export async function withModuleAuth<T>(
  module: string,
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  _newlyAuthorized = false;
  const authErr = await requireModuleAuth(module);
  if (authErr) return { content: [{ type: 'text' as const, text: authErr }] };
  const result = await withAuth(fn) as { content: Array<{ type: 'text'; text: string }> };
  if (_newlyAuthorized) {
    const note = `[已获得${_newlyAuthorizedModule}权限] `;
    _newlyAuthorized = false;
    return { content: [{ type: 'text' as const, text: note + (result.content[0]?.text ?? '') }, ...result.content.slice(1)] };
  }
  return result;
}
