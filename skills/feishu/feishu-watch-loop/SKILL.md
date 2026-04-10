---
name: feishu-watch-loop
description: Behavioural rules for autonomous watch-loop mode using feishu_im_watch and feishu_schedule_*. Use it when user want interaction through feishu/lark
---

# Watch Loop — Behaviour Rules

You are in autonomous watch-loop mode. These rules apply for the duration.

---

## Loop Structure

Call `feishu_im_watch` and stay in it. On timeout, restart immediately. Stop only when the user explicitly tells you to stop.

```
LOOP:
  result = feishu_im_watch(chat_id, timeout=360)   # minutes; max 360
  if timed_out       → restart (no action needed)
  if fired_schedules → handle each, then restart
  if messages        → process, respond via Feishu, then restart
  if card_callbacks  → handle form/confirm response, then restart
```

### feishu_im_watch return format

```json
{
  "messages": [
    {
      "from": "ou_xxx",
      "reply_to": "om_xxx",
      "time": "14:32",
      "texts": ["first message", "second message"]
    }
  ],
  "card_callbacks": [...],
  "fired_schedules": [...],
  "timed_out": false,
  "reminder": "..."
}
```

- **messages** — grouped by consecutive sender. Each group: `from` (sender open_id), `reply_to` (last message_id, pass as `reply_to` to `feishu_im_send`), `time` (HH:MM Beijing), `texts` (array of message strings in order).
- **card_callbacks** / **fired_schedules** — omitted when empty.
- **timed_out** — if true, simply restart immediately.

---

## Responding

**Always reply via Feishu tools — never via Claude Code chat output.**
The user is reading Feishu, not the terminal.

- Use `feishu_im_send` with `reply_to` (the message_id from `reply_to` field in the message group) to thread under the user's message.
- Use `feishu_im_send` with `receive_id` for standalone messages (status updates, new topics).

---

## Interactive Cards

Prefer cards over plain text when:
- Asking the user to confirm an action → `feishu_im_send_confirm`
- Collecting structured input → `feishu_im_send_form`
- Running a multi-step task → `feishu_im_send_progress` + `feishu_im_patch_progress`

**Do NOT use `blocking=true` inside the watch loop** — it blocks all incoming messages while waiting. Always use `blocking=false` and handle the callback in the next `feishu_im_watch` cycle.

For progress cards, send first, then patch as each step completes.

---

## Schedules

Use `feishu_schedule_create` to set a timed reminder that fires inside the watch loop. List pending schedules with `feishu_schedule_list`. Cancel with `feishu_schedule_delete`.

Schedules fire as events in the `feishu_im_watch` result — handle them the same way you handle messages.

---

## Authentication During Watch Loop

When a tool call fails with a 401 / auth error, `withModuleAuth` handles it automatically — it blocks inline, sends one auth card, waits for the user to click, then proceeds. You do NOT need to call `feishu_auth_init` manually. Just retry the tool after the error resolves.

`feishu_auth_init` is only needed when you want to proactively trigger OAuth before starting a task.

---

## Multi-step Tasks

Always send a `feishu_im_send_progress` card **before** starting any task with 2+ steps (e.g. auth + fetch + present). Patch after each step completes.

`feishu_im_patch_progress` only needs `message_id` + `current_step` — title and steps are cached server-side. Use `step_updates` to revise a step's detail text. Returns `result: "Updated."`, `"Task complete."`, or `"User asked to stop — abort the task."` — act on the last one immediately.

---

## Destructive Actions

Always send a `feishu_im_send_confirm` card before **any** delete, overwrite, or irreversible operation — even if the user already said "delete it". The confirm card lists exactly what will be deleted. Use `blocking=false` and handle in the next watch cycle.

---

## Tone

Natural and conversational — not robotic status dumps. Keep responses concise; use cards for structured content.
