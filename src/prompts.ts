/**
 * Expose SKILL.md files from the personal plugin as MCP prompts.
 * This lets users ask "use the feishu-calendar skill" and get full guidance injected.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '../skills');

const SKILLS: Array<{ name: string; file: string; description: string }> = [
  { name: 'lark-mcp-guide',          file: 'feishu/SKILL.md',                              description: 'Overview of the personal Lark MCP server: key concepts, identifiers, auth, and all tool modules' },
  { name: 'feishu-calendar',         file: 'feishu/feishu-calendar/SKILL.md',               description: 'Guidance for calendar operations: create, list, patch, delete events' },
  { name: 'feishu-task',             file: 'feishu/feishu-task/SKILL.md',                   description: 'Guidance for task management: create, list, patch, delete tasks and tasklists' },
  { name: 'feishu-people',           file: 'feishu/feishu-people/SKILL.md',                 description: 'Guidance for user search and open_id resolution' },
  { name: 'feishu-im',               file: 'feishu/feishu-im/SKILL.md',                     description: 'Sending, replying, reading, searching, sending files, downloading attachments, and editing messages' },
  { name: 'feishu-interactive-cards',file: 'feishu/feishu-interactive-cards/SKILL.md',      description: 'Confirm dialogs, input forms, and progress tracker cards — interactive cards that update themselves' },
  { name: 'feishu-watch-loop',         file: 'feishu/feishu-watch-loop/SKILL.md',               description: 'Behavioural rules for autonomous watch-loop mode: loop structure, responding via Feishu, cards, schedules' },
  { name: 'feishu-doc',              file: 'feishu/feishu-doc/SKILL.md',                    description: 'Create, read, append, edit, delete, and search Lark documents' },
];

// ── Inline prompt definitions ───────────────────────────────────────────────

const OVERVIEW_PROMPT = `
# Lark MCP Server — Overview

This MCP server gives you tools to interact with Lark/Feishu on behalf of a user.

---

## Key Concepts

### Identifiers
- **open_id** (\`ou_xxx\`) — identifies a user. Get yours with \`feishu_auth_whoami\`.
- **chat_id** (\`oc_xxx\`) — identifies a conversation (DM or group). Returned by \`feishu_im_send\`.
- **message_id** (\`om_xxx\`) — identifies a single message. Returned by send/reply tools.

### Authentication — TAT vs UAT
- **TAT (Tenant Access Token)** — app-level token. Used automatically by most read/write tools. No user login needed.
- **UAT (User Access Token)** — OAuth token tied to a specific user. Required for operations that must act *as the user* (e.g. reading private calendars, creating events on their behalf).
- Use \`feishu_auth_init\` to start OAuth flow, \`feishu_auth_status\` to check, \`feishu_auth_whoami\` to confirm identity.

---

## Tool Inventory

### Identity & Auth
| Tool | Purpose |
|------|---------|
| \`feishu_auth_whoami\` | Get current user's open_id, name, user_id |
| \`feishu_auth_init\` | Start OAuth login flow |
| \`feishu_auth_status\` | Check if user is authenticated |
| \`feishu_people_search\` | Resolve a name → open_id (for invites, messaging) |

### Messaging
| Tool | Purpose |
|------|---------|
| \`feishu_im_send\` | Send a message to a user or chat (text, rich text, card, or file). Use \`reply_to\` (message_id) to thread a reply. |
| \`feishu_im_read\` | Read recent messages from a chat or thread |
| \`feishu_im_search\` | Search messages by keyword |
| \`feishu_im_fetch_resource\` | Download an image or file from a message |
| \`feishu_im_patch\` | Edit / update an already-sent message |

### Interactive Cards
Cards sent by these tools update themselves automatically after user interaction.

| Tool | Purpose |
|------|---------|
| \`feishu_im_send_confirm\` | Send a confirm/cancel card. \`blocking=true\` waits for click. |
| \`feishu_im_send_form\` | Send a form card (text fields, optional, hidden). \`blocking=true\` waits for submit. |
| \`feishu_im_send_progress\` | Send a multi-step progress card |
| \`feishu_im_patch_progress\` | Advance the progress card to the next step (or completed) |

### Calendar
| Tool | Purpose |
|------|---------|
| \`feishu_calendar_create\` | Create an event (supports recurrence, reminders, location) |
| \`feishu_calendar_list\` | List or search events (default: this Mon → next Sun) |
| \`feishu_calendar_patch\` | Edit an event (title, time, location…) |
| \`feishu_calendar_delete\` | Delete an event or a recurring instance |

### Tasks
| Tool | Purpose |
|------|---------|
| \`feishu_task_create\` | Create a task (assigns to self by default) |
| \`feishu_task_list\` | List tasks (My Tasks, or by tasklist) |
| \`feishu_task_patch\` | Edit a task — title, due date, completion status |
| \`feishu_task_delete\` | Delete a task |
| \`feishu_task_list_lists\` | List tasklists |
| \`feishu_task_create_list\` | Create a tasklist |
| \`feishu_task_patch_list\` | Rename / edit a tasklist |
| \`feishu_task_delete_list\` | Delete a tasklist |

### Documents
| Tool | Purpose |
|------|---------|
| \`feishu_doc_create\` | Create a new Lark doc |
| \`feishu_doc_fetch\` | Read a doc's content (returns plain text + blocks with block_id) |
| \`feishu_doc_append\` | Append a block (paragraph, heading, bullet, code, quote, todo, callout, equation, image) |
| \`feishu_doc_patch\` | Edit an existing block by block_id |
| \`feishu_doc_delete\` | Delete a block by block_id |
| \`feishu_doc_delete_file\` | Permanently delete an entire doc (or file/sheet/bitable) from Drive |
| \`feishu_doc_search\` | Search docs by keyword |

### Watch Loop *(optional — for autonomous monitoring)*
| Tool | Purpose |
|------|---------|
| \`feishu_im_watch\` | Block until a message, card callback, or schedule fires |
| \`feishu_schedule_create\` | Schedule a timed reminder to fire inside the watch loop |
| \`feishu_schedule_list\` | List pending schedules |
| \`feishu_schedule_delete\` | Cancel a schedule |

> Watch loop behaviour rules → **feishu-watch-loop** prompt.
> Full server orientation → **lark-mcp-guide** prompt.
`.trim();

export function registerPrompts(server: McpServer) {
  // ── Inline prompts ────────────────────────────────────────────────────────

  server.prompt(
    'feishu-overview',
    'Brief overview of all available Lark MCP tools including the optional conversation module',
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: OVERVIEW_PROMPT } }] }),
  );

  // ── Skill-file prompts ────────────────────────────────────────────────────

  for (const skill of SKILLS) {
    const path = join(SKILLS_DIR, skill.file);
    if (!existsSync(path)) {
      process.stderr.write(`[lark-mcp] Skill not found, skipping: ${path}\n`);
      continue;
    }

    const content = readFileSync(path, 'utf8');

    server.prompt(
      skill.name,
      skill.description,
      () => ({
        messages: [{
          role: 'user',
          content: { type: 'text', text: content },
        }],
      }),
    );
  }
}
