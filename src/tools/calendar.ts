/**
 * feishu_calendar_* MCP tools — ported from the personal plugin's calendar.ts.
 * Uses direct Lark SDK calls instead of the plugin's ToolClient abstraction.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as lark from '@larksuiteoapi/node-sdk';
import { getLarkClient, asUser } from '../client.js';
import { getTenantAccessToken } from '../auth.js';
import { withModuleAuth } from '../auth-guard.js';

const TZ = () => process.env.LARK_TIMEZONE ?? 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// Time helpers (mirrors personal/time.ts)
// ---------------------------------------------------------------------------

function getUtcOffsetHours(tz: string): number {
  const now = new Date();
  const utcStr  = now.toLocaleString('sv-SE', { timeZone: 'UTC' });
  const tzStr   = now.toLocaleString('sv-SE', { timeZone: tz });
  return (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / 3_600_000;
}

function parseTime(input: string, tz: string): { sec: number; is_all_day: boolean } {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const offsetH = getUtcOffsetHours(tz);
    return { sec: (new Date(s).getTime() / 1000) - offsetH * 3600, is_all_day: true };
  }
  const match = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (match) {
    const offsetH = getUtcOffsetHours(tz);
    const ms = new Date(`${match[1]}T${match[2]}:00`).getTime() - offsetH * 3_600_000;
    return { sec: Math.floor(ms / 1000), is_all_day: false };
  }
  return { sec: Math.floor(new Date(s).getTime() / 1000), is_all_day: false };
}

function fmtTimeInfo(t: any, tz: string): string {
  if (!t) return '';
  if (t.date) return t.date;
  if (t.timestamp) {
    return new Date(parseInt(t.timestamp) * 1000)
      .toLocaleString('sv-SE', { timeZone: tz })
      .slice(0, 16);
  }
  return '';
}

function toCalTime(input: string, tz: string) {
  const t = parseTime(input, tz);
  return t.is_all_day ? { date: input.trim().slice(0, 10) } : { timestamp: String(t.sec), timezone: tz };
}

// ---------------------------------------------------------------------------
// Primary calendar ID — cached
// ---------------------------------------------------------------------------

let primaryCalId: string | null = null;

async function getPrimaryCalId(): Promise<string> {
  if (primaryCalId) return primaryCalId;
  const client = getLarkClient();
  const res = await (client.calendar.calendar as any).primary({}, asUser());
  const calId = res.data?.calendars?.[0]?.calendar?.calendar_id;
  if (!calId) throw new Error('Could not retrieve primary calendar ID');
  primaryCalId = calId;
  return primaryCalId!;
}

// ---------------------------------------------------------------------------
// Recurring instance helpers
//
// Lark uses a "lazy materialisation" model for recurring event instances:
//   event_id ending in `_0`            → the recurring template (affects ALL future occurrences)
//   event_id ending in `_<timestamp>`  → a specific occurrence (suffix length > 2)
//
// Before patching/deleting a specific occurrence, it must be materialised:
//   POST attendees to the parent with `instance_start_time_admin=<timestamp>`
//   This creates a distinct event record for that occurrence in Lark's DB.
//   Then RSVP accept so the caller is an attendee (required for mutation permission).
//
// Without materialisation, PATCH/DELETE applies to ALL future occurrences via the template.
// ---------------------------------------------------------------------------

function isRecurringInstance(id: string): boolean {
  const parts = id.split('_');
  return parts.length >= 2 && parts[parts.length - 1].length > 2;
}

function getParentId(id: string): string {
  const parts = id.split('_');
  parts[parts.length - 1] = '0';
  return parts.join('_');
}

function getInstanceTimestamp(id: string): string {
  return id.split('_').pop()!;
}

async function getMyOpenId(): Promise<string> {
  const client = getLarkClient();
  const res = await (client.authen as any).userInfo.get({}, asUser());
  return res.data?.open_id ?? res.data?.user_info?.open_id;
}

async function materializeInstance(calId: string, instanceId: string): Promise<void> {
  const openId = await getMyOpenId();
  if (!openId) throw new Error('Could not resolve caller open_id for recurring instance materialisation');
  const parentId = getParentId(instanceId);
  const timestamp = getInstanceTimestamp(instanceId);
  const client = getLarkClient();
  await (client.calendar.calendarEventAttendee as any).create({
    path: { calendar_id: calId, event_id: parentId },
    params: { user_id_type: 'open_id' },
    data: {
      attendees: [{ type: 'user', is_optional: false, user_id: openId }],
      need_notification: false,
      instance_start_time_admin: timestamp,
    },
  }, asUser());
  await (client.calendar.calendarEvent as any).reply({
    path: { calendar_id: calId, event_id: instanceId },
    data: { rsvp_status: 'accept' },
  }, asUser());
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtLocation(loc?: any): string | undefined {
  if (!loc) return undefined;
  const parts: string[] = [];
  if (loc.name) parts.push(loc.name);
  if (loc.address && loc.address !== loc.name) parts.push(loc.address);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function compactTime(start: string, end: string): string {
  if (start.length === 10) return start;
  const sd = start.slice(0, 10), ed = end.slice(0, 10);
  return sd === ed ? `${sd} ${start.slice(11)}-${end.slice(11)}` : `${start} - ${end}`;
}

function compressId(id: string, firstId: string): string {
  const prefix = firstId.split('_')[0];
  if (prefix.length < 10) return id;
  return id.replace(prefix.slice(3, -3), '......');
}

function groupAndFormat(events: any[]): any[] {
  const tz = TZ();
  const active = events.filter(e => e.status !== 'cancelled');
  const groups = new Map<string, { meta: any; instances: any[] }>();
  for (const e of active) {
    const eid = e.event_id ?? '';
    const key = (e.recurring_event_id as string) ?? (isRecurringInstance(eid) ? getParentId(eid) : eid);
    if (!groups.has(key)) {
      groups.set(key, {
        meta: { summary: e.summary, description: e.description || undefined, location: fmtLocation(e.location), app_link: e.app_link ?? undefined },
        instances: [],
      });
    }
    groups.get(key)!.instances.push({
      event_id: eid,
      start: fmtTimeInfo(e.start_time, tz),
      end: fmtTimeInfo(e.end_time, tz),
    });
  }

  const result: any[] = [];
  for (const { meta, instances } of groups.values()) {
    const base: any = {
      summary: meta.summary,
      ...(meta.location ? { location: meta.location } : {}),
      ...(meta.description ? { description: meta.description } : {}),
    };
    if (instances.length === 1) {
      result.push({ event_id: instances[0].event_id, ...base, time: compactTime(instances[0].start, instances[0].end), ...(meta.app_link ? { app_link: meta.app_link } : {}) });
      continue;
    }
    const firstId = instances[0].event_id;
    const bySlot = new Map<string, Array<{ event_id: string; date: string }>>();
    let multiDay = false;
    for (const inst of instances) {
      const sd = inst.start.slice(0, 10), ed = inst.end.slice(0, 10);
      if (sd !== ed) { multiDay = true; break; }
      const slot = `${inst.start.slice(11)}-${inst.end.slice(11)}`;
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot)!.push({ event_id: compressId(inst.event_id, firstId), date: sd });
    }
    if (!multiDay && bySlot.size === 1) {
      const [[slot, dates]] = bySlot;
      result.push({ ...base, time: slot, dates: dates.map(d => `(${d.event_id}) ${d.date}`).join(', ') });
    } else {
      result.push({ ...base, occurrences: instances.map(inst => ({ event_id: compressId(inst.event_id, firstId), time: compactTime(inst.start, inst.end) })) });
    }
  }
  return result;
}

function defaultListRange(): { startSec: number; endSec: number } {
  const tz = TZ();
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dayMap[dayName] ?? 1;
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mondayMs = now.getTime() - daysToMon * 86400000;
  const sundayMs = mondayMs + 13 * 86400000;
  const monday = new Date(mondayMs).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
  const sunday = new Date(sundayMs).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
  return {
    startSec: parseTime(`${monday} 00:00`, tz).sec,
    endSec:   parseTime(`${sunday} 23:59`, tz).sec,
  };
}

async function queryWithKeyword(calId: string, query: string, startTime?: string, endTime?: string, pageSize = 20): Promise<any[]> {
  const tz = TZ();
  const client = getLarkClient();
  const searchBody: any = { query };
  if (startTime || endTime) {
    searchBody.filter = {};
    if (startTime) searchBody.filter.start_time = { timestamp: String(parseTime(startTime, tz).sec) };
    if (endTime)   searchBody.filter.end_time   = { timestamp: String(parseTime(endTime, tz).sec) };
  }
  const searchRes = await (client.calendar.calendarEvent as any).search(
    { path: { calendar_id: calId }, params: { page_size: pageSize }, data: searchBody }, asUser(),
  );
  const searchItems: any[] = searchRes.data?.items ?? [];
  if (searchItems.length === 0) return [];

  const relevantIds = new Set<string>();
  for (const item of searchItems) {
    if (item.is_exception && item.recurring_event_id) relevantIds.add(item.recurring_event_id);
    else if (item.recurrence) relevantIds.add(item.event_id);
    else relevantIds.add(item.event_id);
  }

  if (!startTime && !endTime) return searchItems;

  const viewRes = await (client.calendar.calendarEvent as any).instanceView({
    path: { calendar_id: calId },
    params: {
      start_time: String(parseTime(startTime!, tz).sec),
      end_time:   String(parseTime(endTime!, tz).sec),
      page_size: pageSize,
    },
  }, asUser());
  const allInstances: any[] = viewRes.data?.items ?? [];

  return allInstances.filter((instance: any) => {
    if (relevantIds.has(instance.event_id)) return true;
    if (instance.recurring_event_id && relevantIds.has(instance.recurring_event_id)) return true;
    if (isRecurringInstance(instance.event_id ?? '') && relevantIds.has(getParentId(instance.event_id))) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCalendarTools(server: McpServer) {
  const tz = () => TZ();

  // ── create ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_calendar_create',
    'Create a calendar event. Supports reminders and RRule recurrence.',
    {
      summary:     z.string().describe('Event title'),
      start_time:  z.string().describe('"YYYY-MM-DD HH:MM" or ISO 8601'),
      end_time:    z.string().describe('"YYYY-MM-DD HH:MM" or ISO 8601'),
      description: z.string().optional(),
      location:    z.string().optional(),
      latitude:    z.number().optional().describe('Location latitude (e.g. 22.590765)'),
      longitude:   z.number().optional().describe('Location longitude (e.g. 113.969668)'),
      reminder:    z.number().int().optional().describe('Minutes before event for reminder (e.g. 15)'),
      recurrence:  z.string().optional().describe('RRule string e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8"'),
    },
    async (p) => withModuleAuth('calendar', async () => {
      const calId = await getPrimaryCalId();
      const eventData: any = {
        summary:    p.summary,
        start_time: toCalTime(p.start_time, tz()),
        end_time:   toCalTime(p.end_time, tz()),
        vchat:      { vc_type: 'no_meeting' },
      };
      if (p.description)      eventData.description = p.description;
      if (p.location) {
        const loc: any = { name: p.location };
        if (p.latitude != null)  loc.latitude  = String(p.latitude);
        if (p.longitude != null) loc.longitude = String(p.longitude);
        eventData.location = loc;
      }
      if (p.reminder != null) eventData.reminders   = [{ minutes: p.reminder }];
      if (p.recurrence)       eventData.recurrence  = p.recurrence;

      const client = getLarkClient();
      const res = await (client.calendar.calendarEvent as any).create(
        { path: { calendar_id: calId }, data: eventData }, asUser(),
      );
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      const created = groupAndFormat([res.data?.event ?? {}]);
      return created[0] ?? {};
    }),
  );

  // ── list ───────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_calendar_list',
    'List calendar events in a time range, optionally filtered by keyword. Default range: this week Mon – next week Sun (~14 days).',
    {
      start_time: z.string().optional().describe('"YYYY-MM-DD HH:MM" or ISO 8601'),
      end_time:   z.string().optional().describe('"YYYY-MM-DD HH:MM" or ISO 8601'),
      query:      z.string().optional().describe('Keyword filter'),
      page_size:  z.number().int().default(20).optional(),
    },
    async (p) => withModuleAuth('calendar', async () => {
      let startTime = p.start_time;
      let endTime   = p.end_time;
      let usedDefault = false;
      if (!startTime && !endTime) {
        const range = defaultListRange();
        startTime   = new Date(range.startSec * 1000).toISOString();
        endTime     = new Date(range.endSec   * 1000).toISOString();
        usedDefault = true;
      }

      const calId = await getPrimaryCalId();
      const pageSize = p.page_size ?? 20;
      let events: any[];

      if (p.query) {
        events = await queryWithKeyword(calId, p.query, startTime, endTime, pageSize);
      } else {
        const client = getLarkClient();
        const startSec = parseTime(startTime!, tz()).sec;
        const endSec   = parseTime(endTime!, tz()).sec;
        const res = await (client.calendar.calendarEvent as any).instanceView({
          path: { calendar_id: calId },
          params: { start_time: String(startSec), end_time: String(endSec), page_size: pageSize },
        }, asUser());
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
        events = res.data?.items ?? [];
      }

      return {
        events: groupAndFormat(events),
        count: events.length,
        ...(usedDefault ? { default_range: 'this week Monday – next week Sunday (~14 days)' } : {}),
      };
    }),
  );

  // ── patch ──────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_calendar_patch',
    'Update a calendar event. Handles recurring instance materialisation automatically.',
    {
      event_id:    z.string().describe('Event ID to update'),
      summary:     z.string().optional(),
      start_time:  z.string().optional(),
      end_time:    z.string().optional(),
      description: z.string().optional(),
      location:    z.string().optional(),
      latitude:    z.number().optional(),
      longitude:   z.number().optional(),
      recurrence:  z.string().optional().describe('Updated RRule recurrence string'),
    },
    async (p) => withModuleAuth('calendar', async () => {
      const calId = await getPrimaryCalId();
      if (isRecurringInstance(p.event_id)) await materializeInstance(calId, p.event_id);

      const data: any = {};
      if (p.summary     != null) data.summary     = p.summary;
      if (p.description != null) data.description = p.description;
      if (p.location != null) {
        const loc: any = { name: p.location };
        if (p.latitude != null)  loc.latitude  = String(p.latitude);
        if (p.longitude != null) loc.longitude = String(p.longitude);
        data.location = loc;
      }
      // Lark silently ignores end_time-only patches on template events (_0).
      // Always send both start_time and end_time together when either is provided.
      if (p.start_time != null || p.end_time != null) {
        const client2 = getLarkClient();
        const cur = await (client2.calendar.calendarEvent as any).get(
          { path: { calendar_id: calId, event_id: p.event_id } }, asUser(),
        );
        const curStart = cur.data?.event?.start_time;
        const curEnd   = cur.data?.event?.end_time;
        data.start_time = p.start_time != null ? toCalTime(p.start_time, tz()) : curStart;
        data.end_time   = p.end_time   != null ? toCalTime(p.end_time,   tz()) : curEnd;
      }
      if (p.recurrence  != null) data.recurrence  = p.recurrence;
      if (Object.keys(data).length === 0) throw new Error('patch requires at least one field to update');

      const client = getLarkClient();
      const res = await (client.calendar.calendarEvent as any).patch(
        { path: { calendar_id: calId, event_id: p.event_id }, data }, asUser(),
      );
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, event_id: p.event_id, updated: Object.keys(data) };
    }),
  );

  // ── delete ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_calendar_delete',
    'Delete a calendar event. Handles recurring instance materialisation automatically.',
    {
      event_id: z.string().describe('Event ID to delete'),
      notify:   z.boolean().default(false).optional().describe('Send cancellation notification to attendees'),
    },
    async (p) => withModuleAuth('calendar', async () => {
      const calId = await getPrimaryCalId();
      if (isRecurringInstance(p.event_id)) await materializeInstance(calId, p.event_id);

      const client = getLarkClient();
      const res = await (client.calendar.calendarEvent as any).delete({
        path: { calendar_id: calId, event_id: p.event_id },
        params: { need_notification: p.notify ? 'true' : 'false' },
      }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, event_id: p.event_id, deleted: true };
    }),
  );
}
