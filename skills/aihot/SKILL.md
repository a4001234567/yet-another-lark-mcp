---
name: aihot
description: AI HOT — fetch the AI daily digest or query AI news items by category/keyword/time window.
---

# aihot

AI HOT aggregates daily AI news. No OAuth required.

## Quick Reference

| Tool | Required | Optional | Returns |
|------|----------|----------|---------|
| `aihot_daily` | — | `date`, `format` | today's (or a date's) daily digest; `format="card"` gives a Feishu interactive card JSON |
| `aihot_dailies` | — | `take` | list of available digest dates |
| `aihot_items` | — | `mode`, `category`, `q`, `since`, `take` | news items; `mode=selected` curated, `all` everything |

> `category`: model · product · funding · industry · paper · tutorial · opinion

> `since`: ISO 8601 time-window start (e.g. `2026-05-07T00:00:00Z`)

---

## Rules

- 发日报给用户时用 `format="card"`，用飞书卡片发送。
- 完整卡片超长会被拒（HTTP 400），单元素也别放太长文本；含中文弯引号也会 400，注意去掉。
- 超长内容拆成多张卡片发送。
