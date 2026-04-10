/**
 * OAuth token management for Lark MCP server.
 *
 * Tokens are persisted at ~/.config/lark-mcp/tokens.json.
 * A background timer refreshes the access_token before it expires.
 * If no token exists, tools return an error directing the user to call feishu_auth_init.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import https from 'https';

const TOKEN_FILE = join(homedir(), '.config', 'lark-mcp', 'tokens.json');

export interface TokenStore {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  owner_open_id?: string; // saved from feishu_auth_whoami — used to send auth cards
  granted_scopes?: string[]; // OAuth scopes granted so far; persisted so cold restarts don't need re-auth
}

// ---------------------------------------------------------------------------
// Module → OAuth scope mapping
// ---------------------------------------------------------------------------

export const MODULE_SCOPES: Record<string, string[]> = {
  // im and people use TAT (App Token) — no OAuth needed, excluded from status reporting
  calendar: [
    'calendar:calendar:read',
    'calendar:calendar.event:create', 'calendar:calendar.event:delete',
    'calendar:calendar.event:read', 'calendar:calendar.event:reply',
    'calendar:calendar.event:update', 'calendar:calendar.free_busy:read',
  ],
  task: [
    'task:task:read', 'task:task:write', 'task:task:writeonly',
    'task:tasklist:read', 'task:tasklist:write',
    // 'task:comment:read', 'task:comment:write', // not yet implemented
  ],
  docs: [
    'docx:document:readonly', 'docx:document:create', 'docx:document:write_only',
    'search:docs:read',
    'space:document:delete', 'space:document:move', 'space:document:retrieve',
    'drive:drive.metadata:readonly', 'drive:file:download', 'drive:file:upload',
    'docs:document:export', 'docs:document.media:download', 'docs:document.media:upload', 'docs:document:copy',
    // 'docs:document.comment:create', 'docs:document.comment:read', 'docs:document.comment:update', // not yet implemented
    'wiki:node:copy', 'wiki:node:create', 'wiki:node:move',
    'wiki:node:read', 'wiki:node:retrieve',
    'wiki:space:read', 'wiki:space:retrieve', 'wiki:space:write_only',
  ],
  // people uses TAT — no OAuth needed
  // bitable: not yet implemented
  // 'base:app:read', 'base:app:create', 'base:app:copy', 'base:app:update',
  // 'base:table:read', 'base:table:create', 'base:table:delete', 'base:table:update',
  // 'base:field:read', 'base:field:create', 'base:field:delete', 'base:field:update',
  // 'base:record:retrieve', 'base:record:create', 'base:record:delete', 'base:record:update',
  // 'base:view:read', 'base:view:write_only',

  // sheets: not yet implemented
  // 'sheets:spreadsheet.meta:read', 'sheets:spreadsheet:read',
  // 'sheets:spreadsheet:create', 'sheets:spreadsheet:write_only',
};

/** Return scope string for a module (or all modules if omitted/all). */
export function getScopesForModule(module?: string): string {
  if (!module || module === 'all') {
    const all = Array.from(new Set(Object.values(MODULE_SCOPES).flat()));
    return [...all, 'offline_access'].join(' ');
  }
  const scopes = MODULE_SCOPES[module] ?? [];
  return [...scopes, 'offline_access'].join(' ');
}

/** Check whether all required scopes have been granted this session. */
export function hasScopes(required: string[]): boolean {
  if (!tokenStore) return false;
  return required.every(s => _grantedScopes.has(s));
}

/** Return all scopes granted so far this session. */
export function getGrantedScopes(): string[] {
  return Array.from(_grantedScopes);
}

/** Record scopes granted in the current OAuth flow and persist to tokens.json. */
export function saveGrantedScopes(scopes: string[]): void {
  for (const s of scopes) _grantedScopes.add(s);
  if (tokenStore) {
    tokenStore = { ...tokenStore, granted_scopes: Array.from(_grantedScopes) };
    saveTokenFile(tokenStore);
  }
}

// In-memory token state
let tokenStore: TokenStore | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Owner open_id fetched from App Token (independent of OAuth)
let _appOwnerOpenId: string | null = null;

// Scopes granted so far — in-memory cache, also persisted to tokens.json via saveGrantedScopes()
const _grantedScopes = new Set<string>();

// ---------------------------------------------------------------------------
// Token file persistence
// ---------------------------------------------------------------------------

