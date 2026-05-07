/**
 * feishu_doc_* MCP tools — create, fetch, update documents, search docs/wiki.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import https from 'https';
import { createReadStream, statSync } from 'fs';
import { getLarkClient, asUser, withAuth } from '../client.js';
import { getUserToken, getTenantAccessToken } from '../auth.js';
import { withModuleAuth } from '../auth-guard.js';

// Default wiki space (set via LARK_WIKI_SPACE env var)
const DEFAULT_WIKI_SPACE_ID = process.env.LARK_WIKI_SPACE || '';

function larkPost(path: string, body: any, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function larkGet(path: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
    );
    req.on('error', reject);
    req.end();
  });
}

function larkPut(path: string, body: any, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function larkDelete(path: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
    );
    req.on('error', reject);
    req.end();
  });
}

function larkPatch(path: string, body: any, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Extract order number from block content (ORDER:xxx format)
function extractOrderFromBlock(block: any): number | null {
  const blockTypes = ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'quote', 'code'];
  for (const type of blockTypes) {
    if (block[type]?.elements) {
      for (const elem of block[type].elements) {
        if (elem.text_run?.content) {
          const match = elem.text_run.content.match(/ORDER:(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
      }
    }
  }
  return null;
}

// Remove ORDER:xxx prefix from block content
function removeOrderPrefixFromBlock(block: any): void {
  const blockTypes = ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'quote', 'code'];
  for (const type of blockTypes) {
    if (block[type]?.elements) {
      for (const elem of block[type].elements) {
        if (elem.text_run?.content) {
          elem.text_run.content = elem.text_run.content.replace(/ORDER:\d+\s*/, '');
        }
      }
    }
  }
}

// Reorder blocks: first try ORDER:xxx markers, fallback to first_level_block_ids order
function reorderBlocksByOrderMarkers(firstLevelIds: string[], blocks: any[]): { first_level_block_ids: string[], blocks: any[] } {
  // Check for ORDER:xxx markers
  const orderMap = new Map<string, number>();
  for (const block of blocks) {
    const order = extractOrderFromBlock(block);
    if (order !== null) {
      orderMap.set(block.block_id, order);
    }
  }

  let sortedBlocks: any[];

  if (orderMap.size > 0) {
    // Mode 1: Explicit ORDER:xxx markers found - use them for sorting
    sortedBlocks = [...blocks].sort((a, b) => {
      const orderA = orderMap.get(a.block_id) ?? Infinity;
      const orderB = orderMap.get(b.block_id) ?? Infinity;
      return orderA - orderB;
    });
    // Remove ORDER prefixes
    for (const block of sortedBlocks) {
      removeOrderPrefixFromBlock(block);
    }
  } else {
    // Mode 2: Auto mode - reorder using firstLevelIds order (usually correct)
    // First level blocks in firstLevelIds order, then nested blocks (order preserved)
    const firstLevelBlocks: any[] = [];
    const nestedBlocks: any[] = [];

    // Collect all child block IDs
    const allChildIds = new Set<string>();
    for (const b of blocks) {
      if (b.children && Array.isArray(b.children)) {
        for (const childId of b.children) {
          allChildIds.add(childId);
        }
      }
    }

    // Separate first level and nested blocks
    for (const block of blocks) {
      if (allChildIds.has(block.block_id)) {
        nestedBlocks.push(block);
      } else {
        firstLevelBlocks.push(block);
      }
    }

    // Sort first level blocks by their position in firstLevelIds
    const sortedFirstLevel = firstLevelBlocks.sort((a, b) => {
      const idxA = firstLevelIds.indexOf(a.block_id);
      const idxB = firstLevelIds.indexOf(b.block_id);
      return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
    });

    // Combine: sorted first level blocks + nested blocks (original order preserved)
    sortedBlocks = [...sortedFirstLevel, ...nestedBlocks];
  }

  // Recalculate first level block IDs
  const allChildIdsFinal = new Set<string>();
  for (const b of sortedBlocks) {
    if (b.children && Array.isArray(b.children)) {
      for (const childId of b.children) {
        allChildIdsFinal.add(childId);
      }
    }
  }
  const sortedFirstLevelIds = sortedBlocks
    .filter((b: any) => !allChildIdsFinal.has(b.block_id))
    .map((b: any) => b.block_id);

  return { first_level_block_ids: sortedFirstLevelIds, blocks: sortedBlocks };
}

// ── Internal helper functions (not exposed as MCP tools) ──────────────────

/**
 * Convert Markdown or HTML content to Lark document blocks (internal use only)
 */
async function convertMarkdownToBlocks(
  content_type: 'markdown' | 'html',
  content: string,
  auto_reorder: boolean = true
): Promise<{ first_level_block_ids: string[], blocks: any[] }> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
  const token = await getTenantAccessToken(appId, appSecret);
  const res = await larkPost('/open-apis/docx/v1/documents/blocks/convert', { content_type, content }, token);
  if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);

  let firstLevelIds = res.data?.first_level_block_ids ?? [];
  let blocks = res.data?.blocks ?? [];

  if (auto_reorder) {
    const reordered = reorderBlocksByOrderMarkers(firstLevelIds, blocks);
    firstLevelIds = reordered.first_level_block_ids;
    blocks = reordered.blocks;
  }

  return { first_level_block_ids: firstLevelIds, blocks };
}

/**
 * Batch create nested blocks in a document (internal use only)
 * Automatically removes merge_info from table blocks
 */
async function createNestedBlocks(
  document_id: string,
  parent_block_id: string,
  blocks: any[]
): Promise<{ created_blocks: any[], total_created: number }> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
  const tenantToken = await getTenantAccessToken(appId, appSecret);

  // Extract first level block ids (blocks that are not referenced as children by any other block)
  const allChildIds = new Set<string>();
  for (const b of blocks) {
    if (b.children && Array.isArray(b.children)) {
      for (const childId of b.children) {
        allChildIds.add(childId);
      }
    }
  }
  const children_id = blocks
    .filter((b: any) => !allChildIds.has(b.block_id))
    .map((b: any) => b.block_id);

  // Clean blocks: remove read-only fields but keep block_id and children array
  const descendants = blocks.map((b: any) => {
    // Keep block_id (temp_id) and children array - API uses children to build the tree
    const { ...rest } = b;

    // Remove read-only fields from table blocks
    if (rest.table) {
      const { cells, property, ...tableRest } = rest.table;
      const { merge_info, ...propertyRest } = property || {};
      rest.table = { ...tableRest, property: propertyRest };
    }

    return rest;
  });

  // For nested blocks, use the /descendant endpoint with children_id + descendants
  const requestBody = {
    children_id: children_id.length > 0 ? children_id : descendants.map((_: any, i: number) => `temp_${i}`),
    descendants,
    index: -1,
  };

  const res = await larkPost(
    `/open-apis/docx/v1/documents/${document_id}/blocks/${parent_block_id}/descendant`,
    requestBody,
    tenantToken
  );

  if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
  const createdBlocks = res.data?.children ?? [];

  return { created_blocks: createdBlocks, total_created: createdBlocks.length };
}

