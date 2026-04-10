# lark-mcp-server — Usage Guide

General principles for using this MCP server. For per-tool details, inject relevant skill (e.g. feishu-calendar, feishu-im, feishu-watch-loop).

---

## Core principles

1. **Auth on-demand.** Messaging works without any OAuth — the bot uses its own App Token. Calendar, tasks, docs, and people search require user authorization. The tool will automatically send an authorization request to the owner in Feishu. Call `feishu_auth_status` to check what modules are currently authorized.

2. **Use cards when appropriate.** Cards available: progress tracker (`feishu_im_send_progress`), confirm dialog (`feishu_im_send_confirm`), form (`feishu_im_send_form`). Rules:
   - Simple tasks → reply and start immediately, no card needed.
   - Complex / multi-step tasks (research, multi-round operations, file processing) → send a progress card and update it as each step completes.
   - Destructive or irreversible actions → always confirm first via `feishu_im_send_confirm`.
   - **Always use `blocking=false` in the watch loop.** `blocking=true` halts execution inside a non-watch tool. Use `blocking=false` and callback is returned in the next `feishu_im_watch` cycle via `card_callbacks`.

3. **Post-compaction recovery:** When resuming from a compaction summary, immediately recover — do not wait for the user:

   1. `feishu_auth_whoami` → get owner `open_id`
   2. `feishu_im_send(open_id, "...")` → any brief message; use the returned `chat_id`
   3. `feishu_im_watch(chat_id)` → listening again

   To automate this, install the Claude Code SessionStart hook in `hooks/feishu-watch-recover.sh` — see README for instructions. When installed, the hook injects the recovery reminder into Claude's context automatically on every post-compaction session start. [IF YOU HAVE ALREADY INSTALL THE HOOK, OMIT THE INSTALLATION GUIDE]

4. **Always reply via Feishu/Lark.** All responses in watch-loop mode go through `feishu_im_send`.

5. **Clarify before acting, confirm before dangerous actions.** When a task is ambiguous or missing key details, ask the user to clarify first. Act only after the goal is clear. For destructive or irreversible operations (deleting events/tasks/docs, sending messages to third parties, modifying shared data), always ask for confirmation via `feishu_im_send_confirm` before proceeding.

## Event Handling Loop

COMMENTS:(DO NOT INJECT THIS TO PROMPT)

ONLY USE THIS PART WHEN EVENT LOOP MODE IS BEING REQUIRED!

1. Wait for incoming event using feishu-im-watch
2. Upon receiving incoming messages, either give short reply instantly, or acknowledge upon receive, and always return execution result through feishu messages upon finishing
3. If Unrecoverable operation including outbound modification or permanent deletion of file is to be executed, use interactive prompt card for confirmation. Always use blocking=false — handle the callback in the next watch cycle.
4. If the task requires multiple step, utilize the progress tracker card tool
5. Upon finishing, reply through Feishu messages, then resume the watchloop immediately.

---

## Available skills

Load a skill for detailed guidance on a specific domain:

| Skill | Domain |
|---|---|
| `lark-mcp-guide` | Overview: identifiers, auth, all tool modules |
| `feishu-calendar` | Create, list, patch, delete events |
| `feishu-task` | Create, list, patch, delete tasks and tasklists |
| `feishu-people` | User search and open_id resolution |
| `feishu-im` | Send, reply, read, search, files, attachments, edit messages |
| `feishu-interactive-cards` | Confirm dialogs, forms, progress tracker cards |
| `feishu-watch-loop` | Watch-loop rules: structure, schedules, responding via Feishu |
| `feishu-doc` | Create, fetch, append, edit, delete, search documents |
