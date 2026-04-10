import { Cron } from 'croner';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Lark WebSocket long-connection event listener.
 *
 * Starts a persistent WSClient that receives im.message.receive_v1 events
 * from Lark and queues them in memory. feishu_im_watch consumes this queue
 * instead of polling im.message.list, giving true real-time delivery.
 *
 * Falls back gracefully: if the WSClient fails to start, wsActive stays false
 * and feishu_im_watch falls back to the original polling approach.
 *
 * Requirements:
 *   - App must have "Use long connection to receive events" enabled in Lark dev console
 *   - im:message event subscription must be configured
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { lookupCard, removeCard, buildConfirmRespondedCard, buildFormSubmittedCard } from './card-registry.js';
import { buildProgressCard, ProgressStep } from './cards/progress.js';
import { logMessage } from './logger.js';

export type QueuedMessage = {
  message_id:  string;
  sender_id:   string;
  chat_id:     string;
  create_time: number;
  msg_type:    string;
  content:     any;
  parent_id?:  string;  // set if this message is a reply to another message
};

/** A card action callback — fired when a user clicks a button or submits a form. */
export type QueuedCallback = {
  message_id: string;   // open_message_id — which card was interacted with
  open_id:    string;   // who clicked
  action:     string;   // callback value (button) or "form_submit" (form)
  value:      any;      // raw action.value object from Lark
  form_value: any;      // action.form_value (populated for form submissions)
  timestamp:  number;   // ms when received
};

// ── Schedule store ─────────────────────────────────────────────────────────
// Schedules are managed independently of the watch loop. The watch loop checks
// them on every tick and fires any that have passed their `fire_at` time.

export type Schedule = {
  id:          string;
  label:       string;   // human-readable description
  fire_at:     number;   // unix ms
  fire_at_iso: string;   // ISO string for display
  fired:       boolean;
  cron?:       string;   // if set, cron expression for recurring schedule
  timezone?:   string;   // timezone for cron evaluation
};

const _schedules: Schedule[] = [];
let _scheduleSeq = 1;

// ── Schedule persistence ───────────────────────────────────────────────────
const SCHEDULES_DIR  = join(homedir(), '.config', 'lark-mcp');
const SCHEDULES_FILE = join(SCHEDULES_DIR, 'schedules.json');

