/**
 * feishu_im_* MCP tools — send, reply, read, search messages, send/receive files.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname, basename } from 'path';
import { getLarkClient, asUser, withAuth } from '../client.js';
import { withModuleAuth } from '../auth-guard.js';

// MIME type → extension map for downloaded resources
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
  'application/pdf': '.pdf', 'text/plain': '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/zip': '.zip',
};

/** Detect receive_id_type from ID prefix. om_xxx → reply, oc_xxx → chat_id, ou_xxx → open_id, @→email, else user_id */
export function detectIdType(id: string): 'reply' | 'open_id' | 'chat_id' | 'user_id' | 'email' {
  if (id.startsWith('om_')) return 'reply';
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('ou_')) return 'open_id';
  if (id.includes('@')) return 'email';
  return 'user_id';
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function registerImTools(server: McpServer) {
  // ── send ───────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_send',
    [
      'Send a message or reply.',
      '',
      'receive_id: ou_xxx (open_id), oc_xxx (chat_id), om_xxx (replies to that message), email, or user_id.',
      'Type is auto-detected from prefix — no receive_id_type needed.',
      '',
      'MESSAGE TYPES (pick one):',
      '  text        — plain text. NO markdown rendering.',
      '  post        — rich text. Supply post_title + post_rows (array of rows, each row = array of elements).',
      '                Elements: {tag:"text",text:"...",style?:["bold","italic","inline_code",...]}',
      '                          {tag:"a",text:"label",href:"https://..."}',
      '                          {tag:"at",user_id:"ou_xxx",user_name:"name"}',
      '  interactive — card (schema 2.0 JSON string). Markdown rendered inside markdown elements.',
      '  file        — supply file_path. Images (.png/.jpg/.gif/.webp) → image msg; others → file attachment.',
    ].join('\n'),
    {
      receive_id: z.string().describe('Recipient: ou_xxx (open_id), oc_xxx (chat_id), om_xxx (reply to that message), email, or user_id. Type auto-detected from prefix.'),
      text:       z.string().optional().describe('Plain text message (use for simple messages)'),
      post_title: z.string().optional().describe('Title for a post (rich-text) message'),
      post_rows:  z.array(z.array(z.record(z.any()))).optional()
                    .describe('Rows of a post message. Each row is an array of inline elements (text/a/at tags).'),
      card:       z.string().optional().describe('Interactive card as a JSON string (schema 2.0). Use for tables, buttons, complex layouts.'),
      file_path:  z.string().optional().describe('Absolute local path to a file or image to send. Images (.png/.jpg/.gif/.webp) are sent as image messages; other files as attachments.'),
      file_name:  z.string().optional().describe('Override display filename (defaults to basename of file_path)'),
    },
    async ({ receive_id, text, post_title, post_rows, card, file_path, file_name }) => withAuth(async () => {
      if (!receive_id) throw new Error('Provide receive_id');
      const isReply = detectIdType(receive_id) === 'reply';
      const client = getLarkClient();

      let msg_type: string;
      let content: string;

      if (file_path) {
        const name = file_name ?? basename(file_path);
        const ext = extname(name).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
        if (isImage) {
          const res = await (client.im.image as any).create({
            data: { image_type: 'message', image: createReadStream(file_path) },
          });
          const code = res?.code ?? res?.data?.code;
          if (code !== undefined && code !== 0) throw new Error(`Image upload error ${code}: ${res?.msg ?? res?.data?.msg}`);
          msg_type = 'image';
          content = JSON.stringify({ image_key: res.data?.image_key ?? res.image_key });
        } else {
          const EXT_TO_TYPE: Record<string, string> = {
            '.mp4': 'mp4', '.mov': 'mp4', '.avi': 'mp4',
            '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc',
            '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt',
            '.mp3': 'opus', '.wav': 'opus', '.ogg': 'opus', '.m4a': 'opus',
          };
          const fileType = EXT_TO_TYPE[ext] ?? 'stream';
          const res = await (client.im.file as any).create({
            data: { file_type: fileType, file_name: name, file: createReadStream(file_path) },
          });
          const code = res?.code ?? res?.data?.code;
          if (code !== undefined && code !== 0) throw new Error(`File upload error ${code}: ${res?.msg ?? res?.data?.msg}`);
          msg_type = 'file';
          content = JSON.stringify({ file_key: res.data?.file_key ?? res.file_key });
        }
      } else if (card) {
        msg_type = 'interactive';
        content = card;
      } else if (post_rows !== undefined || post_title !== undefined) {
        msg_type = 'post';
        content = JSON.stringify({
          zh_cn: { title: post_title ?? '', content: post_rows ?? [] },
        });
      } else if (text !== undefined) {
        msg_type = 'text';
        content = JSON.stringify({ text });
      } else {
        throw new Error('Provide one of: text, post_title+post_rows, card, or file_path');
      }

      let res: any;
      if (isReply) {
        res = await client.im.message.reply({
          path: { message_id: receive_id },
          data: { msg_type, content },
        });
      } else {
        res = await client.im.message.create({
          params: { receive_id_type: detectIdType(receive_id) },
          data: { receive_id, msg_type, content },
        });
      }
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { message_id: res.data?.message_id, chat_id: res.data?.chat_id, sent: true, msg_type };
    }),
  );

  // ── read ───────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_read',
    'Read messages from a chat or message thread.',
    {
      container_id:      z.string().describe('chat_id or message_id (for thread)'),
      container_id_type: z.enum(['chat', 'thread']).default('chat'),
      page_size:         z.number().int().default(20).optional(),
    },
    async ({ container_id, container_id_type, page_size }) => withAuth(async () => {
      const client = getLarkClient();
      const res = await client.im.message.list({
        params: { container_id_type, container_id, page_size: page_size ?? 20, sort_type: 'ByCreateTimeDesc' },
      });
      if ((res as any).code !== 0) throw new Error(`Lark API ${(res as any).code}: ${(res as any).msg}`);
      const items = ((res as any).data?.items ?? []).map((m: any) => {
        let body = m.body?.content;
        try { body = JSON.parse(body); } catch {}
        return {
          message_id: m.message_id,
          sender_id:  m.sender?.id,
          sender_type: m.sender?.sender_type,
          create_time: m.create_time,
          msg_type:   m.msg_type,
          content:    body,
        };
      });
      return { messages: items, count: items.length };
    }),
  );

  // ── fetch_resource ─────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_fetch_resource',
    'Download a file or image from a Lark message to a local temp file. Use the file_key or image_key from message content.',
    {
      message_id: z.string().describe('Message ID (om_xxx)'),
      file_key:   z.string().describe('file_key (file_xxx) or image_key (img_xxx) from the message content'),
      type:       z.enum(['image', 'file']).describe('"image" for images, "file" for files/audio/video'),
    },
    async ({ message_id, file_key, type }) => withAuth(async () => {
      const client = getLarkClient();
      const res = await (client.im.messageResource as any).get({
        path: { message_id, file_key },
        params: { type },
      });
      if (res.code !== undefined && res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);

      // Response is a binary stream
      const stream = typeof res.getReadableStream === 'function' ? res.getReadableStream() : res;
      const buffer = await streamToBuffer(stream);

      // Infer extension from Content-Type header
      const contentType: string = res.headers?.['content-type'] ?? '';
      const mimeType = contentType.split(';')[0].trim();
      const ext = MIME_TO_EXT[mimeType] ?? (type === 'image' ? '.bin' : '.bin');

      const dir = join(tmpdir(), 'lark-mcp');
      await mkdir(dir, { recursive: true });
      const saved_path = join(dir, `${file_key}${ext}`);
      await writeFile(saved_path, buffer);

      return { saved_path, size_bytes: buffer.length, content_type: contentType, file_key };
    }),
  );

  // ── search ─────────────────────────────────────────────────────────────────
  server.tool(
    'feishu_im_search',
    'Search messages by keyword. Returns matching message IDs.',
    {
      query:     z.string().describe('Search keyword'),
      page_size: z.number().int().default(20).optional(),
    },
    async ({ query, page_size }) => withModuleAuth('im', async () => {
      const client = getLarkClient();
      // Use the search/v2 message search endpoint
      const res = await (client as any).search.v2.message.create({
        params: { page_size: page_size ?? 20 },
        data: { query },
      }, asUser());
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      // search/v2/message returns an array of message ID strings, not full message objects
      const messageIds: string[] = res.data?.items ?? [];
      return { message_ids: messageIds, count: messageIds.length };
    }),
  );

  // ── patch (update card content) ────────────────────────────────────────────
  server.tool(
    'feishu_im_patch',
    [
      'Update the content of an existing interactive card message in-place.',
      'Use this to transition a card from one state to another (e.g. blue auth button → green success).',
      '',
      'message_id — the om_xxx ID returned when the card was originally sent.',
      'card       — the new card JSON (same format as feishu_im_send card param).',
    ].join('\n'),
    {
      message_id: z.string().describe('Message ID to update (om_xxx)'),
      card:       z.string().describe('New card JSON string (schema 2.0)'),
    },
    async ({ message_id, card }) => withAuth(async () => {
      const client = getLarkClient();
      const res = await (client as any).im.message.patch({
        path: { message_id },
        data: { content: card },
      });
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      return { updated: true, message_id };
    }),
  );
}
