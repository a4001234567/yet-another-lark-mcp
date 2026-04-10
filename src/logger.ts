/**
 * Simple append-only NDJSON logger for lark-mcp.
 * Writes to ~/.config/lark-mcp/lark-mcp.log
 *
 * Two event types:
 *   {"ts":"...","event":"message","from":"ou_xxx","chat_id":"oc_xxx","text":"..."}
 *   {"ts":"...","event":"tool_call","tool":"feishu_im_send","params":{...},"ok":true,"ms":142}
 *
 * Rotation: when lark-mcp.log exceeds MAX_LOG_BYTES (5 MB), it is renamed to
 * lark-mcp.log.old (overwriting any previous .old file) and a fresh log is started.
 * At most ~10 MB of disk space is used at any time.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_DIR  = join(homedir(), '.config', 'lark-mcp');
const LOG_FILE = join(LOG_DIR, 'lark-mcp.log');
const LOG_OLD  = join(LOG_DIR, 'lark-mcp.log.old');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* already exists */ }

// ── Internal write ──────────────────────────────────────────────────────────

function rotateIfNeeded(): void {
  try {
    const size = statSync(LOG_FILE).size;
    if (size >= MAX_LOG_BYTES) renameSync(LOG_FILE, LOG_OLD);
  } catch { /* file doesn't exist yet — fine */ }
}

function write(entry: object): void {
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* never throw from logger */ }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Log an incoming Feishu message (called from ws.ts). */
export function logMessage(opts: {
  from:     string;
  chat_id:  string;
  msg_type: string;
  content:  any;
}): void {
  const text = opts.msg_type === 'text'
    ? String(opts.content?.text ?? '').slice(0, 300)
    : `[${opts.msg_type}]`;
  write({ event: 'message', from: opts.from, chat_id: opts.chat_id, text });
}

/** Log a tool call (called via the server.tool wrapper in index.ts). */
export function logToolCall(tool: string, params: Record<string, unknown>, ok: boolean, ms: number): void {
  write({ event: 'tool_call', tool, params: sanitize(params), ok, ms });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Params that are large or not useful to log
const OMIT = new Set(['card', 'post_rows', 'image_path', 'file_path', 'file_name']);

function sanitize(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (OMIT.has(k)) { out[k] = '[omitted]'; continue; }
    if (typeof v === 'string' && v.length > 200) { out[k] = v.slice(0, 200) + '…'; continue; }
    out[k] = v;
  }
  return out;
}
