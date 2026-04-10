/**
 * feishu_task_* MCP tools — ported from the personal plugin's task.ts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLarkClient, asUser } from '../client.js';
import { withModuleAuth } from '../auth-guard.js';

const TZ = () => process.env.LARK_TIMEZONE ?? 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function getUtcOffsetHours(tz: string): number {
  const now = new Date();
  const utcStr = now.toLocaleString('sv-SE', { timeZone: 'UTC' });
  const tzStr  = now.toLocaleString('sv-SE', { timeZone: tz });
  return (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / 3_600_000;
}

function parseTimeMs(input: string, tz: string): { ms: number; is_all_day: boolean } {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const offsetH = getUtcOffsetHours(tz);
    return { ms: new Date(s).getTime() - offsetH * 3_600_000, is_all_day: true };
  }
  const match = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (match) {
    const offsetH = getUtcOffsetHours(tz);
    return { ms: new Date(`${match[1]}T${match[2]}:00`).getTime() - offsetH * 3_600_000, is_all_day: false };
  }
  return { ms: new Date(s).getTime(), is_all_day: false };
}

function formatMs(ms: string | number, tz: string): string {
  return new Date(typeof ms === 'string' ? parseInt(ms) : ms)
    .toLocaleString('sv-SE', { timeZone: tz })
    .slice(0, 16);
}

function toDueTime(input: string, tz: string) {
  const t = parseTimeMs(input, tz);
  return { timestamp: String(t.ms), is_all_day: t.is_all_day };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtTask(t: any): any {
  const tz = TZ();
  const isCompleted = t.completed_at && t.completed_at !== '0';
  return {
    task_guid:    t.guid,
    summary:      t.summary,
    completed:    isCompleted,
    completed_at: isCompleted ? formatMs(t.completed_at, tz) : undefined,
    due:          t.due?.timestamp   ? formatMs(t.due.timestamp,   tz) : undefined,
    start:        t.start?.timestamp ? formatMs(t.start.timestamp, tz) : undefined,
    description:  t.description || undefined,
  };
}

function fmtList(l: any) {
  return { tasklist_guid: l.guid, name: l.name, creator_id: l.creator?.id ?? undefined };
}

async function getMyOpenId(): Promise<string | undefined> {
  const client = getLarkClient();
  const res = await (client.authen as any).userInfo.get({}, asUser());
  return res.data?.open_id ?? res.data?.user_info?.open_id;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTaskTools(server: McpServer) {
  // ── create ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_create',
    'Create a task. Automatically assigns it to you so it appears in your task list.',
    {
      summary:       z.string().describe('Task title'),
      description:   z.string().optional(),
      due:           z.string().optional().describe('"YYYY-MM-DD" or "YYYY-MM-DD HH:MM"'),
      start:         z.string().optional().describe('"YYYY-MM-DD" or "YYYY-MM-DD HH:MM"'),
      assignee_id:   z.string().optional().describe('Assign to someone else (open_id). You become follower.'),
      tasklist_guid: z.string().optional().describe('File into this tasklist at creation time'),
    },
    async (p) => withModuleAuth('task', async () => {
      const tz = TZ();
      if (p.due)   toDueTime(p.due,   tz);
      if (p.start) toDueTime(p.start, tz);

      const myOpenId = await getMyOpenId();
      const data: any = { summary: p.summary };
      if (p.description)   data.description = p.description;
      if (p.due)           data.due          = toDueTime(p.due,   tz);
      if (p.start)         data.start        = toDueTime(p.start, tz);
      if (p.tasklist_guid) data.tasklists    = [{ tasklist_guid: p.tasklist_guid }];

      const members: any[] = [];
      if (p.assignee_id) {
        members.push({ id: p.assignee_id, type: 'user', role: 'assignee' });
        if (myOpenId && myOpenId !== p.assignee_id) {
          members.push({ id: myOpenId, type: 'user', role: 'follower' });
        }
      } else if (myOpenId) {
        members.push({ id: myOpenId, type: 'user', role: 'assignee' });
      }
      if (members.length > 0) data.members = members;

      const client = getLarkClient();
      const res = await (client.task.v2.task as any).create({ data }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      const task = res.data?.task;
      return { task_guid: task?.guid, summary: task?.summary, due: task?.due?.timestamp ? formatMs(task.due.timestamp, tz) : undefined };
    }),
  );

  // ── list ───────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_list',
    'List tasks. Without tasklist_guid, returns "My Tasks" (tasks where you are a member).',
    {
      completed:     z.boolean().optional().describe('false = pending, true = done, omit = all'),
      query:         z.string().optional().describe('Keyword filter (client-side)'),
      page_size:     z.number().int().default(50).optional(),
      tasklist_guid: z.string().optional().describe('List tasks from this tasklist instead of "My Tasks"'),
    },
    async (p) => withModuleAuth('task', async () => {
      const client = getLarkClient();
      let items: any[];
      if (p.tasklist_guid) {
        const params: any = { page_size: p.page_size ?? 50 };
        if (p.completed !== undefined) params.completed = p.completed;
        const res = await (client.task.v2.tasklist as any).tasks(
          { path: { tasklist_guid: p.tasklist_guid }, params }, asUser(),
        );
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
        items = res.data?.items ?? [];
      } else {
        const params: any = { page_size: p.page_size ?? 50 };
        if (p.completed !== undefined) params.completed = p.completed;
        const res = await (client.task.v2.task as any).list({ params }, asUser());
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
        items = res.data?.items ?? [];
      }

      let tasks = items.map(fmtTask);
      if (p.query) {
        const q = p.query.toLowerCase();
        tasks = tasks.filter((t: any) =>
          t.summary?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
        );
      }
      return { tasks, count: tasks.length };
    }),
  );

  // ── patch ──────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_patch',
    'Update a task. Use completed:true to mark done, false to reopen. Use due:"none" to clear due date.',
    {
      task_guid:   z.string().describe('Task GUID'),
      summary:     z.string().optional(),
      description: z.string().optional(),
      due:         z.string().optional().describe('"YYYY-MM-DD HH:MM" or "none" to clear'),
      start:       z.string().optional().describe('"YYYY-MM-DD HH:MM" or "none" to clear'),
      completed:   z.boolean().optional().describe('true = done, false = reopen'),
    },
    async (p) => withModuleAuth('task', async () => {
      const tz = TZ();
      const task: any = {};
      const fields: string[] = [];

      if (p.summary     != null) { task.summary     = p.summary;     fields.push('summary'); }
      if (p.description != null) { task.description = p.description; fields.push('description'); }
      if (p.due != null) {
        fields.push('due');
        if (!p.due.toLowerCase().includes('none')) task.due = toDueTime(p.due, tz);
      }
      if (p.start != null) {
        fields.push('start');
        if (!p.start.toLowerCase().includes('none')) task.start = toDueTime(p.start, tz);
      }
      if (p.completed != null) {
        fields.push('completed_at');
        task.completed_at = p.completed ? String(Date.now()) : '0';
      }

      if (fields.length === 0) throw new Error('No fields to update');

      const client = getLarkClient();
      const res = await (client.task.v2.task as any).patch(
        { path: { task_guid: p.task_guid }, data: { task, update_fields: fields } }, asUser(),
      );
      if (res.code !== 0) {
        if (res.msg?.includes('already completed')) return { message: 'Task is already completed, no change needed' };
        if (res.code === 1470404) throw new Error('Task not found or already deleted');
        throw new Error(`Lark API ${res.code}: ${res.msg}`);
      }
      return { ok: true, task_guid: p.task_guid, updated: fields };
    }),
  );

  // ── delete ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_delete',
    'Delete a task.',
    { task_guid: z.string() },
    async ({ task_guid }) => withModuleAuth('task', async () => {
      const client = getLarkClient();
      const res = await (client.task.v2.task as any).delete({ path: { task_guid } }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, task_guid, deleted: true };
    }),
  );

  // ── list_lists ─────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_list_lists',
    'List all your tasklists.',
    { page_size: z.number().int().default(50).optional() },
    async ({ page_size }) => withModuleAuth('task', async () => {
      const client = getLarkClient();
      const res = await (client.task.v2.tasklist as any).list(
        { params: { page_size: page_size ?? 50, user_id_type: 'open_id' } }, asUser(),
      );
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      const lists = (res.data?.items ?? []).map(fmtList);
      return { lists, count: lists.length };
    }),
  );

  // ── create_list ────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_create_list',
    'Create a new tasklist.',
    { name: z.string().describe('Tasklist name') },
    async ({ name }) => withModuleAuth('task', async () => {
      const client = getLarkClient();
      const res = await (client.task.v2.tasklist as any).create({ data: { name } }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return fmtList(res.data?.tasklist ?? {});
    }),
  );

  // ── patch_list ─────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_patch_list',
    'Rename a tasklist.',
    { tasklist_guid: z.string(), name: z.string().describe('New name') },
    async ({ tasklist_guid, name }) => withModuleAuth('task', async () => {
      const client = getLarkClient();
      const res = await (client.task.v2.tasklist as any).patch(
        { path: { tasklist_guid }, data: { tasklist: { name }, update_fields: ['name'] } }, asUser(),
      );
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, tasklist_guid, name };
    }),
  );

  // ── delete_list ────────────────────────────────────────────────────────────
  server.tool(
    'feishu_task_delete_list',
    'Delete a tasklist.',
    { tasklist_guid: z.string() },
    async ({ tasklist_guid }) => withModuleAuth('task', async () => {
      const client = getLarkClient();
      const res = await (client.task.v2.tasklist as any).delete(
        { path: { tasklist_guid } }, asUser(),
      );
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, tasklist_guid, deleted: true };
    }),
  );
}
