---
name: feishu-calendar
description: Personal calendar — create, list/search, modify, and delete events.
---

# feishu_calendar

Requires authentication — run `feishu_auth_init` if not yet authenticated.

## Pre-execution checklist

- Time format: `"YYYY-MM-DD HH:MM"` or ISO 8601; all-day events: `"YYYY-MM-DD"` only
- `list` defaults to **this week Mon → next week Sun** (~14 days); max range is **40 days**
- `patch` and `delete` require `event_id` — always `list` first to obtain it
- `event_id` ending `_0` = whole recurring series; `_<timestamp>` = one specific occurrence

---

## Quick Reference

| Action | Required | Optional |
|--------|----------|----------|
| `create` | `summary`, `start_time`, `end_time` | `description`, `location`, `latitude`, `longitude`, `reminder`, `recurrence` |
| `list` | — | `start_time`, `end_time`, `query`, `page_size` |
| `patch` | `event_id` | `summary`, `start_time`, `end_time`, `description`, `location`, `latitude`, `longitude`, `recurrence` |
| `delete` | `event_id` | `notify` (default false — sends cancellation to attendees if true) |

`list` returns full detail per occurrence. Recurring events are expanded — each occurrence has its own `event_id`.

---

## Scenarios

### Create a one-off event
```json
{
  "action": "create",
  "summary": "Team standup",
  "start_time": "2026-03-20 09:30",
  "end_time": "2026-03-20 10:00",
  "location": "Conference Room A",
  "reminder": 10
}
```

### Create a recurring event
```json
{
  "action": "create",
  "summary": "Weekly standup",
  "start_time": "2026-03-20 09:30",
  "end_time": "2026-03-20 10:00",
  "recurrence": "FREQ=WEEKLY;BYDAY=MO;COUNT=8"
}
```

### View / search schedule
```json
{ "action": "list", "query": "standup", "start_time": "2026-03-17", "end_time": "2026-03-23" }
```

Keyword search cross-references against a time range. Omitting times applies the default two-week window.

### Modify one occurrence vs the whole series
```json
{ "action": "patch", "event_id": "abc123_1742169600", "start_time": "2026-03-20 10:00", "end_time": "2026-03-20 10:30" }
```
```json
{ "action": "patch", "event_id": "abc123_0", "summary": "Weekly sync", "recurrence": "FREQ=WEEKLY;BYDAY=TU;COUNT=8" }
```
