import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserToken } from '../auth.js';
import { withModuleAuth } from '../auth-guard.js';
import https from 'https';

function postWithAuth(token: string, path: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let r = ''; res.on('data', (c) => (r += c)); res.on('end', () => resolve(JSON.parse(r))); },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function registerPeopleTools(server: McpServer) {
  server.tool(
    'feishu_people_search',
    'Search for Lark/Feishu users by name or keyword. Returns open_id (ou_xxx) needed for calendar invites, task assignment, and messaging.',
    { query: z.string().describe('Name, email, or keyword'), page_size: z.number().int().min(1).max(50).default(10).optional() },
    async ({ query, page_size }) => withModuleAuth('people', async () => {
      const res = await postWithAuth(getUserToken(), '/open-apis/search/v1/user', { query, page_size: String(page_size ?? 10) });
      if (res.code !== 0) throw new Error(`Lark API ${res.code}: ${res.msg}`);
      const users = (res.data?.users ?? []).map((u: any) => ({
        open_id: u.id?.open_id,
        name: u.name,
        en_name: u.en_name ?? undefined,
        department: u.department_name ?? undefined,
      })).filter((u: any) => u.open_id);
      return { users, count: users.length };
    }),
  );
}
