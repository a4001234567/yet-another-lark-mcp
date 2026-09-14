---
name: feishu-comment
description: Comment on Lark documents — list comments, reply, resolve, add emoji reactions. Uses tenant token only, no OAuth.
---

# feishu_comment

Comment tools operate on document comments. All use `tenant_access_token` — no user OAuth required.

## Quick Reference

| Tool | Required | Optional | Returns |
|------|----------|----------|---------|
| `feishu_doc_comment_list` | `file_token` | `file_type`, `is_whole`, `is_solved`, `page_token`, `page_size`, `need_reaction` | comment list with `comment_id` |
| `feishu_doc_comment_get_replies` | `file_token`, `comment_id` | `page_token`, `page_size` | replies with `reply_id` |
| `feishu_doc_comment_add_whole` | `file_token`, `text` | `at_open_id` | `comment_id` |
| `feishu_doc_comment_add_reply` | `file_token`, `comment_id`, `text` | `at_open_id` | `reply_id` |
| `feishu_doc_comment_update_reply` | `file_token`, `comment_id`, `reply_id`, `text` | — | `ok` |
| `feishu_doc_comment_delete_reply` | `file_token`, `comment_id`, `reply_id` | — | `ok` |
| `feishu_doc_comment_resolve` | `file_token`, `comment_id`, `resolved` | — | `ok` |
| `feishu_doc_comment_reaction` | `file_token`, `reply_id`, `reaction_type`, `action` | — | `ok` |

> `file_type`: `docx` (default) · `doc` · `sheet` · `file` · `slides`

> `reaction_type` is an emoji name, e.g. `HEART`, `THUMBSUP`, `WOW`, `LAUGH`.

---

## Rules

- Only reply to comments that @mention 白咲. Ignore the rest.
- `is_whole: true` on `comment_list` returns whole-document comments; otherwise block-level comments.
- Reactions are added/removed on a **reply** (`reply_id`), not on a comment itself.
