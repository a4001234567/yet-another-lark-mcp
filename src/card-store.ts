/**
 * Card-state persistence — so interactive-card state survives across turns.
 *
 * Under the broker the MCP server is a per-turn child of claude: anything held
 * only in memory dies when the turn ends. That's fine for a card sent and
 * answered within one turn, but an *unanswered* card (confirm/form) or an
 * orphaned progress card outlives its turn — and the only way to later patch it
 * (e.g. grey it out once expired) is to remember what it looked like.
 *
 * Shape (appId-keyed, mirroring schedules.json):
 *   {
 *     "<appId>": {
 *       "registry": { "<msg_id>": CardEntry },
 *       "progress": { "<msg_id>": ProgressState }
 *     }
 *   }
 *
 * Sections are written independently (read-modify-write) so the two owners
 * (card-registry.ts and ws.ts) don't clobber each other.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DIR  = join(homedir(), '.config', 'lark-mcp');
const FILE = join(DIR, 'cards.json');

export type CardSection = 'registry' | 'progress';

function readAll(): Record<string, any> {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    if (raw && !Array.isArray(raw) && typeof raw === 'object') return raw;
  } catch { /* no file yet */ }
  return {};
}

function appId(): string { return process.env.LARK_APP_ID ?? '_'; }

/** Read one section for the current appId. Returns {} when absent or unparsable. */
export function loadCardSection<T>(section: CardSection): Record<string, T> {
  const mine = readAll()[appId()];
  const val  = mine && typeof mine === 'object' ? mine[section] : undefined;
  return (val && typeof val === 'object') ? (val as Record<string, T>) : {};
}

/** Overwrite one section for the current appId, preserving the other section. */
export function saveCardSection(section: CardSection, data: Record<string, any>): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const all  = readAll();
    const key  = appId();
    const mine = (all[key] && typeof all[key] === 'object') ? all[key] : {};
    mine[section] = data;
    all[key] = mine;
    writeFileSync(FILE, JSON.stringify(all, null, 2), 'utf-8');
  } catch { /* best-effort — persistence must never break a tool call */ }
}