function saveSchedules(): void {
  try {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
    const appId = process.env.LARK_APP_ID;
    if (!appId) {
      // Fallback: write flat array (no appId — should not happen in normal use)
      writeFileSync(SCHEDULES_FILE, JSON.stringify(_schedules, null, 2), 'utf-8');
      return;
    }
    // Read existing file and update only this appId's entry
    let existing: Record<string, any> = {};
    try {
      const raw = JSON.parse(readFileSync(SCHEDULES_FILE, 'utf-8'));
      // If old flat array format, start fresh keyed store
      if (Array.isArray(raw)) existing = {};
      else existing = raw;
    } catch { /* start fresh */ }
    existing[appId] = _schedules;
    writeFileSync(SCHEDULES_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

function loadSchedules(): void {
  try {
    const raw = JSON.parse(readFileSync(SCHEDULES_FILE, 'utf-8'));
    const appId = process.env.LARK_APP_ID;
    let saved: Schedule[];
    if (Array.isArray(raw)) {
      // Legacy flat array — migrate in-place if appId known
      saved = raw as Schedule[];
      if (appId && saved.length > 0) {
        const migrated: Record<string, any> = { [appId]: saved };
        mkdirSync(SCHEDULES_DIR, { recursive: true });
        writeFileSync(SCHEDULES_FILE, JSON.stringify(migrated, null, 2), 'utf-8');
        process.stderr.write(`[lark-mcp] Migrated schedules.json to appId-keyed format (${appId})\n`);
      }
    } else {
      // New keyed format
      saved = (appId ? raw[appId] : null) ?? [];
    }
    const now = Date.now();
    // Restore: cron schedules always (will recompute next run); one-shot only if still in the future
    const toRestore = saved.filter((s: Schedule) => s.cron ? true : (s.fire_at > now && !s.fired));
    _schedules.push(...toRestore);
    if (toRestore.length > 0) {
      _scheduleSeq = Math.max(...toRestore.map((s: Schedule) => parseInt(s.id, 10))) + 1;
      process.stderr.write(`[lark-mcp] Restored ${toRestore.length} schedule(s) from disk\n`);
    }
  } catch { /* no file or parse error — start fresh */ }
}

// Load persisted schedules at module init
loadSchedules();

export function getSchedules(): Schedule[] { return _schedules; }

/** Compute next fire time from a cron expression (returns null if no future occurrence). */
function nextCronMs(expression: string, timezone?: string): number | null {
  try {
    const job = new Cron(expression, { timezone });
    const next = job.nextRun();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function createSchedule(
  fire_at_iso: string | null,
  label: string,
  cron?: string,
  timezone?: string,
): Schedule | { error: string } {
  if (cron) {
    // Cron-based: compute first occurrence
    const firstMs = nextCronMs(cron, timezone);
    if (firstMs === null) return { error: `Invalid or exhausted cron expression: "${cron}"` };
    const s: Schedule = {
      id: String(_scheduleSeq++), label,
      fire_at: firstMs, fire_at_iso: new Date(firstMs).toISOString(),
      fired: false, cron, timezone,
    };
    _schedules.push(s);
    saveSchedules();
    return s;
  }
  // One-shot: parse fire_at_iso
  const ts = new Date(fire_at_iso ?? '').getTime();
  if (isNaN(ts)) return { error: `Invalid datetime: "${fire_at_iso}"` };
  const s: Schedule = { id: String(_scheduleSeq++), label, fire_at: ts, fire_at_iso: fire_at_iso!, fired: false };
  _schedules.push(s);
  saveSchedules();
  return s;
}

export function deleteSchedule(id: string): boolean {
  const idx = _schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;
  _schedules.splice(idx, 1);
  saveSchedules();
  return true;
}

/** Return schedules whose fire_at has passed, remove them, and auto-reschedule cron ones. */
export function drainFiredSchedules(): Schedule[] {
  const now = Date.now();
  const fired = _schedules.filter(s => !s.fired && s.fire_at <= now);
  fired.forEach(s => {
    s.fired = true;
    _schedules.splice(_schedules.indexOf(s), 1);
    if (s.cron) {
      const nextMs = nextCronMs(s.cron, s.timezone);
      if (nextMs !== null) {
        _schedules.push({
          id: String(_scheduleSeq++), label: s.label,
          fire_at: nextMs, fire_at_iso: new Date(nextMs).toISOString(),
          fired: false, cron: s.cron, timezone: s.timezone,
        });
      }
    }
  });
  if (fired.length > 0) saveSchedules();
  return fired;
}

// ── Progress card state cache ──────────────────────────────────────────────
// Stores title/steps/currentStep so patch_progress doesn't need to resend them.

export type ProgressState = {
  title:       string;
  steps:       ProgressStep[];
  currentStep: number;
};

const progressStore  = new Map<string, ProgressState>();
const stopSignals    = new Set<string>();

export function registerProgress(message_id: string, title: string, steps: ProgressStep[]): void {
  progressStore.set(message_id, { title, steps, currentStep: 0 });
}

export function getProgressState(message_id: string): ProgressState | undefined {
  return progressStore.get(message_id);
}

export function updateProgress(message_id: string, currentStep: number, steps?: ProgressStep[]): void {
  const existing = progressStore.get(message_id);
  if (!existing) return;
  progressStore.set(message_id, {
    title: existing.title,
    steps: steps ?? existing.steps,
    currentStep,
  });
}

export function removeProgress(message_id: string): void {
  progressStore.delete(message_id);
  stopSignals.delete(message_id);
}

/** Returns true (and clears the signal) if the user pressed Stop on this progress card. */
export function consumeStopSignal(message_id: string): boolean {
  const has = stopSignals.has(message_id);
  if (has) stopSignals.delete(message_id);
  return has;
}

// In-memory queue of received messages. Capped at 500 to avoid unbounded growth.
const messageQueue: QueuedMessage[] = [];
// In-memory queue of card action callbacks.
const callbackQueue: QueuedCallback[] = [];
const MAX_QUEUE = 500;

// let _wsActive = false;
// export function isWsActive(): boolean { return _wsActive; } // TODO: delete after poll-removal confirmed stable

export function getMessageQueue(): QueuedMessage[] { return messageQueue; }
export function getCallbackQueue(): QueuedCallback[] { return callbackQueue; }

/** Drain and return all pending card callbacks. */
export function drainCallbackQueue(): QueuedCallback[] {
  return callbackQueue.splice(0, callbackQueue.length);
}


/** Patch a card message via the REST API. Must be called AFTER the WS callback response is sent. */
async function patchCardViaApi(message_id: string, cardJson: object): Promise<void> {
  try {
    // Lazy import to avoid circular dep — client module is initialized by the time this runs.
    const { getLarkClient } = await import('./client.js');
    const client = getLarkClient();
    await (client as any).im.message.patch({
      path: { message_id },
      data: { content: JSON.stringify(cardJson) },
    });
  } catch { /* best-effort */ }
}

/**
 * Attempt to start the WSClient. Resolves once the connection is up (or fails).
 * Non-blocking after connection — the client manages reconnects internally.
 */
export async function startWsClient(appId: string, appSecret: string): Promise<void> {
  const dispatcher = new lark.EventDispatcher({}).register({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'im.message.receive_v1': async (data: any) => {
      const msg = data?.message;
      if (!msg) return;
      // Only queue user messages (not bot echoes)
      if (data?.sender?.sender_type === 'app') return;

      let content = msg.content;
      try { content = JSON.parse(content); } catch { /* leave as string */ }

      const queued: QueuedMessage = {
        message_id:  msg.message_id ?? '',
        sender_id:   data?.sender?.sender_id?.open_id ?? '',
        chat_id:     msg.chat_id ?? '',
        create_time: parseInt(msg.create_time ?? '0', 10),
        msg_type:    msg.message_type ?? 'text',
        content,
        parent_id:   msg.parent_id || undefined,
      };

      messageQueue.push(queued);
      if (messageQueue.length > MAX_QUEUE) messageQueue.splice(0, messageQueue.length - MAX_QUEUE);
      logMessage({ from: queued.sender_id, chat_id: queued.chat_id, msg_type: queued.msg_type, content: queued.content });
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'card.action.trigger': async (data: any) => {
      const operator  = data?.operator;
      const context   = data?.context;
      const action    = data?.action;
      const messageId = context?.open_message_id ?? '';
      const actionStr = action?.value?.action ?? (action?.form_value !== undefined ? 'form_submit' : 'unknown');

      const cb: QueuedCallback = {
        message_id: messageId,
        open_id:    operator?.open_id ?? '',
        action:     actionStr,
        value:      action?.value ?? {},
        form_value: action?.form_value ?? {},
        timestamp:  Date.now(),
      };
      // Card updates: returned inline in the WS response as { card: { type: 'raw', data: ... } }.
      // The SDK monkey-patch (type="card"→"event") allows the EventDispatcher to route this
      // handler, and Lark correctly accepts the inline card update in the ack response.
      //
      // Blocking vs non-blocking routing:
      //   - Blocking cards are registered in card-registry. Resolve their Promise immediately
      //     and patch the card; do NOT queue — the blocking tool (send_confirm/send_form) is
      //     already awaiting the Promise, not the watch loop.
      //   - Non-blocking cards are not registered. Queue the callback so feishu_im_watch can
      //     return it to the AI on the next poll tick.
      //   - Poll mode does not produce card callback events at all (im.message.list does not
      //     include card actions), so this handler is only reached in WS mode.
      // Progress card stop button
      if (actionStr === 'stop' && progressStore.has(messageId)) {
        stopSignals.add(messageId);
        callbackQueue.push(cb);
        if (callbackQueue.length > MAX_QUEUE) callbackQueue.splice(0, callbackQueue.length - MAX_QUEUE);
        const state = progressStore.get(messageId)!;
        const stoppedCard = buildProgressCard(state.title, state.steps, state.currentStep, true);
        return {
          toast: { type: 'info', content: '已停止' },
          card: { type: 'raw', data: stoppedCard },
        };
      }

      const entry = lookupCard(messageId);
      if (entry) {
        removeCard(messageId);
        const formValue: Record<string, string> = action?.form_value ?? {};
        const respondedCard = entry.card_type === 'form'
          ? buildFormSubmittedCard(entry, formValue)
          : buildConfirmRespondedCard(entry, actionStr);
        const toastContent = entry.card_type === 'form' ? '已提交'
          : actionStr === 'confirm' ? '已确认' : '已取消';

        if (entry.resolve) {
          // Blocking: resolve the waiting Promise directly — do NOT queue
          entry.resolve({ action: actionStr, form_value: formValue });
        } else {
          // Non-blocking: queue for watch loop to pick up
          callbackQueue.push(cb);
          if (callbackQueue.length > MAX_QUEUE) callbackQueue.splice(0, callbackQueue.length - MAX_QUEUE);
        }

        return {
          toast: { type: entry.card_type === 'form' || actionStr === 'confirm' ? 'success' : 'info', content: toastContent },
          card: { type: 'raw', data: respondedCard },
        };
      }

      // Unregistered/expired card — queue and acknowledge
      callbackQueue.push(cb);
      if (callbackQueue.length > MAX_QUEUE) callbackQueue.splice(0, callbackQueue.length - MAX_QUEUE);
      return { toast: { type: 'info', content: '正在处理...' } };
    },
  });

  const wsClient = new lark.WSClient({ appId, appSecret });

  // The SDK's handleEventData only processes WS messages with type="event".
  // Card action callbacks arrive with type="card" and are silently discarded.
  // Patch: remap "card" → "event" so EventDispatcher routes them normally.
  // (Same technique used by the official OpenClaw plugin — see lark-client.js)
  const wsClientAny = wsClient as any;
  const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
  wsClientAny.handleEventData = (data: any) => {
    const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
    if (msgType === 'card') {
      return origHandleEventData({
        ...data,
        headers: data.headers.map((h: any) => h.key === 'type' ? { ...h, value: 'event' } : h),
      });
    }
    return origHandleEventData(data);
  };

  // WSClient.start() connects and then runs indefinitely (reconnects on drop).
  // We race it against a short timeout to detect connection success/failure.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    // Give WS 5 seconds to connect; if it does, mark active and continue.
    const timer = setTimeout(() => {
      // Timed out waiting for first connection — treat as failed
      process.stderr.write('[lark-mcp] WS connect timeout — using poll fallback\n');
      done();
    }, 5000);

    // start() resolves quickly (before the WS session ends) — the client continues
    // running in the background. Resolving without error means WS is active.
    wsClient.start({ eventDispatcher: dispatcher })
      .then(() => {
        clearTimeout(timer);
        // _wsActive = true; // TODO: delete after poll-removal confirmed stable
        process.stderr.write('[lark-mcp] WS long connection active\n');
        done();
      })
      .catch((err: Error) => {
        clearTimeout(timer);
        process.stderr.write(`[lark-mcp] WS error — using poll fallback: ${err.message}\n`);
        done();
      });

    // Safety: if start() never resolves/rejects within 5s, fall back to poll
    // (the 5s timer above already handles this via done() call).
  });
}
