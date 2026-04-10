/**
 * Lark SDK client factory.
 * Creates a client and provides helpers for user-auth and tenant-auth calls.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { getUserToken } from './auth.js';

let _client: lark.Client | null = null;

export function getLarkClient(): lark.Client {
  if (!_client) {
    const appId = process.env.LARK_APP_ID;
    const appSecret = process.env.LARK_APP_SECRET;
    if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
    _client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.error });
  }
  return _client;
}

/** Call with user access token */
export function asUser() {
  return lark.withUserAccessToken(getUserToken());
}

/** Format a Lark API error into a readable string */
export function fmtError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

/** Throw if Lark response has non-zero code */
export function assertOk(res: any, context?: string) {
  const code = res?.code ?? res?.data?.code;
  if (code !== 0 && code !== undefined) {
    const msg = res?.msg ?? res?.data?.msg ?? 'unknown error';
    throw new Error(`${context ? context + ': ' : ''}Lark API error ${code}: ${msg}`);
  }
}

/** Wrap a tool handler with standard error handling */
export async function withAuth<T>(fn: () => Promise<T>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    // Auth errors
    if (msg.includes('Not authenticated') || msg.includes('99991663') || msg.includes('99991668')) {
      return { content: [{ type: 'text', text: `Authentication required. Call feishu_auth_init to authorize. Error: ${msg}` }] };
    }
    return { content: [{ type: 'text', text: `Error: ${msg}` }] };
  }
}
