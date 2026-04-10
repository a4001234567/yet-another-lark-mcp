---
name: feishu-interactive-cards
description: |
    Interactive cards for confirm dialogs, input forms, and multi-step progress trackers.
    Use it when:
        You need to acquire consent for dangerous/non-recoverable operations;
        Structural information are to be acquired from user or sensitive information;
        Entering Multistage task or complex plan and you need to provide realtime update.

---

# Interactive Cards

Three card types — each sends a card that updates itself inline after the user interacts.

---

## Confirm Card — `feishu_im_send_confirm`

Present a yes/no decision. Use `blocking=true` to wait for the click before continuing; `blocking=false` (default) returns immediately and the result arrives in the next `feishu_im_watch` as `card_callbacks[].action` (`"confirm"` / `"cancel"`).

> **Watch-loop warning:** Do NOT use `blocking=true` inside the watch loop — it will block all incoming messages while waiting. Always use `blocking=false` and handle the callback in the next `feishu_im_watch` cycle.

| Param | Default | Notes |
|-------|---------|-------|
| `title` | required | Card heading |
| `body` | — | Markdown body text |
| `confirm_label` | `确认` | Confirm button text |
| `cancel_label` | `取消` | Cancel button text |
| `blocking` | `false` | Wait for click before returning |
| `timeout_seconds` | `3600` | Card expires after N seconds |

---

## Form Card — `feishu_im_send_form`

Collect structured input via text fields. Use `blocking=true` to wait for submission; `blocking=false` delivers `form_value` in the next `feishu_im_watch` as `card_callbacks[].form_value`.

Each field: `name` (result key), `label`, `placeholder?`, `required?`, `hidden?` (password input — shows `******` after submit).

| Param | Default | Notes |
|-------|---------|-------|
| `title` | required | Card heading |
| `body` | — | Markdown text above the fields |
| `fields` | required | Array of field definitions (min 1) |
| `submit_label` | `提交` | Submit button text |
| `blocking` | `false` | Wait for submission before returning |
| `timeout_seconds` | `3600` | Card expires after N seconds |

---

## Progress Card — `feishu_im_send_progress` + `feishu_im_patch_progress`

Show a multi-step task with a live progress bar and a **Stop button**. Send once, then patch after each step. Pass `current_step = steps.length` to mark complete (green header, 100%).

Each step: `label` + optional `detail` (expandable summary — useful to fill in on patch once a step is done).

**`feishu_im_send_progress` params:**

| Param | Notes |
|-------|-------|
| `receive_id` | Destination (ou_xxx or oc_xxx) |
| `title` | Card heading (cached server-side — do not repeat on patch) |
| `steps` | Ordered array of `{ label, detail? }` (cached server-side — do not repeat on patch) |
| `current_step` | 0-based active step; default 0 |

**`feishu_im_patch_progress` params** — `title` and `steps` are cached; only pass what changes:

| Param | Notes |
|-------|-------|
| `message_id` | Returned by `feishu_im_send_progress` |
| `current_step` | 0-based active step; `steps.length` = completed |
| `step_updates` | Optional `[{ index, detail }]` — update detail text on specific steps |

**Stop button:** The card shows a red Stop button while in progress. If the user presses it:
- The card immediately updates to grey "已停止"
- The stop event is queued for `feishu_im_watch`
- The next `feishu_im_patch_progress` call returns `{ result: "User asked to stop — abort the task." }` — abort and inform the user

---

## Lifecycle

| Card | Active | After interaction | Timeout |
|------|--------|-------------------|---------|
| Confirm | Blue, two buttons | Buttons removed, action shown | Grey 已失效 |
| Form | Blue, input fields | Fields disabled, values shown | Grey 已失效 |
| Progress | Blue, step list + bar + Stop button | Patched manually; Stop → grey 已停止 | No auto-expiry |

---

## Custom Raw Cards

Do not write raw card JSON manually — it is error-prone. Instead, find a working example in `cards-package/CARDS-REFERENCE.md`, then check field details in `cards-package/LARK-CARD-SCHEMA.md`. (Both files are in the same directory as this SKILL.md.)
