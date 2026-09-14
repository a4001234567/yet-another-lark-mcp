---
name: feishu-wiki
description: Wiki knowledge-space operations — list spaces and nodes, create/copy/move nodes, manage members. Mix of tenant and user token.
---

# feishu_wiki

Wiki nodes live in knowledge spaces. The default space is **白咲专属** (`space_id: 7631752608788564950`).

## Token split

- **Tenant token** (app-level, no OAuth): `get_space_tenant`, `list_nodes_tenant`, `get_node_tenant`, `create_node_tenant`, `copy_node_tenant`, `move_node_tenant`, `update_title_tenant`, `list_members_tenant`
- **User token** (OAuth required): `list_spaces`, `get_space_user`, `create_space`, `list_members_user`

## Quick Reference

| Tool | Required | Optional | Notes |
|------|----------|----------|-------|
| `feishu_wiki_get_node_tenant` | `token` | `obj_type` | node or doc token → node info |
| `feishu_wiki_list_nodes_tenant` | `space_id` | `parent_node_token`, `page_token`, `page_size` | children of a space/parent |
| `feishu_wiki_create_node_tenant` | `space_id`, `obj_type`, `node_type` | `title`, `parent_node_token` | obj_type: docx/sheet/mindnote/bitable/file/slides |
| `feishu_wiki_copy_node_tenant` | `space_id`, `node_token` | `target_space_id`, `target_parent_token`, `title` | copy to a new location |
| `feishu_wiki_move_node_tenant` | `space_id`, `node_token` | `target_space_id`, `target_parent_token` | children move together |
| `feishu_wiki_update_title_tenant` | `space_id`, `node_token`, `title` | — | doc/docx/shortcut only |
| `feishu_wiki_create_space` | `name` | `description`, `open_sharing` | user token; then add the bot as admin |
| `feishu_wiki_add_member` | `space_id`, `member_id` | `member_type`, `member_role`, `need_notification` | authorized user must be space admin |
| `feishu_wiki_list_members_tenant` | `space_id` | `page_token`, `page_size` | tenant token |

---

## Rules

- 建文档默认用 wiki（`feishu_wiki_create_node_tenant`），不是 `feishu_doc_create`。
- 母节点本身也是文档，新建子节点前先 fetch 母节点文档。
- 改已有文档前先 fetch，拿到 `block_id` 再 patch。
- After `create_space`, immediately add the bot as admin so tenant-token tools work on the new space.