function loadTokenFile(): TokenStore | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    const appId = process.env.LARK_APP_ID;
    // New format: { [appId]: TokenStore }
    if (appId && raw[appId] && typeof raw[appId] === 'object') return raw[appId] as TokenStore;
    // Legacy flat format migration: if file has access_token at top level, it's the old single-instance format
    if (raw.access_token !== undefined) {
      if (appId) {
        // Migrate in-place: wrap under appId key and re-save
        const migrated = { [appId]: raw };
        mkdirSync(dirname(TOKEN_FILE), { recursive: true });
        writeFileSync(TOKEN_FILE, JSON.stringify(migrated, null, 2));
        process.stderr.write(`[lark-mcp] Migrated tokens.json to appId-keyed format (${appId})\n`);
      }
      return raw as TokenStore;
    }
    return null;
  } catch {
    return null;
  }
}

function saveTokenFile(t: TokenStore) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const appId = process.env.LARK_APP_ID;
  if (!appId) {
    // Fallback: write flat (no appId available — should not happen in normal use)
    writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
    return;
  }
  // Read existing file and update only this appId's entry
  let existing: Record<string, any> = {};
  try {
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    // If old flat format still on disk, start fresh keyed store
    if (raw.access_token !== undefined) existing = {};
    else existing = raw;
  } catch { /* start fresh */ }
  existing[appId] = t;
  writeFileSync(TOKEN_FILE, JSON.stringify(existing, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers (no extra deps)
// ---------------------------------------------------------------------------

function post(path: string, body: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tenant access token (app-level, no user auth needed)
// ---------------------------------------------------------------------------

export async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await post('/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: appSecret });
  if (res.code !== 0) throw new Error(`TAT error ${res.code}: ${res.msg}`);
  return res.tenant_access_token as string;
}

function getJson(path: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(JSON.parse(raw)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch owner open_id from the application API using App Token.
 * Called at startup — no OAuth required. Result is cached in _appOwnerOpenId.
 */
export async function fetchOwnerOpenIdFromApp(appId: string, appSecret: string): Promise<void> {
  try {
    const tat = await getTenantAccessToken(appId, appSecret);
    const res = await getJson(`/open-apis/application/v6/applications/${appId}?lang=zh_cn`, tat);
    const owner = res?.data?.app?.owner;
    const ownerId = (owner?.type === 2 && owner?.owner_id)
      ? owner.owner_id
      : res?.data?.app?.creator_id;
    if (ownerId) {
      _appOwnerOpenId = ownerId;
      process.stderr.write(`[lark-mcp] Owner open_id: ${ownerId}\n`);
    } else {
      process.stderr.write(`[lark-mcp] Could not determine owner open_id from application API\n`);
    }
  } catch (err) {
    process.stderr.write(`[lark-mcp] Could not fetch owner open_id: ${err}\n`);
  }
}

// ---------------------------------------------------------------------------
// User token access
// ---------------------------------------------------------------------------

export function isAuthed(): boolean {
  return tokenStore !== null && Date.now() < tokenStore.expires_at - 60_000;
}

export function getUserToken(): string {
  if (!tokenStore) throw new Error('Not authenticated. Call feishu_auth_init first.');
  return tokenStore.access_token;
}

export function getOwnerOpenId(): string | null {
  return _appOwnerOpenId ?? tokenStore?.owner_open_id ?? null;
}

export function saveOwnerOpenId(openId: string): void {
  if (!openId) return;
  // Persist into current token store (create a stub if no token yet — rare edge case)
  if (tokenStore) {
    tokenStore = { ...tokenStore, owner_open_id: openId };
    saveTokenFile(tokenStore);
  } else {
    // No token yet — write a minimal stub just to persist the open_id
    const stub: TokenStore = { access_token: '', refresh_token: '', expires_at: 0, owner_open_id: openId };
    saveTokenFile(stub);
  }
}

// ---------------------------------------------------------------------------
// Startup: load token and schedule refresh
// ---------------------------------------------------------------------------

export function initAuth() {
  tokenStore = loadTokenFile();
  if (tokenStore) {
    scheduleRefresh();
    if (tokenStore.granted_scopes?.length) {
      for (const s of tokenStore.granted_scopes) _grantedScopes.add(s);
      process.stderr.write(`[lark-mcp] Loaded auth token (expires ${new Date(tokenStore.expires_at).toISOString()}, scopes: ${tokenStore.granted_scopes.join(' ')})\n`);
    } else {
      process.stderr.write(`[lark-mcp] Loaded auth token (expires ${new Date(tokenStore.expires_at).toISOString()})\n`);
    }
  } else {
    process.stderr.write('[lark-mcp] No auth token found. Use feishu_auth_init to authenticate.\n');
  }
}

function scheduleRefresh() {
  if (!tokenStore) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  const delay = Math.max(tokenStore.expires_at - Date.now() - 5 * 60_000, 30_000); // 5 min before expiry
  refreshTimer = setTimeout(async () => {
    try {
      await doRefresh();
      scheduleRefresh();
    } catch (err) {
      process.stderr.write(`[lark-mcp] Token refresh failed: ${err}\n`);
    }
  }, delay);
  refreshTimer.unref(); // don't keep process alive just for this
}

async function doRefresh(): Promise<void> {
  if (!tokenStore) return;
  const appId = process.env.LARK_APP_ID!;
  const appSecret = process.env.LARK_APP_SECRET!;
  const tat = await getTenantAccessToken(appId, appSecret);

  const res = await new Promise<any>((resolve, reject) => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: appId, client_secret: appSecret, refresh_token: tokenStore!.refresh_token }).toString();
    const req = https.request(
      { hostname: 'open.feishu.cn', path: '/open-apis/authen/v2/oauth/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let r = ''; res.on('data', (c) => (r += c)); res.on('end', () => resolve(JSON.parse(r))); },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (res.error) throw new Error(`Refresh error: ${res.error}`);
  const expiresIn = res.expires_in ?? 7200;
  tokenStore = {
    access_token: res.access_token,
    refresh_token: res.refresh_token ?? tokenStore!.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    owner_open_id: tokenStore?.owner_open_id,
    granted_scopes: tokenStore?.granted_scopes, // preserve across refreshes
  };
  saveTokenFile(tokenStore);
  process.stderr.write(`[lark-mcp] Token refreshed (expires ${new Date(tokenStore.expires_at).toISOString()})\n`);
}

// ---------------------------------------------------------------------------
// Device flow — step 1: get device_code + verification_url
// ---------------------------------------------------------------------------

export interface DeviceFlowInit {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
  expires_in: number;
}

export async function startDeviceFlow(appId: string, appSecret: string, scope: string): Promise<DeviceFlowInit> {
  // accounts.feishu.cn endpoint, form-encoded body, no auth header needed
  const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, scope }).toString();
  const res = await new Promise<any>((resolve, reject) => {
    const req = https.request(
      { hostname: 'accounts.feishu.cn', path: '/oauth/v1/device_authorization', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d))); },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (res.error) throw new Error(`Device auth error: ${res.error} — ${res.error_description ?? ''}`);
  // API returns verification_uri, normalize to verification_url
  return {
    device_code:      res.device_code,
    user_code:        res.user_code,
    verification_url: res.verification_uri_complete ?? res.verification_uri,
    interval:         res.interval ?? 5,
    expires_in:       res.expires_in ?? 300,
  };
}

// ---------------------------------------------------------------------------
// Device flow — step 2: poll until token arrives
// ---------------------------------------------------------------------------

export async function pollDeviceToken(
  appId: string, appSecret: string, deviceCode: string, interval: number,
): Promise<void> {
  const tat = await getTenantAccessToken(appId, appSecret);
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let pollInterval = (interval ?? 5) * 1000;
  const deadline = Date.now() + 10 * 60_000; // 10 min max

  while (Date.now() < deadline) {
    await wait(pollInterval);
    const res = await new Promise<any>((resolve, reject) => {
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: appId, client_secret: appSecret, device_code: deviceCode }).toString();
      const req = https.request(
        { hostname: 'open.feishu.cn', path: '/open-apis/authen/v2/oauth/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
        (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d))); },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    if (!res.error && res.access_token) {
      const expiresIn = res.expires_in ?? 7200;
      tokenStore = {
        access_token: res.access_token,
        refresh_token: res.refresh_token,
        expires_at: Date.now() + expiresIn * 1000,
        owner_open_id: tokenStore?.owner_open_id,
      };
      saveTokenFile(tokenStore);
      scheduleRefresh();
      process.stderr.write(`[lark-mcp] Auth complete (expires ${new Date(tokenStore.expires_at).toISOString()})\n`);
      return;
    }
    const errCode = res.error ?? res.code;
    if (errCode === 'authorization_pending' || errCode === 91031) { continue; }
    if (errCode === 'slow_down' || errCode === 91032) { pollInterval += 5000; continue; }
    throw new Error(`Poll error: ${JSON.stringify(res)}`);
  }
  throw new Error('Auth timed out after 10 minutes');
}
