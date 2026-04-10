---
name: feishu-im
description: Send, reply, read, search, and edit Feishu messages; send files and download attachments.
---

# Feishu Messaging

## Quick Reference

| Intent | Tool | Key params |
|--------|------|------------|
| Send a message | `feishu_im_send` | `receive_id`, `text` / `post_*` / `card` |
| Reply in a thread | `feishu_im_send` | `reply_to` (message_id), `text` / `post_*` / `card` |
| Read chat history | `feishu_im_read` | `container_id` (chat_id or message_id) |
| Search by keyword | `feishu_im_search` | `query` |
| Send a file or image | `feishu_im_send` | `receive_id`, `file_path` (images auto-detected by extension) |
| Download an attachment | `feishu_im_fetch_resource` | `message_id`, `file_key`, `type` |
| Edit a sent message | `feishu_im_patch` | `message_id`, `card` |

---

## Sending Messages

Three message formats — pick one per call:

- **text** — plain string. Use `text` param. **No markdown rendering** — asterisks, backticks, `**bold**`, bullet `•` symbols all appear as literal characters. For formatted output, use `post` or `interactive` instead.
- **post** — rich text with title, bold, links, @mentions. Use `post_title` + `post_rows`.
- **interactive** — card (tables, buttons, markdown blocks). Use `card` as JSON string. Markdown inside `markdown` elements is rendered.

`receive_id` auto-detects type from prefix: `ou_xxx` → open_id, `oc_xxx` → chat_id, `om_xxx` → reply (uses reply API), `email@x` → email, otherwise user_id. No `receive_id_type` parameter needed.

The response includes `message_id` and `chat_id` — save `chat_id` if you'll need it for the watch loop.

### Post format

`post_rows` is an array of rows; each row is an array of inline elements. Each row renders as a new line. `\n` within a `text` tag also produces a line break.

**Avoid curly/smart quotes** (`"`, `"`, `'`, `'`) inside `text` values — they break JSON parameter parsing. Use straight ASCII quotes `"` / `'` instead, or use Unicode escapes (`\u201c`, `\u201d`).

Supported `style` values: `"bold"`, `"italic"`, `"underline"`, `"strikethrough"`, `"inline_code"`. Multiple styles can be combined.

```json
{
  "post_title": "Update",
  "post_rows": [
    [{"tag": "text", "text": "This is "}, {"tag": "text", "text": "bold", "style": ["bold"]}],
    [{"tag": "text", "text": "code: "}, {"tag": "text", "text": "feishu_im_send()", "style": ["inline_code"]}],
    [{"tag": "a", "text": "Click here", "href": "https://example.com"}],
    [{"tag": "at", "user_id": "ou_xxx", "user_name": "Alice"}]
  ]
}
```

Bullet lists have no native tag — use `•` characters manually, one row per item.

### Interactive card format

Full markdown is supported via interactive card — see example below.

Use `card` (JSON string) for tables, markdown, or complex layouts. For markdown content including tables, use a `markdown` element — standard markdown table syntax is supported:

```json
{
  "schema": "2.0",
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "content": "| Tool | Purpose |\n|------|------|\n| feishu_im_send | Send messages |"
      }
    ]
  }
}
```

---

## Replying

Use `feishu_im_send` with `reply_to` (a message_id) instead of `receive_id`. All message types are supported — text, post, interactive, file. Lark threads the reply under the original message.

`feishu_im_reply` no longer exists as a separate tool.

---

## Reading

`feishu_im_read` returns messages from a chat (`container_id_type: "chat"`, `container_id` = chat_id) or a thread (`container_id_type: "thread"`, `container_id` = message_id). Default `page_size` is 20. Messages are always sorted newest-first.

---

## Sending Files and Images

Use `feishu_im_send` with a `file_path` parameter. Images (`.png`, `.jpg`, `.gif`, `.webp`) are sent as image messages; everything else as a file attachment. Use `file_name` to override the display name.

---

## Downloading Attachments

When a message contains a file or image, use `feishu_im_fetch_resource` to download it to a local temp file. You need:
- `message_id` — from the message that contains the attachment
- `file_key` — `img_xxx` for images, `file_xxx` for files
- `type` — `"image"` or `"file"`

Returns `saved_path` pointing to the downloaded file.

---

## Editing a Sent Message

`feishu_im_patch` replaces the content of an existing message in-place. Pass the original `message_id` and a `card` JSON string. Primarily used to update interactive cards (e.g. transitioning an auth card from pending → success).

For progress cards specifically, use `feishu_im_patch_progress` instead — it handles the step/percent logic for you.

> Interactive card tools (`feishu_im_send_confirm`, `feishu_im_send_form`, `feishu_im_send_progress`) are a separate module — see the **feishu-interactive-cards** skill for full usage and card structure.
