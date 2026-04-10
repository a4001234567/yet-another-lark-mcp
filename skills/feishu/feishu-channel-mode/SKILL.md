---
name: feishu-channel-mode
description: |
    Rules for operating in Claude Code channel mode (LARK_CHANNEL_MODE=1).
    Use when: messages arrive via notifications/claude/channel instead of feishu_im_watch.
    Covers: message handling, the consent card pattern, card callbacks, and scheduling.
---

# Feishu Channel Mode

In channel mode, Feishu messages are **pushed** to Claude Code via `notifications/claude/channel` instead of being polled by `feishu_im_watch`. This page explains how to handle messages, ask for permission, and manage card callbacks in this mode.

---

## How Messages Arrive

Each incoming Feishu message triggers a channel notification with:

```
content: "<message text>"
meta: {
  type:       "message",
  sender_id:  "ou_xxx",
  chat_id:    "oc_xxx",
  message_id: "om_xxx",
  msg_type:   "text",
  parent_id:  "om_xxx"   // set if this is a reply in a thread
}
```

**Do not call `feishu_im_watch`** — the gateway handles delivery. There is no watch loop.

**Always reply via `feishu_im_send`**, using `meta.chat_id` as the target (or `reply_to` for threaded replies). Never respond only in the Claude Code chat window — the user cannot see that.

---

## Consent Card Pattern (Permission for Dangerous Actions)

For **destructive or irreversible actions** (delete event, delete task, send to a third party, etc.), always ask the user's permission via a consent card before proceeding.

### Step 1 — Send the confirm card

```
feishu_im_send_confirm(
  receive_id      = meta.chat_id,
  receive_id_type = "chat_id",
  title           = "删除事件「周会」",
  body            = "此操作不可撤销。确认删除吗？",
  context         = { task: "delete_event", event_id: "xxx_1234567890", title: "周会" }
)
```

- Use `blocking=false` (default). **Do not use `blocking=true` in channel mode** — the callback arrives as a new notification, not as a return value from this call.
- The `context` object is embedded in both the confirm and cancel button values.
- Return immediately after sending the card. Your current turn ends here.

### Step 2 — Callback arrives as a new notification

When the user clicks, a new `notifications/claude/channel` event arrives:

```
content: "[Permission response] action=confirm, task=delete_event, event_id=xxx_1234567890, title=周会"
meta: {
  type:       "card_callback",
  action:     "confirm",       // or "cancel"
  message_id: "om_xxx",        // the card message
  open_id:    "ou_xxx",        // who clicked
  value: {
    action:   "confirm",
    task:     "delete_event",
    event_id: "xxx_1234567890",
    title:    "周会"
  }
}
```

Read `meta.value` to reconstruct the task. Check `meta.value.action`:
- `"confirm"` → proceed with the operation
- `"cancel"` → abort, send a brief cancellation message

```
if (meta.value.action === "confirm") {
  // execute: feishu_calendar_delete(event_id = meta.value.event_id)
  feishu_im_send(chat_id, "已删除「周会」")
} else {
  feishu_im_send(chat_id, "已取消")
}
```

---

## Form Callbacks

Form submissions (`feishu_im_send_form`) arrive the same way, with `meta.type = "card_callback"` and `meta.form_value` containing the submitted fields.

---

## Scheduling

`feishu_schedule_create` and `feishu_im_watch` still work in channel mode — the watch loop runs in the background and fires schedules even when no messages are arriving. To receive fired schedules in channel mode, use `feishu_im_watch` briefly in a background polling call, or rely on the gateway's tick-based delivery.

---

## Key Rules

1. **No watch loop** — do not call `feishu_im_watch` as your primary message loop.
2. **Always reply via Feishu** (`feishu_im_send`) — never only in Claude Code chat.
3. **Consent before destructive actions** — send a confirm card with embedded `context`.
4. **No `blocking=true` on cards** — callbacks arrive as new notifications.
5. **Reconstruct task from `meta.value`** — do not rely on session memory for card callbacks.
6. **Acknowledge immediately** — reply with a brief confirmation before starting long tasks.