export function registerDocTools(server: McpServer) {
  // ── search ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_doc_search',
    'Search documents and wiki pages by keyword.',
    {
      query:     z.string().describe('Search keyword'),
      page_size: z.number().int().default(20).optional().describe('Number of results to return. Default 20. Can be larger — the tool auto-paginates API calls to collect the requested count.'),
    },
    async ({ query, page_size }) => withModuleAuth('docs', async () => {
      const token = getUserToken();
      const wanted = page_size ?? 20;
      const API_MAX = 20;

      const allUnits: any[] = [];
      let pageToken: string | undefined;
      let total: number | undefined;

      while (allUnits.length < wanted) {
        const body: any = {
          query,
          page_size: Math.min(API_MAX, wanted - allUnits.length),
          doc_filter:  {},
          wiki_filter: {},
        };
        if (pageToken) body.page_token = pageToken;

        const res = await larkPost('/open-apis/search/v2/doc_wiki/search', body, token);
        if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);

        const units: any[] = res.data?.res_units ?? [];
        allUnits.push(...units);
        total = res.data?.total;

        if (!res.data?.has_more || units.length === 0) break;
        pageToken = res.data?.page_token;
      }

      const items = allUnits.slice(0, wanted).map((u: any) => ({
        token:    u.result_meta?.token,
        type:     u.result_meta?.doc_types ?? u.entity_type,
        title:    (u.title_highlighted ?? '').replace(/<\/?h>/g, ''),
        url:      u.result_meta?.url,
        owner_id: u.result_meta?.owner_id,
        summary:  (u.summary_highlighted ?? '').replace(/<\/?h>/g, ''),
      }));
      return { docs: items, count: items.length, total };
    }),
  );

  // ── fetch ──────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_doc_fetch',
    [
      'Fetch the content of a Lark document.',
      'Returns plain text content plus a structured block list with block_id, type, and text for each block.',
      'Use the block_id values with feishu_doc_patch / feishu_doc_delete.',
    ].join('\n'),
    {
      document_id: z.string().describe('Document token/ID (from URL or search results)'),
    },
    async ({ document_id }) => withModuleAuth('docs', async () => {
      const client = getLarkClient();
      const [rawRes, blocksRes] = await Promise.all([
        (client as any).docx.v1.document.rawContent({ path: { document_id }, params: { lang: 0 } }, asUser()),
        (client as any).docx.v1.documentBlock.list({ path: { document_id }, params: { page_size: 200, document_revision_id: -1 } }, asUser()),
      ]);
      if (rawRes.code !== 0) throw new Error(`Lark API ${rawRes.code}: ${rawRes.msg}`);

      // Map blocks to a compact summary: id, type name, and first 80 chars of text
      const TYPE_NAME: Record<number, string> = {
        1:'page', 2:'paragraph', 3:'heading1', 4:'heading2', 5:'heading3',
        6:'heading4', 7:'heading5', 8:'heading6', 12:'bullet', 13:'ordered',
        14:'code', 15:'quote', 17:'todo', 19:'callout', 27:'image',
      };
      const blocks = (blocksRes?.data?.items ?? []).map((b: any) => {
        const typeName = TYPE_NAME[b.block_type] ?? `type${b.block_type}`;
        // Extract text from whichever key holds elements
        const keys = ['text','heading1','heading2','heading3','heading4','heading5','heading6',
                      'bullet','ordered','code','quote','todo','callout'];
        let text = '';
        for (const k of keys) {
          const elems = b[k]?.elements;
          if (elems) { text = elems.map((e: any) => e.text_run?.content ?? e.equation?.content ?? '').join(''); break; }
        }
        return { block_id: b.block_id, type: typeName, text: text.slice(0, 80) };
      });

      return { document_id, content: rawRes.data?.content, blocks };
    }),
  );

  // ── patch block ────────────────────────────────────────────────────────────
  server.tool(
    'feishu_doc_patch',
    [
      'Update the text content of an existing block in a Lark document.',
      'Use feishu_doc_fetch to get block_ids first.',
      'Supports the same text formatting options as feishu_doc_append (bold, italic, inline_code, done).',
    ].join('\n'),
    {
      document_id: z.string().describe('Document token/ID'),
      block_id:    z.string().describe('Block ID to update (from feishu_doc_fetch blocks list)'),
      text:        z.string().describe('New text content'),
      bold:        z.boolean().optional(),
      italic:      z.boolean().optional(),
      inline_code: z.boolean().optional(),
      done:        z.boolean().optional().describe('For todo blocks — mark checkbox as checked/unchecked'),
    },
    async ({ document_id, block_id, text, bold, italic, inline_code, done }) => withModuleAuth('docs', async () => {
      const client = getLarkClient();
      const style: any = {};
      if (bold)        style.bold        = true;
      if (italic)      style.italic      = true;
      if (inline_code) style.inline_code = true;

      // patch uses update_text_elements (replaces all inline elements of the block)
      const updateData: any = {
        update_text_elements: {
          elements: [{ text_run: { content: text, text_element_style: style } }],
        },
      };
      // For todo: also update the done state via update_text_style
      if (done !== undefined) {
        updateData.update_text_style = { done };
      }

      const res = await (client as any).docx.v1.documentBlock.patch({
        path: { document_id, block_id },
        params: { document_revision_id: -1 },
        data: updateData,
      }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, document_id, block_id, updated: true };
    }),
  );

  // ── delete block ───────────────────────────────────────────────────────────
  server.tool(
    'feishu_doc_delete',
    [
      'Delete a block from a Lark document by its block_id.',
      'Use feishu_doc_fetch to get block_ids first.',
    ].join('\n'),
    {
      document_id: z.string().describe('Document token/ID'),
      block_id:    z.string().describe('Block ID to delete (from feishu_doc_fetch blocks list)'),
    },
    async ({ document_id, block_id }) => withModuleAuth('docs', async () => {
      const client = getLarkClient();
      // Find the block's parent and its index among siblings
      const listRes = await (client as any).docx.v1.documentBlock.list({
        path: { document_id },
        params: { page_size: 500, document_revision_id: -1 },
      }, asUser());
      if (listRes.code !== 0) throw new Error(`List blocks error ${listRes.code}: ${listRes.msg}`);

      const allBlocks: any[] = listRes.data?.items ?? [];
      const target = allBlocks.find((b: any) => b.block_id === block_id);
      if (!target) throw new Error(`Block ${block_id} not found in document`);
      const parentId: string = target.parent_id;
      const parent = allBlocks.find((b: any) => b.block_id === parentId);
      if (!parent) throw new Error(`Parent block ${parentId} not found`);
      const idx: number = (parent.children ?? []).indexOf(block_id);
      if (idx === -1) throw new Error(`Block ${block_id} not found in parent's children list`);

      const res = await (client as any).docx.v1.documentBlockChildren.batchDelete({
        path: { document_id, block_id: parentId },
        params: { document_revision_id: -1 },
        data: { start_index: idx, end_index: idx + 1 },
      }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { ok: true, document_id, block_id, deleted: true };
    }),
  );

  // ── create ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_doc_create',
    'Create a new Lark document with optional title and initial content.',
    {
      title:       z.string().default('Untitled').optional(),
      folder_token: z.string().optional().describe('Parent folder token. Omit for root My Drive.'),
    },
    async ({ title, folder_token }) => withModuleAuth('docs', async () => {
      const client = getLarkClient();
      const data: any = { title };
      if (folder_token) data.folder_token = folder_token;
      const res = await (client as any).docx.v1.document.create({ data }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      const doc = res.data?.document;
      return { document_id: doc?.document_id, title: doc?.title, url: doc?.url };
    }),
  );

  // ── delete file (Drive API) ────────────────────────────────────────────────
  server.tool(
    'feishu_doc_delete_file',
    [
      'Permanently delete a document or file from Drive (requires space:document:delete scope).',
      'Use the document_id / file token from feishu_doc_create or feishu_doc_search.',
      'type: "docx" for Lark documents (default), "file" for uploaded files, "sheet" for spreadsheets, "bitable" for Bitable apps.',
      'WARNING: This is irreversible. Always confirm with the user before calling.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token / file token to delete'),
      type:       z.enum(['docx', 'file', 'sheet', 'bitable']).default('docx').optional(),
    },
    async ({ file_token, type = 'docx' }) => withModuleAuth('docs', async () => {
      const token = getUserToken();
      const res = await new Promise<any>((resolve, reject) => {
        const reqPath = `/open-apis/drive/v1/files/${encodeURIComponent(file_token)}?type=${type}`;
        const req = https.request(
          { hostname: 'open.feishu.cn', path: reqPath, method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { deleted: true, file_token, type };
    }),
  );

  // ── update (append block) ─────────────────────────────────────────────────
  const BLOCK_TYPES: Record<string, number> = {
    paragraph: 2,
    heading1: 3, heading2: 4, heading3: 5, heading4: 6, heading5: 7, heading6: 8,
    bullet: 12, ordered: 13, code: 14, quote: 15, todo: 17,
  };

  server.tool(
    'feishu_doc_append',
    [
      'Append a block to an existing Lark document.',
      '',
      'type options: paragraph (default), heading1–heading6, bullet, ordered, code, quote, todo, callout, equation, image',
      'For bullet/ordered/todo lists, call once per item.',
      'bold/italic/inline_code apply inline style to the entire text.',
      'done: only for todo — marks checkbox as checked (default false).',
      'image_path: only for image — local file path to upload (png/jpg/gif/webp).',
      'callout_emoji: only for callout — Unicode hex codepoint e.g. "1f4a1"=💡 "26a0"=⚠️ "2705"=✅.',
      'callout_bg: only for callout — background color 1–7 (LightRed/Orange/Yellow/Green/Blue/Purple/Gray).',
    ].join('\n'),
    {
      document_id: z.string().describe('Document token/ID'),
      text:        z.string().optional().describe('Text content (not used for image type)'),
      type:        z.enum(['paragraph','heading1','heading2','heading3','heading4','heading5','heading6','bullet','ordered','code','quote','todo','callout','equation','image'])
                     .default('paragraph').optional(),
      bold:        z.boolean().optional(),
      italic:      z.boolean().optional(),
      inline_code: z.boolean().optional(),
      done:        z.boolean().optional().describe('For todo blocks only — mark checkbox as checked'),
      image_path:  z.string().optional().describe('For image blocks — absolute local file path to upload'),
      callout_emoji: z.string().optional().describe('For callout blocks — Unicode hex codepoint e.g. "1f4a1"=💡 "26a0"=⚠️ "2705"=✅ "1f525"=🔥 "1f4cc"=📌'),
      callout_bg:    z.number().int().min(1).max(7).optional().describe('For callout blocks — background color: 1=LightRed 2=LightOrange 3=LightYellow 4=LightGreen 5=LightBlue 6=LightPurple 7=LightGray'),
      markdown:    z.string().optional().describe('Markdown content to append as multiple blocks. If provided, all other content params (text, type, etc.) are ignored.'),
    },
    async ({ document_id, text = '', type = 'paragraph', bold, italic, inline_code, done, image_path, callout_emoji, callout_bg, markdown }) => withModuleAuth('docs', async () => {
      const client = getLarkClient();
      const docRes = await (client as any).docx.v1.document.get(
        { path: { document_id } }, asUser(),
      );
      if (docRes.code !== 0) throw new Error(`Get doc error ${docRes.code}: ${docRes.msg}`);
      const blockId = docRes.data?.document?.body?.block_id ?? document_id;

      // ── Markdown batch mode: convert and bulk insert ──────────────────────
      if (markdown !== undefined) {
        // Step 1: Convert markdown to blocks with auto reorder
        const { blocks: rawBlocks } = await convertMarkdownToBlocks('markdown', markdown, true);

        // Step 2: Prepare blocks for insertion (clean read-only fields)
        // Extract first level block ids
        const allChildIds = new Set<string>();
        for (const b of rawBlocks) {
          if (b.children && Array.isArray(b.children)) {
            for (const childId of b.children) {
              allChildIds.add(childId);
            }
          }
        }
        const children_id = rawBlocks
          .filter((b: any) => !allChildIds.has(b.block_id))
          .map((b: any) => b.block_id);

        // Clean blocks
        const descendants = rawBlocks.map((b: any) => {
          const { ...rest } = b;
          if (rest.table) {
            const { cells, property, ...tableRest } = rest.table;
            const { merge_info, ...propertyRest } = property || {};
            rest.table = { ...tableRest, property: propertyRest };
          }
          return rest;
        });

        const requestBody = {
          children_id: children_id.length > 0 ? children_id : descendants.map((_: any, i: number) => `temp_${i}`),
          descendants,
          index: -1,
        };

        // Step 3: Try tenant token first, fallback to user token
        const appId = process.env.LARK_APP_ID;
        const appSecret = process.env.LARK_APP_SECRET;
        if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
        const tenantToken = await getTenantAccessToken(appId, appSecret);

        let useTenantToken = true;
        let createdBlocks: any[] = [];

        try {
          const testRes = await larkPost(
            `/open-apis/docx/v1/documents/${document_id}/blocks/${blockId}/descendant`,
            requestBody,
            tenantToken
          );
          if (testRes.code === 0) {
            createdBlocks = testRes.data?.children ?? [];
          } else {
            useTenantToken = false;
          }
        } catch {
          useTenantToken = false;
        }

        // Fallback to user token if tenant failed
        if (!useTenantToken) {
          const createRes = await (client as any).docx.v1.documentBlockDescendant.create({
            path: { document_id, block_id: blockId },
            params: { document_revision_id: -1 },
            data: requestBody,
          }, asUser());

          if (createRes.code !== 0) throw new Error(`Create blocks error ${createRes.code}: ${createRes.msg}`);
          createdBlocks = createRes.data?.children ?? [];
        }

        return { appended: true, blocks_created: createdBlocks.length, block_ids: createdBlocks.map((b: any) => b.block_id), used_tenant_token: useTenantToken };
      }

      // ── image block (3-step) ─────────────────────────────────────────────────
      if (type === 'image') {
        if (!image_path) throw new Error('image_path is required for image blocks');

        const createBody = { children: [{ block_type: 27, image: {} }], index: -1 };
        let useTenantToken = false;
        let createRes: any = null;
        const appId = process.env.LARK_APP_ID;
        const appSecret = process.env.LARK_APP_SECRET;

        // Step 1: create empty image block → try tenant token first, fallback to user token
        if (appId && appSecret) {
          try {
            const tenantToken = await getTenantAccessToken(appId, appSecret);
            const testRes = await larkPost(
              `/open-apis/docx/v1/documents/${document_id}/blocks/${blockId}/children`,
              createBody,
              tenantToken
            );
            if (testRes.code === 0) {
              createRes = testRes;
              useTenantToken = true;
            }
          } catch {
            // tenant failed, will try user token next
          }
        }

        if (!createRes) {
          createRes = await (client as any).docx.v1.documentBlockChildren.create({
            path: { document_id, block_id: blockId },
            params: { document_revision_id: -1 },
            data: createBody,
          }, asUser());
        }

        const createCode = createRes?.code ?? createRes?.data?.code;
        if (createCode !== 0 && createCode !== undefined) throw new Error(`Create image block error ${createCode}: ${createRes?.msg ?? createRes?.data?.msg}`);
        const imageBlockId = createRes?.data?.children?.[0]?.block_id;
        if (!imageBlockId) throw new Error('Create image block returned no block_id');

        // Step 2: upload image using Image BlockID as parent_node
        const fileSize = statSync(image_path).size;
        const uploadRes = await (client as any).drive.v1.media.uploadAll({
          data: {
            file_name: image_path.split('/').pop() ?? 'image.png',
            parent_type: 'docx_image',
            parent_node: imageBlockId,
            size: fileSize,
            file: createReadStream(image_path),
          },
        }, asUser());
        const fileToken = uploadRes?.data?.file_token ?? uploadRes?.file_token;
        if (!fileToken) throw new Error(`Image upload failed: ${JSON.stringify(uploadRes)}`);

        // Step 3: PATCH image block with replace_image to set the token
        const patchRes = await (client as any).docx.v1.documentBlock.patch({
          path: { document_id, block_id: imageBlockId },
          params: { document_revision_id: -1 },
          data: { replace_image: { token: fileToken } },
        }, asUser());
        const patchCode = patchRes?.code ?? patchRes?.data?.code;
        if (patchCode !== 0 && patchCode !== undefined) throw new Error(`Set image token error ${patchCode}: ${patchRes?.msg ?? patchRes?.data?.msg}`);
        return { ok: true, document_id, appended: true, type: 'image', used_tenant_token: useTenantToken };
      }

      // ── equation block (paragraph with inline equation element) ─────────────
      if (type === 'equation') {
        const latex = text.endsWith('\n') ? text : text + '\n';
        const requestBody = {
          children: [{ block_type: 2, text: {
            elements: [{ equation: { content: latex, text_element_style: {} } }],
            style: { align: 1, folded: false },
          }}],
          index: -1,
        };

        // Try tenant token first, fallback to user token
        const appId = process.env.LARK_APP_ID;
        const appSecret = process.env.LARK_APP_SECRET;
        let useTenantToken = true;
        let result: any = null;

        if (appId && appSecret) {
          try {
            const tenantToken = await getTenantAccessToken(appId, appSecret);
            const testRes = await larkPost(
              `/open-apis/docx/v1/documents/${document_id}/blocks/${blockId}/children`,
              requestBody,
              tenantToken
            );
            if (testRes.code === 0) {
              result = testRes;
            } else {
              useTenantToken = false;
            }
          } catch {
            useTenantToken = false;
          }
        } else {
          useTenantToken = false;
        }

        if (!useTenantToken) {
          result = await (client as any).docx.v1.documentBlockChildren.create({
            path: { document_id, block_id: blockId },
            params: { document_revision_id: -1 },
            data: requestBody,
          }, asUser());
        }

        const resCode = result?.code ?? result?.data?.code;
        if (resCode !== 0 && resCode !== undefined) throw new Error(`Lark API ${resCode}: ${result?.msg ?? result?.data?.msg}`);
        return { ok: true, document_id, appended: true, type: 'equation', used_tenant_token: useTenantToken };
      }

      // ── callout block (2-step container) ────────────────────────────────────
      if (type === 'callout') {
        // Step 1: create the callout container block
        // style fields go directly on callout object (no 'style' wrapper)
        const calloutData: any = {};
        if (callout_emoji) calloutData.emoji_id = callout_emoji;
        if (callout_bg)    calloutData.background_color = callout_bg;
        const createBody = { children: [{ block_type: 19, callout: calloutData }], index: -1 };

        // Try tenant token first, fallback to user token
        const appId = process.env.LARK_APP_ID;
        const appSecret = process.env.LARK_APP_SECRET;
        let useTenantToken = false;
        let createRes: any = null;

        if (appId && appSecret) {
          try {
            const tenantToken = await getTenantAccessToken(appId, appSecret);
            const testRes = await larkPost(
              `/open-apis/docx/v1/documents/${document_id}/blocks/${blockId}/children`,
              createBody,
              tenantToken
            );
            if (testRes.code === 0) {
              createRes = testRes;
              useTenantToken = true;
            }
          } catch {
            // tenant failed, will try user token next
          }
        }

        if (!createRes) {
          createRes = await (client as any).docx.v1.documentBlockChildren.create({
            path: { document_id, block_id: blockId },
            params: { document_revision_id: -1 },
            data: createBody,
          }, asUser());
        }

        const createCode = createRes?.code ?? createRes?.data?.code;
        if (createCode !== 0 && createCode !== undefined) throw new Error(`Create callout error ${createCode}: ${createRes?.msg ?? createRes?.data?.msg}`);
        const calloutBlockId = createRes?.data?.children?.[0]?.block_id;
        if (!calloutBlockId) throw new Error('Create callout returned no block_id');

        // Step 2: insert text paragraph inside the callout
        const inlineStyle: any = {};
        if (bold)        inlineStyle.bold        = true;
        if (italic)      inlineStyle.italic      = true;
        if (inline_code) inlineStyle.inline_code = true;

        const innerBody = { children: [{ block_type: 2, text: { elements: [{ text_run: { content: text, text_element_style: inlineStyle } }], style: {} } }], index: 0 };

        // Try tenant token first for inner block too
        let innerRes: any = null;
        let innerUseTenant = false;

        if (appId && appSecret) {
          try {
            const tenantToken = await getTenantAccessToken(appId, appSecret);
            const testRes = await larkPost(
              `/open-apis/docx/v1/documents/${document_id}/blocks/${calloutBlockId}/children`,
              innerBody,
              tenantToken
            );
            if (testRes.code === 0) {
              innerRes = testRes;
              innerUseTenant = true;
            }
          } catch {
            // tenant failed, will try user token next
          }
        }

        if (!innerRes) {
          innerRes = await (client as any).docx.v1.documentBlockChildren.create({
            path: { document_id, block_id: calloutBlockId },
            params: { document_revision_id: -1 },
            data: innerBody,
          }, asUser());
        }

        const innerCode = innerRes?.code ?? innerRes?.data?.code;
        if (innerCode !== 0 && innerCode !== undefined) throw new Error(`Insert callout text error ${innerCode}: ${innerRes?.msg ?? innerRes?.data?.msg}`);
        return { ok: true, document_id, appended: true, type: 'callout', used_tenant_token: useTenantToken };
      }

      // ── text-based blocks ────────────────────────────────────────────────────
      const block_type = BLOCK_TYPES[type] ?? 2;
      const style: any = {};
      if (bold)        style.bold        = true;
      if (italic)      style.italic      = true;
      if (inline_code) style.inline_code = true;

      const BLOCK_KEY: Record<string, string> = {
        paragraph: 'text',
        heading1: 'heading1', heading2: 'heading2', heading3: 'heading3',
        heading4: 'heading4', heading5: 'heading5', heading6: 'heading6',
        bullet: 'bullet', ordered: 'ordered', code: 'code', quote: 'quote',
        todo: 'todo',
      };
      const blockKey = BLOCK_KEY[type] ?? 'text';

      // Parse $...$ as inline equations for paragraph/heading types.
      // Splits text on $...$ tokens and builds a mixed elements array.
      function buildElements(raw: string, textStyle: any): any[] {
        const parts = raw.split(/(\$[^$]+\$)/g);
        return parts
          .filter(p => p.length > 0)
          .map(p => {
            if (p.startsWith('$') && p.endsWith('$') && p.length > 2) {
              const latex = p.slice(1, -1);
              return { equation: { content: latex + '\n', text_element_style: {} } };
            }
            return { text_run: { content: p, text_element_style: textStyle } };
          });
      }

      const supportsInlineEq = type === 'paragraph' || type.startsWith('heading');
      const elements = supportsInlineEq
        ? buildElements(text, style)
        : [{ text_run: { content: text, text_element_style: style } }];

      const blockContent: any = { elements };
      if (type === 'paragraph' || type.startsWith('heading')) {
        blockContent.style = {};
      }
      if (type === 'todo') {
        blockContent.style = { done: done ?? false };
      }

      const requestBody = {
        children: [{ block_type, [blockKey]: blockContent }],
        index: -1,
      };

      // Try tenant token first, fallback to user token
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      let useTenantToken = true;
      let result: any = null;

      if (appId && appSecret) {
        try {
          const tenantToken = await getTenantAccessToken(appId, appSecret);
          const testRes = await larkPost(
            `/open-apis/docx/v1/documents/${document_id}/blocks/${blockId}/children`,
            requestBody,
            tenantToken
          );
          if (testRes.code === 0) {
            result = testRes;
          } else {
            useTenantToken = false;
          }
        } catch {
          useTenantToken = false;
        }
      } else {
        useTenantToken = false;
      }

      // Fallback to user token if tenant failed
      if (!useTenantToken) {
        const createRes = await (client as any).docx.v1.documentBlockChildren.create({
          path: { document_id, block_id: blockId },
          params: { document_revision_id: -1 },
          data: requestBody,
        }, asUser());
        result = createRes;
      }

      const resCode = result?.code ?? result?.data?.code;
      if (resCode !== 0 && resCode !== undefined) throw new Error(`Lark API ${resCode}: ${result?.msg ?? result?.data?.msg} | block_type=${block_type} key=${blockKey}`);
      return { ok: true, document_id, appended: true, type, used_tenant_token: useTenantToken };
    }),
  );

  // ── wiki add member ────────────────────────────────────────────────────────
  server.tool(
    'feishu_wiki_add_member',
    [
      'Add a member or admin to a Wiki knowledge space.',
      'Requires user OAuth with wiki:member:create or wiki:wiki scope.',
      'IMPORTANT: The authorized user (the one who completed OAuth) MUST be an ADMIN of the target wiki space.',
      'Only space admins can add or remove members.',
      'Set via LARK_WIKI_SPACE environment variable for default space.',
    ].join('\n'),
    {
      space_id:   z.string().describe('Knowledge space ID'),
      member_type: z.enum(['openid', 'userid', 'email', 'openchat', 'opendepartmentid', 'unionid'])
                      .default('openid').describe('Member ID type'),
      member_id:   z.string().describe('Member ID (e.g. open_id: ou_xxx)'),
      member_role: z.enum(['member', 'admin']).default('member').describe('Role: member or admin'),
      need_notification: z.boolean().default(true).optional().describe('Whether to send notification'),
    },
    async ({ space_id, member_type, member_id, member_role, need_notification = true }) => withModuleAuth('docs', async () => {
      const token = getUserToken();
      const body = { member_type, member_id, member_role };

      const res = await new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const path = `/open-apis/wiki/v2/spaces/${space_id}/members?need_notification=${need_notification ? 'true' : 'false'}`;
        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        member_type: res.data?.member?.member_type,
        member_id: res.data?.member?.member_id,
        member_role: res.data?.member?.member_role,
        type: res.data?.member?.type,
      };
    }),
  );

  // ── wiki list spaces ───────────────────────────────────────────────────────
  server.tool(
    'feishu_wiki_list_spaces',
    [
      'Get list of wiki spaces that the authorized user has access to.',
      'Requires user OAuth with wiki:space:retrieve or wiki:wiki scope.',
      'Uses user_access_token - only returns spaces that the authorized user can access.',
      'This is a paginated API - use page_token from the previous response to fetch more results.',
    ].join('\n'),
    {
      page_size: z.number().int().min(1).max(50).default(20).optional().describe('Page size, max 50'),
      page_token: z.string().optional().describe('Page token from previous response for pagination'),
    },
    async ({ page_size = 20, page_token }) => withModuleAuth('docs', async () => {
      const token = getUserToken();

      const res = await new Promise<any>((resolve, reject) => {
        let path = `/open-apis/wiki/v2/spaces?page_size=${page_size}`;
        if (page_token) path += `&page_token=${encodeURIComponent(page_token)}`;

        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        items: (res.data?.items ?? []).map((s: any) => ({
          name: s.name,
          description: s.description,
          space_id: s.space_id,
          space_type: s.space_type,
          visibility: s.visibility,
          open_sharing: s.open_sharing,
        })),
        page_token: res.data?.page_token,
        has_more: res.data?.has_more,
      };
    }),
  );

  // ── wiki get space info ───────────────────────────────────────────────────
  server.tool(
    'feishu_wiki_get_space_user',
    [
      'Get detailed information about a specific wiki space by space_id.',
      'Requires user OAuth with wiki:space:read or wiki:wiki scope.',
      'Uses user_access_token - the authorized user must be a member or admin of the space.',
      'Set via LARK_WIKI_SPACE environment variable for default space.',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      lang: z.enum(['zh', 'id', 'de', 'en', 'es', 'fr', 'it', 'pt', 'vi', 'ru', 'hi', 'th', 'ko', 'ja', 'zh-HK', 'zh-TW'])
                .default('zh').optional().describe('Language for my_library space name display'),
    },
    async ({ space_id, lang = 'zh' }) => withModuleAuth('docs', async () => {
      const token = getUserToken();

      const res = await new Promise<any>((resolve, reject) => {
        const path = `/open-apis/wiki/v2/spaces/${space_id}?lang=${lang}`;
        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        name: res.data?.space?.name,
        description: res.data?.space?.description,
        space_id: res.data?.space?.space_id,
        space_type: res.data?.space?.space_type,
        visibility: res.data?.space?.visibility,
        open_sharing: res.data?.space?.open_sharing,
      };
    }),
  );

  // ── wiki get space info (tenant token) ─────────────────────────────────────
  server.tool(
    'feishu_wiki_get_space_tenant',
    [
      'Get detailed information about a specific wiki space by space_id.',
      'Uses tenant_access_token (app-level auth) - no user OAuth required.',
      'IMPORTANT: The bot/app itself must be a member or admin of the target wiki space.',
      'Set via LARK_WIKI_SPACE environment variable for default space.',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      lang: z.enum(['zh', 'id', 'de', 'en', 'es', 'fr', 'it', 'pt', 'vi', 'ru', 'hi', 'th', 'ko', 'ja', 'zh-HK', 'zh-TW'])
                .default('zh').optional().describe('Language for my_library space name display'),
    },
    async ({ space_id, lang = 'zh' }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const token = await getTenantAccessToken(appId, appSecret);

      const res = await new Promise<any>((resolve, reject) => {
        const path = `/open-apis/wiki/v2/spaces/${space_id}?lang=${lang}`;
        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        name: res.data?.space?.name,
        description: res.data?.space?.description,
        space_id: res.data?.space?.space_id,
        space_type: res.data?.space?.space_type,
        visibility: res.data?.space?.visibility,
        open_sharing: res.data?.space?.open_sharing,
      };
    }),
  );

  // ── wiki create space ──────────────────────────────────────────────────────
  server.tool(
    'feishu_wiki_create_space',
    [
      'Create a new wiki knowledge space.',
      'Requires user OAuth with wiki:space:write_only or wiki:wiki scope.',
      'NOTE: This API does NOT support tenant access token - only user_access_token.',
      'IMPORTANT: After creating a space, immediately call feishu_wiki_add_member to add your bot/app as an admin. This is required for tenant token operations to work on the new space. Use feishu_people_search to find your bot/app open_id first.',
    ].join('\n'),
    {
      name: z.string().describe('Knowledge space name'),
      description: z.string().default('').optional().describe('Knowledge space description'),
      open_sharing: z.enum(['open', 'closed']).default('closed').optional().describe('Sharing status: open or closed'),
    },
    async ({ name, description = '', open_sharing = 'closed' }) => withModuleAuth('docs', async () => {
      const token = getUserToken();
      const body: any = { name, description, open_sharing };

      const res = await new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request(
          { hostname: 'open.feishu.cn', path: '/open-apis/wiki/v2/spaces', method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        name: res.data?.space?.name,
        description: res.data?.space?.description,
        space_id: res.data?.space?.space_id,
        space_type: res.data?.space?.space_type,
        visibility: res.data?.space?.visibility,
        open_sharing: res.data?.space?.open_sharing,
      };
    }),
  );

  // ── wiki list members (user token) ─────────────────────────────────────────
  server.tool(
    'feishu_wiki_list_members_user',
    [
      'Get list of members and admins of a wiki knowledge space.',
      'Requires user OAuth with wiki:member:retrieve or wiki:wiki scope.',
      'Uses user_access_token.',
      'This is a paginated API - use page_token from the previous response to fetch more results.',
      'Set via LARK_WIKI_SPACE environment variable for default space.',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      page_size: z.number().int().min(1).max(50).default(20).optional().describe('Page size, max 50'),
      page_token: z.string().optional().describe('Page token from previous response for pagination'),
    },
    async ({ space_id, page_size = 20, page_token }) => withModuleAuth('docs', async () => {
      const token = getUserToken();

      const res = await new Promise<any>((resolve, reject) => {
        let path = `/open-apis/wiki/v2/spaces/${space_id}/members?page_size=${page_size}`;
        if (page_token) path += `&page_token=${encodeURIComponent(page_token)}`;

        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        members: (res.data?.members ?? []).map((m: any) => ({
          member_type: m.member_type,
          member_id: m.member_id,
          member_role: m.member_role,
          type: m.type,
        })),
        page_token: res.data?.page_token,
        has_more: res.data?.has_more,
      };
    }),
  );

  // ── wiki list members (tenant token) ───────────────────────────────────────
  server.tool(
    'feishu_wiki_list_members_tenant',
    [
      'Get list of members and admins of a wiki knowledge space.',
      'Uses tenant_access_token (app-level auth) - no user OAuth required.',
      'NOTE: The bot/app itself must be a member or admin of the target wiki space.',
      'This is a paginated API - use page_token from the previous response to fetch more results.',
      'Set via LARK_WIKI_SPACE environment variable for default space.',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      page_size: z.number().int().min(1).max(50).default(20).optional().describe('Page size, max 50'),
      page_token: z.string().optional().describe('Page token from previous response for pagination'),
    },
    async ({ space_id, page_size = 20, page_token }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const token = await getTenantAccessToken(appId, appSecret);

      const res = await new Promise<any>((resolve, reject) => {
        let path = `/open-apis/wiki/v2/spaces/${space_id}/members?page_size=${page_size}`;
        if (page_token) path += `&page_token=${encodeURIComponent(page_token)}`;

        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        members: (res.data?.members ?? []).map((m: any) => ({
          member_type: m.member_type,
          member_id: m.member_id,
          member_role: m.member_role,
        })),
        page_token: res.data?.page_token,
        has_more: res.data?.has_more,
      };
    }),
  );

  // ── wiki create node (tenant token) ──────────────────────────────────────
  server.tool(
    'feishu_wiki_create_node_tenant',
    [
      'Create a node in a Wiki knowledge space.',
      'Uses tenant_access_token - no user OAuth required.',
      'NOTE: The bot/app itself must have edit permission on the parent node.',
      'obj_type options: docx, sheet, mindnote, bitable, file, slides.',
      'node_type options: origin (document), shortcut (shortcut).',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      obj_type: z.enum(['docx', 'sheet', 'mindnote', 'bitable', 'file', 'slides']).describe('Document type'),
      parent_node_token: z.string().optional().describe('Parent node token. Omit for root level.'),
      node_type: z.enum(['origin', 'shortcut']).describe('Node type: origin (document) or shortcut'),
      origin_node_token: z.string().optional().describe('Origin node token for shortcuts'),
      title: z.string().optional().describe('Document title'),
    },
    async ({ space_id, obj_type, parent_node_token, node_type, origin_node_token, title }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const token = await getTenantAccessToken(appId, appSecret);

      const body: any = { obj_type, node_type };
      if (parent_node_token) body.parent_node_token = parent_node_token;
      if (origin_node_token) body.origin_node_token = origin_node_token;
      if (title) body.title = title;

      const res = await new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request(
          { hostname: 'open.feishu.cn', path: `/open-apis/wiki/v2/spaces/${space_id}/nodes`, method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        space_id: res.data?.node?.space_id,
        node_token: res.data?.node?.node_token,
        obj_token: res.data?.node?.obj_token,
        obj_type: res.data?.node?.obj_type,
        parent_node_token: res.data?.node?.parent_node_token,
        node_type: res.data?.node?.node_type,
        origin_node_token: res.data?.node?.origin_node_token,
        origin_space_id: res.data?.node?.origin_space_id,
        has_child: res.data?.node?.has_child,
        title: res.data?.node?.title,
        node_create_time: res.data?.node?.node_create_time,
        node_creator: res.data?.node?.node_creator,
      };
    }),
  );

  // ── wiki get node info (tenant token) ────────────────────────────────────
  server.tool(
    'feishu_wiki_get_node_tenant',
    [
      'Get detailed information about a wiki node.',
      'Uses tenant_access_token - no user OAuth required.',
      'Use node token or document token with obj_type specified.',
    ].join('\n'),
    {
      token: z.string().describe('Wiki node token or document token'),
      obj_type: z.enum(['doc', 'docx', 'sheet', 'mindnote', 'bitable', 'file', 'slides', 'wiki']).default('wiki').optional().describe('Document type, default: wiki'),
    },
    async ({ token, obj_type = 'wiki' }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const accessToken = await getTenantAccessToken(appId, appSecret);

      const res = await new Promise<any>((resolve, reject) => {
        const path = `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}&obj_type=${obj_type}`;
        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        space_id: res.data?.node?.space_id,
        node_token: res.data?.node?.node_token,
        obj_token: res.data?.node?.obj_token,
        obj_type: res.data?.node?.obj_type,
        parent_node_token: res.data?.node?.parent_node_token,
        node_type: res.data?.node?.node_type,
        origin_node_token: res.data?.node?.origin_node_token,
        origin_space_id: res.data?.node?.origin_space_id,
        has_child: res.data?.node?.has_child,
        title: res.data?.node?.title,
        obj_create_time: res.data?.node?.obj_create_time,
        obj_edit_time: res.data?.node?.obj_edit_time,
        node_create_time: res.data?.node?.node_create_time,
        creator: res.data?.node?.creator,
        owner: res.data?.node?.owner,
        node_creator: res.data?.node?.node_creator,
      };
    }),
  );

  // ── wiki list child nodes (tenant token) ─────────────────────────────────
  server.tool(
    'feishu_wiki_list_nodes_tenant',
    [
      'List child nodes of a wiki space or parent node.',
      'Uses tenant_access_token - no user OAuth required.',
      'Pagination supported via page_token.',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      page_size: z.number().int().min(1).max(50).default(20).optional().describe('Page size, max 50'),
      page_token: z.string().optional().describe('Page token for pagination'),
      parent_node_token: z.string().optional().describe('Parent node token, omit for root level'),
    },
    async ({ space_id, page_size = 20, page_token, parent_node_token }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const accessToken = await getTenantAccessToken(appId, appSecret);

      const res = await new Promise<any>((resolve, reject) => {
        let path = `/open-apis/wiki/v2/spaces/${space_id}/nodes?page_size=${page_size}`;
        if (page_token) path += `&page_token=${encodeURIComponent(page_token)}`;
        if (parent_node_token) path += `&parent_node_token=${encodeURIComponent(parent_node_token)}`;

        const req = https.request(
          { hostname: 'open.feishu.cn', path, method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}` } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        items: (res.data?.items ?? []).map((n: any) => ({
          space_id: n.space_id,
          node_token: n.node_token,
          obj_token: n.obj_token,
          obj_type: n.obj_type,
          parent_node_token: n.parent_node_token,
          node_type: n.node_type,
          origin_node_token: n.origin_node_token,
          origin_space_id: n.origin_space_id,
          has_child: n.has_child,
          title: n.title,
          node_creator: n.node_creator,
        })),
        page_token: res.data?.page_token,
        has_more: res.data?.has_more,
      };
    }),
  );

  // ── wiki move node (tenant token) ───────────────────────────────────────
  server.tool(
    'feishu_wiki_move_node_tenant',
    [
      'Move a wiki node to a new location within the same space or across spaces.',
      'Uses tenant_access_token - no user OAuth required.',
      'If node has children, all children will be moved together.',
    ].join('\n'),
    {
      space_id: z.string().describe('Current knowledge space ID of the node'),
      node_token: z.string().describe('Token of the node to move'),
      target_parent_token: z.string().optional().describe('Target parent node token, omit for root level'),
      target_space_id: z.string().optional().describe('Target knowledge space ID (for cross-space move)'),
    },
    async ({ space_id, node_token, target_parent_token, target_space_id }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const accessToken = await getTenantAccessToken(appId, appSecret);

      const body: any = {};
      if (target_parent_token) body.target_parent_token = target_parent_token;
      if (target_space_id) body.target_space_id = target_space_id;

      const res = await new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request(
          { hostname: 'open.feishu.cn', path: `/open-apis/wiki/v2/spaces/${space_id}/nodes/${node_token}/move`, method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        space_id: res.data?.node?.space_id,
        node_token: res.data?.node?.node_token,
        obj_token: res.data?.node?.obj_token,
        obj_type: res.data?.node?.obj_type,
        parent_node_token: res.data?.node?.parent_node_token,
        node_type: res.data?.node?.node_type,
        origin_node_token: res.data?.node?.origin_node_token,
        origin_space_id: res.data?.node?.origin_space_id,
        has_child: res.data?.node?.has_child,
        title: res.data?.node?.title,
        node_creator: res.data?.node?.node_creator,
      };
    }),
  );

  // ── wiki update node title (tenant token) ──────────────────────────────
  server.tool(
    'feishu_wiki_update_title_tenant',
    [
      'Update the title of a wiki node.',
      'Uses tenant_access_token - no user OAuth required.',
      'Only supports doc, docx, and shortcut node types.',
    ].join('\n'),
    {
      space_id: z.string().describe('Knowledge space ID'),
      node_token: z.string().describe('Token of the node to update'),
      title: z.string().describe('New title for the node'),
    },
    async ({ space_id, node_token, title }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const accessToken = await getTenantAccessToken(appId, appSecret);

      const res = await new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ title });
        const req = https.request(
          { hostname: 'open.feishu.cn', path: `/open-apis/wiki/v2/spaces/${space_id}/nodes/${node_token}/update_title`, method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true };
    }),
  );

  // ── wiki copy node (tenant token) ───────────────────────────────────────
  server.tool(
    'feishu_wiki_copy_node_tenant',
    [
      'Create a copy of a wiki node at a specified location.',
      'Uses tenant_access_token - no user OAuth required.',
      'Either target_parent_token or target_space_id (or both) must be provided.',
    ].join('\n'),
    {
      space_id: z.string().describe('Source knowledge space ID'),
      node_token: z.string().describe('Token of the node to copy'),
      target_parent_token: z.string().optional().describe('Target parent node token'),
      target_space_id: z.string().optional().describe('Target knowledge space ID'),
      title: z.string().optional().describe('New title for the copied node. If omitted, original title is used. If empty string, title is empty.'),
    },
    async ({ space_id, node_token, target_parent_token, target_space_id, title }) => withAuth(async () => {
      const appId = process.env.LARK_APP_ID;
      const appSecret = process.env.LARK_APP_SECRET;
      if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set');
      const accessToken = await getTenantAccessToken(appId, appSecret);

      const body: any = {};
      if (target_parent_token !== undefined) body.target_parent_token = target_parent_token;
      if (target_space_id !== undefined) body.target_space_id = target_space_id;
      if (title !== undefined) body.title = title;

      const res = await new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request(
          { hostname: 'open.feishu.cn', path: `/open-apis/wiki/v2/spaces/${space_id}/nodes/${node_token}/copy`, method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        space_id: res.data?.node?.space_id,
        node_token: res.data?.node?.node_token,
        obj_token: res.data?.node?.obj_token,
        obj_type: res.data?.node?.obj_type,
        parent_node_token: res.data?.node?.parent_node_token,
        node_type: res.data?.node?.node_type,
        origin_node_token: res.data?.node?.origin_node_token,
        origin_space_id: res.data?.node?.origin_space_id,
        has_child: res.data?.node?.has_child,
        title: res.data?.node?.title,
        node_creator: res.data?.node?.node_creator,
      };
    }),
  );
}

// ── Comment tools (tenant token only) ──────────────────────────────────────

export function registerCommentTools(server: McpServer) {
  const { LARK_APP_ID: appId, LARK_APP_SECRET: appSecret } = process.env;
  if (!appId || !appSecret) return;

  // 1. feishu_doc_comment_list - 获取云文档所有评论
  server.tool(
    'feishu_doc_comment_list',
    [
      'Get all comments from a document.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
      is_whole: z.boolean().optional().describe('Whether to get whole document comments. Default: false'),
      is_solved: z.boolean().optional().describe('Filter by solved status. Default: false'),
      page_token: z.string().optional().describe('Page token for pagination'),
      page_size: z.number().optional().describe('Page size. Default: 50, max: 100'),
      need_reaction: z.boolean().optional().describe('Whether to include reaction data. Default: false'),
    },
    async ({ file_token, file_type = 'docx', is_whole, is_solved, page_token, page_size, need_reaction }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const params = new URLSearchParams({ file_type });
      if (is_whole !== undefined) params.append('is_whole', String(is_whole));
      if (is_solved !== undefined) params.append('is_solved', String(is_solved));
      if (page_token) params.append('page_token', page_token);
      if (page_size !== undefined) params.append('page_size', String(page_size));
      if (need_reaction !== undefined) params.append('need_reaction', String(need_reaction));

      const res = await larkGet(`/open-apis/drive/v1/files/${file_token}/comments?${params}`, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        has_more: res.data?.has_more,
        page_token: res.data?.page_token,
        items: res.data?.items || [],
        total_count: res.data?.items?.length || 0
      };
    }),
  );

  // 2. feishu_doc_comment_get_replies - 获取回复信息
  server.tool(
    'feishu_doc_comment_get_replies',
    [
      'Get replies for a specific comment.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      comment_id: z.string().describe('Comment ID'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
      page_token: z.string().optional().describe('Page token for pagination'),
      page_size: z.number().optional().describe('Page size. Default: 50, max: 100'),
    },
    async ({ file_token, comment_id, file_type = 'docx', page_token, page_size }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const params = new URLSearchParams({ file_type });
      if (page_token) params.append('page_token', page_token);
      if (page_size !== undefined) params.append('page_size', String(page_size));

      const res = await larkGet(`/open-apis/drive/v1/files/${file_token}/comments/${comment_id}/replies?${params}`, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return {
        has_more: res.data?.has_more,
        page_token: res.data?.page_token,
        items: res.data?.items || [],
        total_count: res.data?.items?.length || 0
      };
    }),
  );

  // 3. feishu_doc_comment_add_reply - 添加回复
  server.tool(
    'feishu_doc_comment_add_reply',
    [
      'Add a reply to a comment.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      comment_id: z.string().describe('Comment ID'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
      text: z.string().describe('Reply text content'),
      at_open_id: z.string().optional().describe('Open ID of user to @mention'),
    },
    async ({ file_token, comment_id, file_type = 'docx', text, at_open_id }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const elements: any[] = [];
      if (at_open_id) {
        elements.push({ type: 'person', person: { user_id: at_open_id } });
        elements.push({ type: 'text_run', text_run: { text: ` ${text}` } });
      } else {
        elements.push({ type: 'text_run', text_run: { text } });
      }
      const body = {
        content: { elements }
      };

      const res = await larkPost(`/open-apis/drive/v1/files/${file_token}/comments/${comment_id}/replies?file_type=${file_type}`, body, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true, reply_id: res.data?.reply_id };
    }),
  );

  // 4. feishu_doc_comment_update_reply - 更新回复的内容
  server.tool(
    'feishu_doc_comment_update_reply',
    [
      'Update reply content.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      comment_id: z.string().describe('Comment ID'),
      reply_id: z.string().describe('Reply ID'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
      text: z.string().describe('New reply text content'),
    },
    async ({ file_token, comment_id, reply_id, file_type = 'docx', text }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const body = {
        content: {
          elements: [
            { type: 'text_run', text_run: { text } }
          ]
        }
      };

      const res = await larkPut(`/open-apis/drive/v1/files/${file_token}/comments/${comment_id}/replies/${reply_id}?file_type=${file_type}`, body, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true };
    }),
  );

  // 5. feishu_doc_comment_delete_reply - 删除回复
  server.tool(
    'feishu_doc_comment_delete_reply',
    [
      'Delete a reply.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      comment_id: z.string().describe('Comment ID'),
      reply_id: z.string().describe('Reply ID'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
    },
    async ({ file_token, comment_id, reply_id, file_type = 'docx' }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const res = await larkDelete(`/open-apis/drive/v1/files/${file_token}/comments/${comment_id}/replies/${reply_id}?file_type=${file_type}`, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true };
    }),
  );

  // 6. feishu_doc_comment_resolve - 解决/恢复评论
  server.tool(
    'feishu_doc_comment_resolve',
    [
      'Resolve or unresolve a comment.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      comment_id: z.string().describe('Comment ID'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
      resolved: z.boolean().describe('True to resolve, false to unresolve'),
    },
    async ({ file_token, comment_id, file_type = 'docx', resolved }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const body = { is_solved: resolved };

      const res = await larkPatch(`/open-apis/drive/v1/files/${file_token}/comments/${comment_id}?file_type=${file_type}`, body, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true, resolved };
    }),
  );

  // 7. feishu_doc_comment_reaction - 添加/取消表情回应
  server.tool(
    'feishu_doc_comment_reaction',
    [
      'Add or remove emoji reaction to a comment.',
      'Uses tenant_access_token only - no user OAuth required.',
      'Reaction type: ANGRY, APPLAUSE, ATTENTION, AWESOME, BEAR, BEER, BETRAYED, BIGKISS, BLACKFACE, BLUBBER, BLUSH, BOMB, CAKE, CHUCKLE, CLAP, CLEAVER, COMFORT, CRAZY, CRY, CUCUMBER, DETERGENT, DIZZY, DONE, DONNOTGO, DROOL, DROWSY, DULL, DULLSTARE, EATING, EMBARRASSED, ENOUGH, ERROR, EYESCLOSED, FACEPALM, FINGERHEART, FISTBUMP, FOLLOWME, FROWN, GIFT, GLANCE, GOODJOB, HAMMER, HAUGHTY, HEADSET, HEART, HEARTBROKEN, HIGHFIVE, HUG, HUSKY, INNOCENTSMILE, JIAYI, JOYFUL, KISS, LAUGH, LIPS, LOL, LOOKDOWN, LOVE, MONEY, MUSCLE, NOSEPICK, OBSESSED, OK, PARTY, PETRIFIED, POOP, PRAISE, PROUD, PUKE, RAINBOWPUKE, ROSE, SALUTE, SCOWL, SHAKE, SHHH, SHOCKED, SHOWOFF, SHY, SICK, SILENT, SKULL, SLAP, SLEEP, SLIGHT, SMART, SMILE, SMIRK, SMOOCH, SMUG, SOB, SPEECHLESS, SPITBLOOD, STRIVE, SWEAT, TEARS, TEASE, TERROR, THANKS, THINKING, THUMBSUP, TOASTED, TONGUE, TRICK, UPPERLEFT, WAIL, WAVE, WELLDONE, WHAT, WHIMPER, WINK, WITTY, WOW, WRONGED, XBLUSH, YAWN, YEAH, FIREWORKS, BULL, CALF, AWESOMEN, 2021, CANDIEDHAWS, REDPACKET, FORTUNE, LUCK, FIRECRACKER, Yes, No, Get, LGTM, Lemon, EatingFood, Hundred, MinusOne, ThumbsDown, Fire, OKR, Drumstick, BubbleTea, Loudspeaker, Pin, Coffee, Alarm, Trophy, Music, Typing, Pepper, CheckMark, CrossMark.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      file_type: z.string().optional().describe('Document type: docx, doc, sheet, file, slides. Default: docx'),
      reply_id: z.string().describe('Reply ID (not comment ID)'),
      reaction_type: z.string().describe('Reaction type, e.g., "HEART", "THUMBSUP", "LIKE", "WOW"'),
      action: z.enum(['add', 'delete']).describe('Action: add or delete reaction'),
    },
    async ({ file_token, file_type = 'docx', reply_id, reaction_type, action }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const body = { action, reply_id, reaction_type };

      const res = await larkPost(`/open-apis/drive/v2/files/${file_token}/comments/reaction?file_type=${file_type}`, body, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true, action, reaction_type };
    }),
  );

  // 8. feishu_doc_comment_add_whole - 添加全文评论
  server.tool(
    'feishu_doc_comment_add_whole',
    [
      'Add a whole-document comment.',
      'Uses tenant_access_token only - no user OAuth required.',
    ].join('\n'),
    {
      file_token: z.string().describe('Document token'),
      file_type: z.string().optional().describe('Document type: docx, doc. Default: docx'),
      text: z.string().describe('Comment text content'),
      at_open_id: z.string().optional().describe('Open ID of user to @mention'),
    },
    async ({ file_token, file_type = 'docx', text, at_open_id }) => withAuth(async () => {
      const token = await getTenantAccessToken(appId, appSecret);
      const elements: any[] = [];
      if (at_open_id) {
        elements.push({ type: 'person', person: { user_id: at_open_id } });
        elements.push({ type: 'text_run', text_run: { text: ` ${text}` } });
      } else {
        elements.push({ type: 'text_run', text_run: { text } });
      }
      const body = {
        reply_list: {
          replies: [
            { content: { elements } }
          ]
        }
      };

      const res = await larkPost(`/open-apis/drive/v1/files/${file_token}/comments?file_type=${file_type}`, body, token);
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { success: true, comment_id: res.data?.comment_id };
    }),
  );
}
