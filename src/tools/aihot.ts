/**
 * aihot MCP tools — query AI news, daily digests, and hot topics from aihot.virxact.com.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import https from 'https';

const BASE = 'aihot.virxact.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function larkGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: BASE, path, method: 'GET', headers: { 'User-Agent': UA } },
      r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function buildDailyCard(data: any): string {
  const dateStr = data.date || 'unknown';
  const sections = data.sections || [];
  const elements: any[] = [];

  for (const sec of sections) {
    const items = sec.items || [];
    if (items.length === 0) continue;

    const lines: string[] = [`**${sec.label}**`];
    for (const item of items) {
      const title = item.title || '';
      const url = item.sourceUrl || '';
      if (url) {
        lines.push(`- [${title}](${url})`);
      } else {
        lines.push(`- ${title}`);
      }
    }

    elements.push({
      tag: 'markdown',
      content: lines.join('\n'),
      text_align: 'left',
    });
  }

  const card: any = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `AI HOT · ${dateStr}` },
      template: 'blue',
    },
    elements,
  };

  return JSON.stringify(card);
}

export function registerAihotTools(server: McpServer) {
  // ── AI daily digest ──────────────────────────────────────────────
  server.tool(
    'aihot_daily',
    'Get the latest (or a specific date\'s) AI daily digest from AI HOT. Omit date for latest. Pass format="card" to get a Feishu interactive card JSON (for feishu_im_send).',
    {
      date: z.string().optional().describe('YYYY-MM-DD date for a specific daily digest'),
      format: z.enum(['text', 'card']).optional().default('text').describe('Output format: "text" for plain JSON, "card" for Feishu interactive card JSON'),
    },
    async ({ date, format }) => {
      try {
        const path = date ? `/api/public/daily/${date}` : '/api/public/daily';
        const data = await larkGet(path);
        if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };
        if (format === 'card') {
          return { content: [{ type: 'text', text: buildDailyCard(data) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed: ${err?.message ?? err}` }] };
      }
    },
  );

  // ── AI news items ────────────────────────────────────────────────
  server.tool(
    'aihot_items',
    'Query AI news items from AI HOT. Supports mode (selected/all), category filter, keyword search, time window.',
    {
      mode: z.enum(['selected', 'all']).optional().default('selected').describe('"selected" for curated picks, "all" for everything'),
      category: z.string().optional().describe('Category filter: model, product, funding, industry, paper, tutorial, opinion'),
      since: z.string().optional().describe('ISO 8601 time window start (e.g. 2026-05-07T00:00:00Z)'),
      take: z.number().int().min(1).max(100).optional().default(50).describe('Number of items (max 100)'),
      q: z.string().optional().describe('Keyword search in title/summary'),
    },
    async ({ mode, category, since, take, q }) => {
      try {
        const params = new URLSearchParams();
        params.set('mode', mode ?? 'selected');
        if (category) params.set('category', category);
        if (since) params.set('since', since);
        if (take) params.set('take', String(take));
        if (q) params.set('q', q);
        const data = await larkGet(`/api/public/items?${params.toString()}`);
        if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed: ${err?.message ?? err}` }] };
      }
    },
  );

  // ── Daily archive list ───────────────────────────────────────────
  server.tool(
    'aihot_dailies',
    'List available daily digest dates from AI HOT.',
    { take: z.number().int().min(1).max(180).optional().default(30).describe('Number of archive entries') },
    async ({ take }) => {
      try {
        const data = await larkGet(`/api/public/dailies?take=${take ?? 30}`);
        if (data.error) return { content: [{ type: 'text', text: `Error: ${data.error}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed: ${err?.message ?? err}` }] };
      }
    },
  );
}
