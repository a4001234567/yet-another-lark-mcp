/**
 * nku_calendar_sync — Nankai University course table automatic sync to Feishu Calendar
 *
 * Pulls timetable from Nankai EAMIS system and creates recurring events in user's primary calendar.
 * Uses existing classTableLib.py script that handles scraping and event creation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { withModuleAuth } from '../auth-guard.js';
import { getOwnerOpenId } from '../auth.js';
import { getLarkClient } from '../client.js';
import { tokenRegistry, proxyPort, buildTokenCard, patchCard } from './token-proxy.js';

// Path to the Python script
const SCRIPT_PATH = new URL('../../nku-calendar/classTableLib.py', import.meta.url).pathname;

export function registerNkuCalendarTools(server: McpServer) {
  server.tool(
    'nku_calendar_sync',
    'Sync Nankai University (NKU) course timetable from EAMIS to Feishu Calendar. Creates recurring events automatically.',
    {
      username: z.string().describe('NKU student ID (EAMIS username)'),
      password: z.string().describe('EAMIS password'),
      semester_id: z.string().default('4364').describe('Semester ID (default: 4364 = 2025 Fall)'),
      start_date: z.string().default('2025-09-08').describe('First day of semester (YYYY-MM-DD)'),
      dry_run: z.boolean().default(false).describe('Preview what would be created without actually creating events'),
    },
    async (params) => withModuleAuth('calendar', async () => {
      // Wait for proxy to be ready — it's started async during registration
      if (proxyPort === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (proxyPort === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '错误：代理服务器未启动，请等待几秒钟后重试。',
          }],
        };
      }

      // Now issue our own token for the sync
      const token = `lmk_${randomBytes(8).toString('hex')}`;
      const now = Date.now();
      // Give 15 minutes for sync — enough for scraping and creating events
      const expiresAt = now + 15 * 60 * 1000;

      // Register the token in the token registry
      const entry = {
        token,
        reason: '南开大学课表同步',
        issued_at: now,
        expires_at: expiresAt,
        call_count: 0,
        call_types: new Map(),
        revoked: false,
        card_message_id: null,
        patch_timer: null,
      };
      tokenRegistry.set(token, entry);

      // Send a monitoring card to owner
      const ownerOpenId = getOwnerOpenId();
      if (ownerOpenId) {
        try {
          const client = getLarkClient();
          const cardContent = JSON.stringify(buildTokenCard(entry));
          const sendRes = await (client.im.message as any).create({
            params: { receive_id_type: 'open_id' },
            data: {
              receive_id: ownerOpenId,
              msg_type: 'interactive',
              content: cardContent,
            },
          });
          entry.card_message_id = (sendRes as any)?.data?.message_id ?? null;
        } catch {
          // best effort
        }
      }

      // Build the Python command args
      const args = [
        SCRIPT_PATH,
        '--proxy-url', `http://127.0.0.1:${proxyPort}`,
        '--proxy-token', token,
        '--username', params.username,
        '--password', params.password,
        '--semester-id', params.semester_id,
        '--start-date', params.start_date,
      ];
      if (params.dry_run) {
        args.push('--dry-run');
      }

      // Spawn Python and collect output
      return new Promise((resolve) => {
        const py = spawn('python3', args);
        let stdout = '';
        let stderr = '';

        py.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        py.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        py.on('close', (code) => {
          // Auto-expire the token after completion
          entry.expires_at = Date.now();
          if (entry.card_message_id) {
            patchCard(entry, true).catch(() => {});
          }

          const result = [
            `退出码: ${code}`,
            stdout ? `\n输出:\n${stdout}` : '',
            stderr ? `\n错误输出:\n${stderr}` : '',
          ].join('');

          resolve({
            content: [{ type: 'text' as const, text: result }],
          });
        });

        py.on('error', (err) => {
          entry.expires_at = Date.now();
          if (entry.card_message_id) {
            patchCard(entry, true).catch(() => {});
          }
          resolve({
            content: [{
              type: 'text' as const,
              text: `启动 Python 失败: ${err.message}\n\n请确保已安装 Python 3 并且依赖: pip install icalendar requests beautifulsoup4`,
            }],
          });
        });
      });
    }),
  );
}
