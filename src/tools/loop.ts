/**
 * Messaging loop tools — watch loop, schedules, and interactive card sending.
 *
 * These tools are optional: users who only need basic messaging can omit this
 * module. Includes:
 *   feishu_im_watch         — blocking watch loop for real-time messages
 *   feishu_schedule_*       — timed reminders integrated with the watch loop
 *   feishu_im_send_confirm  — send a confirm/cancel card, optional blocking wait
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLarkClient, withAuth } from '../client.js';
import { detectIdType } from './im.js';
import { buildProgressCard, ProgressStep } from '../cards/progress.js';
import {
  getMessageQueue, drainCallbackQueue,
  getSchedules, createSchedule, deleteSchedule, drainFiredSchedules,
  registerProgress, getProgressState, updateProgress, removeProgress, consumeStopSignal,
} from '../ws.js';
import {
  registerCard, removeCard, drainExpiredCards,
  buildConfirmActiveCard, buildConfirmExpiredCard,
  buildFormActiveCard, buildFormExpiredCard,
  CardEntry, FormField,
} from '../card-registry.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// TODO: delete after poll-removal confirmed stable
// import { isWsActive } from '../ws.js';
// const lastSeenMs = new Map<string, number>();
// async function checkOnce(client: any, chat_id: string): Promise<...> {
//   const res = await client.im.message.list({ params: { container_id_type: 'chat', container_id: chat_id, page_size: 20, sort_type: 'ByCreateTimeDesc' } });
//   if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
//   const since = lastSeenMs.get(chat_id)!;
//   return (res.data?.items ?? []).filter(...).map(...);
// }
// schema: poll_interval: z.number().int().min(2).max(30).default(10).optional()
// loop:   const newMessages = isWsActive() ? drainQueue(chat_id) : await checkOnce(client, chat_id);
//         if (newMessages.length > 0) {
//           const maxTs = Math.max(...newMessages.map(m => m.create_time));
//           if (maxTs > (lastSeenMs.get(chat_id) ?? 0)) lastSeenMs.set(chat_id, maxTs);
//         }

/** Drain queued messages from the WS event queue.
 *  If chat_id is provided, filters to that chat only.
 *  If chat_id is undefined, drains ALL messages from all chats. */
function drainQueue(chat_id: string | undefined) {
  const queue = getMessageQueue();
  const matching: (typeof queue[0])[] = [];
  for (let i = queue.length - 1; i >= 0; i--) {
    if (chat_id === undefined || queue[i].chat_id === chat_id) {
      matching.unshift(queue.splice(i, 1)[0]);
    }
  }
  return matching;
}

const COLLECT_IDLE_MS = 5_000;  // return once this many ms pass with no new message

