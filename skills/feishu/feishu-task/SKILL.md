---
name: feishu-task
description: Personal task management — create, list, update, delete tasks and manage tasklists.
---

# feishu_task

Requires authentication — run `feishu_auth_init` if not yet authenticated.

## Pre-execution checklist

- `task_guid` required for patch/delete — get from `create` or `list`
- `tasklist_guid` required for patch_list/delete_list — get from `list_lists` or `create_list`
- Time: `"YYYY-MM-DD"` or `"YYYY-MM-DD HH:MM"`; use `"none"` to clear a date
- `patch completed: true` = done, `false` = reopen
- On `create`: caller is auto-assigned so the task appears in `list` immediately. If `assignee_id` is given, the assignee gets the task and caller becomes a follower.

---

## Quick Reference

| Action | Required | Optional |
|--------|----------|----------|
| `create` | `summary` | `description`, `due`, `start`, `assignee_id`, `tasklist_guid` |
| `list` | — | `completed`, `query`, `tasklist_guid`, `page_size` |
| `patch` | `task_guid` | `summary`, `description`, `due`, `start`, `completed` |
| `delete` | `task_guid` | — |
| `list_lists` | — | `page_size` |
| `create_list` | `name` | — |
| `patch_list` | `tasklist_guid`, `name` | — |
| `delete_list` | `tasklist_guid` | — |

`list` without `tasklist_guid` returns "My Tasks" (tasks where caller is a member). `completed` omitted = all tasks. `query` is client-side keyword filter.

---

## Scenarios

### Create and assign a task
```json
{ "action": "create", "summary": "Review PR", "assignee_id": "ou_xxx", "due": "2026-03-31 18:00" }
```
Use `feishu_people_search` to resolve a name to `open_id`.

### Update / mark done / reopen
```json
{ "action": "patch", "task_guid": "xxx", "completed": true }
{ "action": "patch", "task_guid": "xxx", "completed": false }
{ "action": "patch", "task_guid": "xxx", "due": "none" }
```

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Task is already completed" | Completing an already-done task | Handled gracefully — no action needed |
| not_found | Task/tasklist deleted or wrong GUID | Re-run list to get current GUIDs |
| No results on list | Missing authentication | Run `feishu_auth_init` to re-authenticate |
