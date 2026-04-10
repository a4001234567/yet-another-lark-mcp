# Lark MCP Server — Design Notes

This document records key design decisions, trade-offs, and non-obvious choices in the MCP server implementation. It is intended for maintainers who need to understand *why* things work the way they do.

---

## Architecture

### Single-process, event-loop driven

The server is a stdio MCP server running as a single Node.js process. All async I/O (Lark API calls, WebSocket, token refresh) runs on the same event loop. This means:

- `async/await` does NOT block the event loop — the WS client can receive messages while OAuth is polling.
- There are no threads, no worker pool, no parallelism beyond the event loop.
- Long-running blocking tool calls (e.g. `feishu_auth_init`, `feishu_im_watch`) yield back to the event loop between awaits.

### Transport: stdio

Claude Desktop / Cursor / other clients start the server as a subprocess and communicate via stdin/stdout. The server never starts an HTTP server. This means restarts are controlled by the client, not the server.

---

## Auth Design

### Two-token system (TAT + UAT)

- **TAT** (Tenant Access Token): app-level, fetched automatically per-request. Used for messaging (sending cards, reading messages) and resolving the owner's `open_id`.
- **UAT** (User Access Token): per-user OAuth token stored in `~/.config/lark-mcp/tokens.json`. Required for calendar, tasks, docs, people search — anything that must act *as the user*.

Messaging tools intentionally do NOT require UAT. The bot can always send and receive messages even when the user has never completed OAuth.

### Scope accumulation

Each OAuth flow requests the union of all previously-granted scopes plus the new module's scopes. This ensures re-auth for one module doesn't revoke another module's access (Lark replaces the token on each grant).

### Optimistic pass after restart

Granted scopes are tracked in memory (`_grantedScopes` Set) but not persisted to disk. After a server restart, `getGrantedScopes().length === 0` even though the token file has a valid UAT. To avoid blocking every call on cold start, `requireModuleAuth` passes through optimistically when no scope info is available, relying on the API to 401 if the token is actually insufficient.

### Inline blocking auth (withModuleAuth)

When a tool call triggers auth, `withModuleAuth` blocks inline — it runs the full OAuth device flow (send card → poll → receive token) before proceeding into the tool handler. The watch loop stalls during this period.

**Trade-off considered**: Non-blocking auth (fire-and-forget poll) was tried first. It caused two auth cards to be sent — one from `withModuleAuth`, one from the model calling `feishu_auth_init` manually. The inline blocking approach avoids this duplication. The downside (watch loop stalls) is acceptable because auth requires user action anyway.

---

## Watch Loop Design

### Message grouping

`feishu_im_watch` returns messages grouped by consecutive sender:

```
{ from, reply_to, time, texts[] }
```

**Why**: Users frequently send multiple short messages in rapid succession ("burst typing"). If returned as separate entries, the model may respond to each partial thought individually. Grouping gives the model one coherent intent to process and reduces token overhead.

**reply_to**: The last `message_id` in the group. Use this for `feishu_im_reply` to thread under the user's most recent message.

### drainQueue: reverse-iterate splice

The message queue (`getMessageQueue()`) is a shared in-memory array. When draining for a specific `chat_id`, we iterate backwards and splice in-place. Forward iteration + splice would shift indices and skip elements (classic off-by-one). Reverse iteration preserves correctness.

### WS mode vs poll fallback

The server establishes a WebSocket long-connection to Lark at startup (`ws.ts`). In WS mode, messages arrive push-style and queue up in memory. `feishu_im_watch` simply drains the queue each tick.

If the WS connection fails, the tool falls back to REST polling (`im.message.list`) every `poll_interval` seconds. The `lastSeenMs` map tracks what's already been seen to avoid returning stale messages.

---

## Calendar Design

### list + search merged

The Lark calendar API has two separate endpoints:
- `instance_view`: returns expanded recurring occurrences in a time range, with location
- `calendarEvent.search`: keyword search, returns templates and out-of-window instances, NO location

`feishu_calendar_list` merges both behind one `query` parameter:
- No query → `instance_view` only (fast, complete, with location)
- Query + no time range → `calendarEvent.search` only
- Query + time range → cross-reference: keep only `instance_view` results whose parent event was found in search results

**Why cross-reference**: Search alone returns recurring templates (not expanded instances), doesn't return location, and can return events outside the requested window. `instance_view` alone can't filter by keyword. The cross-reference gives expanded instances with location, filtered to keyword matches.

### 40-day hard limit on instance_view

The Lark API returns error 193103 if the `instance_view` time range exceeds 40 days. The default range (this Monday → next Sunday, ~14 days) stays well within this limit. Callers should not request more than 40 days.

### Recurring instance materialisation

Lark recurring events use lazy materialisation:
- `event_id` ending in `_0`: the recurring template — patching/deleting affects ALL future occurrences
- `event_id` ending in `_<timestamp>` (suffix > 2 chars): a specific occurrence

Before patching or deleting a specific occurrence, it must be "materialised" by:
1. POSTing the caller as an attendee to the parent event with `instance_start_time_admin=<timestamp>`
2. RSVPing `accept` on the specific instance

This creates a distinct DB record for that occurrence. Without this step, mutations fall through to the template and affect all future occurrences.

---

## Docs Design

### feishu_doc_delete_file

Uses the Drive v1 API (`DELETE /open-apis/drive/v1/files/{token}?type={docx|file|sheet|bitable}`) directly via `https.request` rather than the Lark SDK, because the SDK does not expose this endpoint. The `type` parameter is required by the API — omitting it causes a 400 error.

---

## Interactive Cards Design

### Card registry + expiry

Sent cards are registered in `card-registry.ts` with an expiry timestamp. Each `feishu_im_watch` tick drains expired cards and patches them to a "已失效" (expired) state. This ensures stale cards don't remain interactive indefinitely.

### blocking=false as default

All interactive cards (`feishu_im_send_confirm`, `feishu_im_send_form`) default to `blocking=false` in the watch loop. `blocking=true` races against `feishu_im_watch` and causes the loop to stall, dropping messages during the wait.

**Exception**: `feishu_auth_init` and `withModuleAuth` are blocking by design (see Auth Design above).

---

## Known Limitations

- **Granted scopes not persisted**: server restart loses scope tracking → optimistic pass until next 401
- **Watch loop single-chat**: `feishu_im_watch` monitors one `chat_id`. Multi-chat monitoring is not supported.
- **Poll fallback latency**: in poll mode, message delivery latency = `poll_interval` (default 5s)
- **No subtask/comment support**: Lark Task v2 subtasks and comments are not implemented
- **No Bitable/Sheets**: enterprise modules, out of scope for personal use