async function patchCard(message_id: string, cardJson: object) {
  try {
    const client = getLarkClient();
    await (client as any).im.message.patch({
      path: { message_id },
      data: { content: JSON.stringify(cardJson) },
    });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------

export function registerLoopTools(server: McpServer) {
  // ── watch ──────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_watch',
    [
      'Wait for incoming Feishu events (messages, card callbacks, cron schedules). Blocking — do NOT call in parallel.',
      '',
      'Returns when: a user message arrives, a card button is clicked, or a scheduled reminder fires.',
      'On return: handle the event, reply via feishu_im_send, then call watch again immediately.',
      'On timed_out: call watch again immediately — no action needed.',
      '',
      'chat_id (oc_xxx): watch a single chat. Omit to watch all chats (chat_id shown per message).',
      'timeout: max minutes before returning timed_out. Default 360.',
    ].join('\n'),
    {
      chat_id: z.string().optional().describe('Chat to monitor (oc_xxx). Omit to watch all chats.'),
      timeout: z.number().int().min(1).max(360).default(360).optional()
                 .describe('Max minutes before timed_out. Default 360.'),
    },
    async ({ chat_id, timeout = 360 }) => withAuth(async () => {
      const deadline = Date.now() + timeout * 60 * 1000;
      const watchStart = Date.now(); // messages older than this were queued before the watch started
      const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

      type MsgLine = { source: 'live' | 'queued'; time: string; texts: string[]; reply_to: string; chat_id?: string };

      /** Build the final tool result as a human-readable string.
       *  Hierarchy: sender → queued/live lines → merged texts. */
      function buildResult(
        batch: ReturnType<typeof drainQueue>,
        batchCallbacks: ReturnType<typeof drainCallbackQueue>,
        firedSchedules: ReturnType<typeof drainFiredSchedules>,
      ): string {
        // Group by sender, preserving order of first appearance
        const bySender = new Map<string, MsgLine[]>();
        let lastReplyTo: string | undefined;

        for (const m of batch) {
          let text: string;
          if (typeof m.content === 'string') {
            text = m.content;
          } else if (m.msg_type === 'text') {
            text = m.content?.text ?? '[empty text]';
          } else if (m.msg_type === 'image') {
            text = `[image image_key=${m.content?.image_key ?? '?'} message_id=${m.message_id}]`;
          } else if (m.msg_type === 'file' || m.msg_type === 'media') {
            text = `[${m.msg_type} file_key=${m.content?.file_key ?? '?'} name="${m.content?.file_name ?? '?'}" message_id=${m.message_id}]`;
          } else {
            text = JSON.stringify(m.content);
          }
          // Include date + time: "2026-04-03 19:45"
          const dt = new Date(m.create_time);
          const dateStr = dt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // "YYYY-MM-DD"
          const timeStr = dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
          const datetime = `${dateStr} ${timeStr}`;
          const source: 'live' | 'queued' = m.create_time >= watchStart ? 'live' : 'queued';

          // Key: sender + chat_id (so multi-chat watching groups per chat per sender)
          const key = `${m.sender_id}|${m.chat_id ?? ''}`;
          if (!bySender.has(key)) bySender.set(key, []);
          const lines = bySender.get(key)!;
          const last = lines[lines.length - 1];
          // Merge consecutive messages from same sender+chat with same source
          if (last && last.source === source) {
            last.texts.push(text);
            last.reply_to = m.message_id;
          } else {
            const line: MsgLine = { source, time: datetime, texts: [text], reply_to: m.message_id };
            if (chat_id === undefined) line.chat_id = m.chat_id;
            lines.push(line);
          }

          if (source === 'live') lastReplyTo = m.message_id;
        }

        const parts: string[] = [];

        for (const [key, lines] of bySender) {
          const [senderId, chatId] = key.split('|');
          // Only show chat_id in header when watching all chats (otherwise it's always the same)
          const chatPart = (chatId && chat_id === undefined) ? `  chat: ${chatId}` : '';
          parts.push(`user: ${senderId}${chatPart}`);

          const hasQueued = lines.some(l => l.source === 'queued');
          const hasLive   = lines.some(l => l.source === 'live');

          // Render queued lines first, then separator, then live lines
          for (const line of lines.filter(l => l.source === 'queued')) {
            const content = line.texts.map(t => `"${t}"`).join(' / ');
            parts.push(`  [queued] ${line.time}  ${content}`);
          }
          if (hasQueued) {
            parts.push('  (sent earlier — no urgent reply needed)');
            if (hasLive) parts.push('');
          }
          for (const line of lines.filter(l => l.source === 'live')) {
            const content = line.texts.map(t => `"${t}"`).join(' / ');
            parts.push(`  [live]   ${line.time}  ${content}  message_id: ${line.reply_to}`);
          }
        }

        if (firedSchedules.length > 0) {
          parts.push('');
          parts.push('[schedules fired]');
          parts.push(JSON.stringify(firedSchedules, null, 2));
        }

        if (batchCallbacks.length > 0) {
          parts.push('');
          parts.push('[card callbacks]');
          parts.push(JSON.stringify(batchCallbacks, null, 2));
        }

        parts.push('');
        parts.push('Reply via feishu_im_send — response not visible in MCP client, must send via Feishu.');

        return parts.join('\n');
      }

      let firstCheck = true;
      while (Date.now() < deadline) {
        if (!firstCheck) await wait(500);
        firstCheck = false;

        // Expire registered cards and patch them (fire-and-forget)
        for (const { message_id, entry } of drainExpiredCards()) {
          const expiredCard = entry.card_type === 'form'
            ? buildFormExpiredCard(entry)
            : buildConfirmExpiredCard(entry);
          void patchCard(message_id, expiredCard);
        }

        const fired       = drainFiredSchedules();
        const callbacks   = drainCallbackQueue();
        const newMessages = drainQueue(chat_id);

        // Card callbacks → return immediately (user clicked a button, no batching needed)
        if (callbacks.length > 0) {
          return buildResult(newMessages, callbacks, fired);
        }

        if (newMessages.length > 0) {
          // ── Collection window ─────────────────────────────────────────────
          // Accumulate messages until 5 seconds of silence, then return all.
          const batch = [...newMessages];
          const batchCallbacks = [...callbacks];
          const batchFired = [...fired];
          let idleStart = Date.now();

          while (Date.now() - idleStart < COLLECT_IDLE_MS) {
            await wait(300);

            for (const { message_id, entry } of drainExpiredCards()) {
              const expiredCard = entry.card_type === 'form'
                ? buildFormExpiredCard(entry)
                : buildConfirmExpiredCard(entry);
              void patchCard(message_id, expiredCard);
            }

            const moreCbs   = drainCallbackQueue();
            const more      = drainQueue(chat_id);
            const moreFired = drainFiredSchedules();
            if (moreFired.length > 0) batchFired.push(...moreFired);
            if (moreCbs.length > 0) {
              batchCallbacks.push(...moreCbs);
              break; // flush immediately on callback
            }
            if (more.length > 0) {
              batch.push(...more);
              idleStart = Date.now(); // reset idle timer on any new message
            }
          }

          return buildResult(batch, batchCallbacks, batchFired);
        }

        if (fired.length > 0) {
          return buildResult([], [], fired);
        }
      }

      return 'feishu_im_watch timed out without any new messages. Please re-execute feishu_im_watch to resume listening.';
    }),
  );

  // ── schedule_create ────────────────────────────────────────────────────────
  server.tool(
    'feishu_schedule_create',
    [
      'Create a timed schedule that feishu_im_watch will fire when the time arrives.',
      '',
      'ONE-SHOT: provide fire_at (ISO 8601 with timezone, e.g. "2026-03-14T15:00:00+08:00").',
      'RECURRING: provide cron (standard 5-field cron expression, e.g. "0 9 * * *" = daily at 09:00).',
      '  Optionally also provide fire_at to override the first occurrence.',
      '  timezone: IANA timezone for cron evaluation (default Asia/Shanghai).',
      '',
      'Cron examples:',
      '  "0 9 * * *"    — every day at 09:00',
      '  "0 9 * * 1-5"  — every weekday at 09:00',
      '  "*/30 * * * *" — every 30 minutes',
      '  "0 8 * * 1"    — every Monday at 08:00',
    ].join('\n'),
    {
      label:    z.string().describe('Human-readable description, returned in fired_schedules'),
      fire_at:  z.string().optional().describe('ISO 8601 datetime for one-shot (or first occurrence override)'),
      cron:     z.string().optional().describe('5-field cron expression for recurring schedule'),
      timezone: z.string().optional().describe('IANA timezone for cron (default: Asia/Shanghai)'),
    },
    async ({ label, fire_at, cron, timezone }) => {
      if (!fire_at && !cron) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide either fire_at or cron' }) }] };
      }
      const result = createSchedule(fire_at ?? null, label, cron, timezone ?? 'Asia/Shanghai');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool('feishu_schedule_list', 'List all pending schedules.', {}, async () => {
    const schedules = getSchedules().map(s => ({ id: s.id, label: s.label, fire_at: s.fire_at_iso }));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ schedules }) }] };
  });

  server.tool('feishu_schedule_delete', 'Delete a pending schedule by ID.',
    { id: z.string().describe('Schedule ID') },
    async ({ id }) => {
      const ok = deleteSchedule(id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: ok, id }) }] };
    },
  );

  // ── send_confirm ───────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_send_confirm',
    [
      'Send a confirm/cancel interactive card and optionally block until the user responds.',
      '',
      'blocking=false (default): returns immediately with message_id + expires_at.',
      '  The user\'s click is returned in the next feishu_im_watch call as card_callbacks.',
      '  The card updates itself inline automatically.',
      '',
      'blocking=true: waits for the user to click (or timeout), then returns action="confirm"|"cancel"|"timeout".',
      '  The card updates itself inline on click; on timeout it is patched to 已失效.',
    ].join('\n'),
    {
      receive_id:      z.string().describe('open_id (ou_xxx) or chat_id (oc_xxx)'),
      title:           z.string().describe('Card title'),
      body:            z.string().optional().describe('Card body text (markdown)'),
      confirm_label:   z.string().default('确认').optional().describe('Confirm button label'),
      cancel_label:    z.string().default('取消').optional().describe('Cancel button label'),
      template:        z.enum(['red', 'orange', 'blue', 'green', 'grey', 'wathet']).default('red').optional()
                         .describe('Card header colour. red (default) = destructive, blue = informational/non-dangerous.'),
      blocking:        z.boolean().default(false).optional()
                         .describe('If true, block until user clicks or timeout'),
      timeout_seconds: z.number().int().min(10).max(86400).default(3600).optional()
                         .describe('Seconds before the card expires. Default 3600 (1 hour).'),
    },
    async ({ receive_id, title, body, confirm_label = '确认', cancel_label = '取消', template = 'red', blocking = false, timeout_seconds = 3600 }) =>
      withAuth(async () => {
        const client = getLarkClient();

        const entryBase = { card_type: 'confirm' as const, title, body, confirm_label, cancel_label, template };
        const card = buildConfirmActiveCard(entryBase);

        // Send the card
        const res = await (client as any).im.message.create({
          params: { receive_id_type: detectIdType(receive_id) },
          data: { receive_id, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
        const message_id = res.data?.message_id as string;
        const expiry_at  = Date.now() + timeout_seconds * 1000;
        const expires_at = new Date(expiry_at).toISOString();

        if (blocking) {
          // Create a Promise that resolves when the user clicks
          let resolveCallback!: (r: { action: string }) => void;
          const callbackPromise = new Promise<{ action: string }>(res => { resolveCallback = res; });

          const entry: CardEntry = { ...entryBase, expiry_at, resolve: resolveCallback };
          registerCard(message_id, entry);

          const timeoutPromise = new Promise<{ action: string }>(res =>
            setTimeout(() => res({ action: 'timeout' }), timeout_seconds * 1000),
          );

          const result = await Promise.race([callbackPromise, timeoutPromise]);
          removeCard(message_id); // ensure cleanup

          if (result.action === 'timeout') {
            void patchCard(message_id, buildConfirmExpiredCard(entryBase));
            return { message_id, action: 'timeout', timed_out: true };
          }
          return { message_id, action: result.action, timed_out: false };
        }

        // Non-blocking: register and return
        registerCard(message_id, { ...entryBase, expiry_at });
        return { message_id, expires_at, timed_out: false };
      }),
  );

  // ── send_form ───────────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_send_form',
    [
      'Send a form card with dynamic fields and optionally block until the user submits.',
      '',
      'Each field has: name (key in result), label, optional placeholder, required, hidden.',
      'hidden=true renders the field as a password input (shows ****** after submission).',
      '',
      'blocking=false (default): returns immediately with message_id + expires_at.',
      '  The submitted form_value is returned in the next feishu_im_watch call as card_callbacks.',
      '',
      'blocking=true: waits for submission (or timeout), then returns form_value map.',
      '  The card updates to a disabled submitted state on submit; to expired on timeout.',
    ].join('\n'),
    {
      receive_id:      z.string().describe('open_id (ou_xxx) or chat_id (oc_xxx)'),
      title:           z.string().describe('Card title'),
      body:            z.string().optional().describe('Card body text (markdown), shown above the form'),
      fields:          z.array(z.object({
                         name:        z.string().describe('Field key — used as key in form_value output'),
                         label:       z.string().describe('Field label shown to the user'),
                         placeholder: z.string().optional().describe('Placeholder hint text'),
                         required:    z.boolean().optional().describe('If true, Lark blocks submission until filled'),
                         hidden:      z.boolean().optional().describe('If true, renders as password input'),
                       })).min(1).describe('Form fields'),
      submit_label:    z.string().default('提交').optional().describe('Submit button label'),
      blocking:        z.boolean().default(false).optional()
                         .describe('If true, block until user submits or timeout'),
      timeout_seconds: z.number().int().min(10).max(86400).default(3600).optional()
                         .describe('Seconds before the card expires. Default 3600 (1 hour).'),
    },
    async ({ receive_id, title, body, fields, submit_label = '提交', blocking = false, timeout_seconds = 3600 }) =>
      withAuth(async () => {
        const client = getLarkClient();

        const entryBase = {
          card_type: 'form' as const,
          title, body,
          confirm_label: '', cancel_label: '',   // unused for form
          fields: fields as FormField[],
          submit_label,
        };
        const card = buildFormActiveCard(entryBase);

        const res = await (client as any).im.message.create({
          params: { receive_id_type: detectIdType(receive_id) },
          data: { receive_id, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
        const message_id = res.data?.message_id as string;
        const expiry_at  = Date.now() + timeout_seconds * 1000;
        const expires_at = new Date(expiry_at).toISOString();

        if (blocking) {
          let resolveCallback!: (r: { action: string; form_value?: Record<string, string> }) => void;
          const callbackPromise = new Promise<{ action: string; form_value?: Record<string, string> }>(res => { resolveCallback = res; });

          registerCard(message_id, { ...entryBase, expiry_at, resolve: resolveCallback });

          const timeoutPromise = new Promise<{ action: string; form_value?: Record<string, string> }>(res =>
            setTimeout(() => res({ action: 'timeout' }), timeout_seconds * 1000),
          );

          const result = await Promise.race([callbackPromise, timeoutPromise]);
          removeCard(message_id);

          if (result.action === 'timeout') {
            void patchCard(message_id, buildFormExpiredCard(entryBase));
            return { message_id, form_value: {}, timed_out: true };
          }
          return { message_id, form_value: result.form_value ?? {}, timed_out: false };
        }

        // Non-blocking: register and return
        registerCard(message_id, { ...entryBase, expiry_at });
        return { message_id, expires_at, timed_out: false };
      }),
  );

  // ── send_progress ───────────────────────────────────────────────────────────
  const stepSchema = z.object({
    label:  z.string().describe('Step label'),
    detail: z.string().optional().describe('Expanded detail text (shown when panel is open)'),
  });

  server.tool(
    'feishu_im_send_progress',
    [
      'Send a progress card showing a multi-step task status.',
      'Returns message_id — pass it to feishu_im_patch_progress to advance the steps.',
      'current_step=0 starts at the first step. percent is auto-calculated.',
    ].join('\n'),
    {
      receive_id:      z.string().describe('open_id (ou_xxx) or chat_id (oc_xxx)'),
      title:           z.string().describe('Card title'),
      steps:           z.array(stepSchema).min(1).describe('Ordered list of steps'),
      current_step:    z.number().int().min(0).default(0).optional()
                         .describe('0-based index of the active step. Default 0.'),
    },
    async ({ receive_id, title, steps, current_step = 0 }) =>
      withAuth(async () => {
        const client = getLarkClient();
        const card = buildProgressCard(title, steps as ProgressStep[], current_step);
        const res = await (client as any).im.message.create({
          params: { receive_id_type: detectIdType(receive_id) },
          data: { receive_id, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
        const message_id = res.data?.message_id as string;
        registerProgress(message_id, title, steps as ProgressStep[]);
        return { message_id };
      }),
  );

  // ── patch_progress ──────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_patch_progress',
    [
      'Update a progress card sent by feishu_im_send_progress.',
      'title and steps are cached server-side — only pass message_id and current_step.',
      'Pass current_step = steps.length to render the completed state (green header, 100%).',
      'Use step_updates to revise detail text on specific steps (e.g. add result summaries).',
      'Returns result: a short plain-English sentence describing what happened (updated / done / user asked to stop).',
    ].join('\n'),
    {
      message_id:   z.string().describe('message_id from feishu_im_send_progress'),
      current_step: z.number().int().min(0).describe(
        '0-based active step index. Pass steps.length for completed state.',
      ),
      step_updates: z.array(z.object({
        index:  z.number().int().min(0).describe('0-based step index to update'),
        detail: z.string().describe('New detail text for this step'),
      })).optional().describe('Optional per-step detail updates'),
    },
    async ({ message_id, current_step, step_updates }) =>
      withAuth(async () => {
        // Check stop signal first — user pressed Stop, don't patch
        if (consumeStopSignal(message_id)) {
          return { message_id, result: 'User asked to stop — abort the task.' };
        }

        const state = getProgressState(message_id);
        if (!state) throw new Error(`Progress card state not found for ${message_id}. Was it sent with feishu_im_send_progress?`);

        let { steps } = state;
        if (step_updates?.length) {
          steps = steps.map((s, i) => {
            const u = step_updates.find(u => u.index === i);
            return u ? { ...s, detail: u.detail } : s;
          });
        }

        updateProgress(message_id, current_step, steps);
        const card = buildProgressCard(state.title, steps, current_step);
        await patchCard(message_id, card);

        const done = current_step >= steps.length;
        if (done) removeProgress(message_id);
        return { message_id, result: done ? 'Task complete.' : 'Updated.' };
      }),
  );
}
