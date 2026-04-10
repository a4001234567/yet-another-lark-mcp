/**
 * feishu_doc_* MCP tools — create, fetch, update documents, search docs/wiki.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import https from 'https';
import { createReadStream, statSync } from 'fs';
import { getLarkClient, asUser } from '../client.js';
import { getUserToken } from '../auth.js';
import { withModuleAuth } from '../auth-guard.js';

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
    },
    async ({ document_id, text = '', type = 'paragraph', bold, italic, inline_code, done, image_path, callout_emoji, callout_bg }) => withModuleAuth('docs', async () => {
      const client = getLarkClient();
      const docRes = await (client as any).docx.v1.document.get(
        { path: { document_id } }, asUser(),
      );
      if (docRes.code !== 0) throw new Error(`Get doc error ${docRes.code}: ${docRes.msg}`);
      const blockId = docRes.data?.document?.body?.block_id ?? document_id;

      // ── image block (3-step) ─────────────────────────────────────────────────
      if (type === 'image') {
        if (!image_path) throw new Error('image_path is required for image blocks');

        // Step 1: create empty image block → get Image BlockID
        const createRes = await (client as any).docx.v1.documentBlockChildren.create({
          path: { document_id, block_id: blockId },
          params: { document_revision_id: -1 },
          data: { children: [{ block_type: 27, image: {} }], index: -1 },
        }, asUser());
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
        return { ok: true, document_id, appended: true, type: 'image' };
      }

      // ── equation block (paragraph with inline equation element) ─────────────
      if (type === 'equation') {
        const latex = text.endsWith('\n') ? text : text + '\n';
        const res = await (client as any).docx.v1.documentBlockChildren.create({
          path: { document_id, block_id: blockId },
          params: { document_revision_id: -1 },
          data: {
            children: [{ block_type: 2, text: {
              elements: [{ equation: { content: latex, text_element_style: {} } }],
              style: { align: 1, folded: false },
            }}],
            index: -1,
          },
        }, asUser());
        const resCode = res?.code ?? res?.data?.code;
        if (resCode !== 0 && resCode !== undefined) throw new Error(`Lark API ${resCode}: ${res?.msg ?? res?.data?.msg}`);
        return { ok: true, document_id, appended: true, type: 'equation' };
      }

      // ── callout block (2-step container) ────────────────────────────────────
      if (type === 'callout') {
        // Step 1: create the callout container block
        // style fields go directly on callout object (no 'style' wrapper)
        const calloutData: any = {};
        if (callout_emoji) calloutData.emoji_id = callout_emoji;
        if (callout_bg)    calloutData.background_color = callout_bg;
        const createRes = await (client as any).docx.v1.documentBlockChildren.create({
          path: { document_id, block_id: blockId },
          params: { document_revision_id: -1 },
          data: { children: [{ block_type: 19, callout: calloutData }], index: -1 },
        }, asUser());
        const createCode = createRes?.code ?? createRes?.data?.code;
        if (createCode !== 0 && createCode !== undefined) throw new Error(`Create callout error ${createCode}: ${createRes?.msg ?? createRes?.data?.msg}`);
        const calloutBlockId = createRes?.data?.children?.[0]?.block_id;
        if (!calloutBlockId) throw new Error('Create callout returned no block_id');

        // Step 2: insert text paragraph inside the callout
        const inlineStyle: any = {};
        if (bold)        inlineStyle.bold        = true;
        if (italic)      inlineStyle.italic      = true;
        if (inline_code) inlineStyle.inline_code = true;
        const innerRes = await (client as any).docx.v1.documentBlockChildren.create({
          path: { document_id, block_id: calloutBlockId },
          params: { document_revision_id: -1 },
          data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: text, text_element_style: inlineStyle } }], style: {} } }], index: 0 },
        }, asUser());
        const innerCode = innerRes?.code ?? innerRes?.data?.code;
        if (innerCode !== 0 && innerCode !== undefined) throw new Error(`Insert callout text error ${innerCode}: ${innerRes?.msg ?? innerRes?.data?.msg}`);
        return { ok: true, document_id, appended: true, type: 'callout' };
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

      const res = await (client as any).docx.v1.documentBlockChildren.create({
        path: { document_id, block_id: blockId },
        params: { document_revision_id: -1 },
        data: {
          children: [{ block_type, [blockKey]: blockContent }],
          index: -1,
        },
      }, asUser());
      const resCode = res?.code ?? res?.data?.code;
      if (resCode !== 0 && resCode !== undefined) throw new Error(`Lark API ${resCode}: ${res?.msg ?? res?.data?.msg} | block_type=${block_type} key=${blockKey}`);
      return { ok: true, document_id, appended: true, type };
    }),
  );
}
