---
name: feishu-people
description: |
  Search for Lark users by name or keyword to get their open_id.

  Use this skill when:
  (1) User mentions a person by name and you need their open_id
  (2) Preparing to assign a task to someone by name
  (3) User mentions "find", "who is", "look up" a colleague
---

# feishu_people

## Quick index

| Intent | Action | Required |
|--------|--------|---------|
| Find someone's open_id | search | query |

## Notes
- Uses tenant token — no user OAuth required
- Results sorted by relevance
- The returned `open_id` (ou_xxx) is what `feishu_task create` needs for `assignee_id`
- If no results, try a shorter version of the name or their English name

## Example

```json
{ "action": "search", "query": "Alice Zhang" }
```

Returns `[{ "open_id": "ou_xxx", "name": "Alice Zhang", "department": "Engineering" }]`
