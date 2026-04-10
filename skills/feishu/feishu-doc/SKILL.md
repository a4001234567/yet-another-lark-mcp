---
name: feishu-doc
description: Create, read, edit, search, and delete Lark documents and files.
---

# feishu_doc

Requires authentication — run `feishu_auth_init` if not yet authenticated.

## Quick Reference

| Tool | Required | Optional | Returns |
|------|----------|----------|---------|
| `feishu_doc_create` | — | `title`, `folder_token` | `document_id` |
| `feishu_doc_fetch` | `document_id` | — | `content` (plain text) + `blocks` list with `block_id`, `type`, `text` |
| `feishu_doc_append` | `document_id` | `text`, `type`, `bold`, `italic`, `inline_code`, `done`, `image_path`, `callout_emoji`, `callout_bg` | `ok` |
| `feishu_doc_patch` | `document_id`, `block_id`, `text` | `bold`, `italic`, `inline_code`, `done` | `ok` |
| `feishu_doc_delete` | `document_id`, `block_id` | — | `ok` |
| `feishu_doc_delete_file` | `file_token` | `type` (`docx`\|`file`\|`sheet`\|`bitable`, default `docx`) | `{ deleted: true }` |
| `feishu_doc_search` | `query` | `page_size` | list of `{ token, title, url }` |

> `type` values for append: `paragraph` · `heading1`–`heading6` · `bullet` · `ordered` · `code` · `quote` · `todo` · `callout` · `equation` · `image`

> `callout_bg` values: 1=LightRed · 2=LightOrange · 3=LightYellow · 4=LightGreen · 5=LightBlue · 6=LightPurple · 7=LightGray

> **Edit/delete workflow**: `feishu_doc_fetch` → get `block_id` from `blocks` list → `feishu_doc_patch` or `feishu_doc_delete`

---

## Sharing a Doc

After creating, send the URL as a plain text message — Feishu auto-expands it into a doc preview card:

```
https://feishu.cn/docx/{document_id}
```

The tenant prefix (`tsinghuasigs.feishu.cn` etc.) is not required — the short URL works.

---

## Scenarios

### Read a doc
Get `document_id` from the URL (last path segment) or `feishu_doc_search`, then call `feishu_doc_fetch`.

### Delete an entire file
Use `feishu_doc_delete_file` with the doc's `document_id` as `file_token` (and `type: "docx"` for docs). This permanently deletes the file from Drive — confirm with the user before proceeding.
