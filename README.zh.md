# lark-mcp-server

个人用途的飞书/Lark MCP 服务器，支持日历、任务、消息、文档和人员搜索。

以 stdio 进程运行，任何兼容 MCP 的客户端（Claude Desktop、Cursor、Zed 等）均可接入。

---

## 环境要求

- Node.js 18+
- 飞书自建应用 — 在 **https://open.feishu.cn/page/openclaw** 创建

---

## 目录结构

压缩包包含两个兄弟目录，请保持并列关系：

```
lark-workspace/
├── lark-mcp-server/        ← MCP 服务器（本仓库）
└── lark-skills/            ← 技能文件（运行时作为 MCP prompts 加载）
    └── feishu/feishu-interactive-cards/cards-package/  ← 卡片文档
```

`lark-mcp-server` 在运行时通过 `../../lark-skills` 路径解析技能文件，需保持并列目录结构。

---

## 安装

```bash
cd lark-mcp-server
npm install
```

---

## Claude Code 配置

```bash
claude mcp add lark -- npx tsx /绝对路径/lark-mcp-server/src/index.ts
```

在 `.claude/settings.json` 中添加环境变量：

```json
{
  "mcpServers": {
    "lark": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/lark-mcp-server/src/index.ts"],
      "env": {
        "LARK_APP_ID": "cli_xxx",
        "LARK_APP_SECRET": "your_secret",
        "LARK_TIMEZONE": "Asia/Shanghai"
      }
    }
  }
}
```

**加载技能**（将使用指引注入上下文）：

```
/mcp__lark__lark-mcp-guide
```

可用技能：`lark-mcp-guide` · `feishu-calendar` · `feishu-task` · `feishu-people` · `feishu-im` · `feishu-interactive-cards` · `feishu-watch-loop` · `feishu-doc`

---

## Claude Desktop 配置

在 `~/Library/Application Support/Claude/claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "lark": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/lark-mcp-server/src/index.ts"],
      "env": {
        "LARK_APP_ID": "cli_xxx",
        "LARK_APP_SECRET": "your_secret",
        "LARK_TIMEZONE": "Asia/Shanghai"
      }
    }
  }
}
```

**环境变量说明：**

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `LARK_APP_ID` | 是 | — | 飞书开发者控制台中的 App ID（`cli_xxx`） |
| `LARK_APP_SECRET` | 是 | — | App Secret |
| `LARK_TIMEZONE` | 否 | `Asia/Shanghai` | 日期解析和展示的时区 |

---

## 首次认证

首次使用时调用 `feishu_auth_init`，它会返回 `verification_url` 和 `user_code`，然后自动轮询直到你在浏览器完成授权（最多 10 分钟）。无需第二次调用。

Token 保存在 `~/.config/lark-mcp/tokens.json`，过期前自动刷新。

---

## 工具列表

### 认证

| 工具 | 说明 |
|---|---|
| `feishu_auth_status` | 检查认证状态和 Token 有效性 |
| `feishu_auth_init` | 启动 OAuth 授权 — 阻塞直到完成（最多 10 分钟）。已知 open_id 时发送授权卡片，否则返回授权 URL。 |
| `feishu_auth_whoami` | 返回当前用户的 open_id 和姓名 |

### 人员

| 工具 | 说明 |
|---|---|
| `feishu_people_search` | 按姓名搜索用户 → 返回 open_id |

### 日历

| 工具 | 说明 |
|---|---|
| `feishu_calendar_create` | 创建日程（支持提醒、地点、RRule 循环） |
| `feishu_calendar_list` | 列出或搜索日程；默认范围为本周一至下周日 |
| `feishu_calendar_patch` | 更新日程字段；自动处理循环实例物化 |
| `feishu_calendar_delete` | 删除日程；自动处理循环实例物化 |

### 任务

| 工具 | 说明 |
|---|---|
| `feishu_task_create` | 创建任务（自动分配给自己） |
| `feishu_task_list` | 列出我的任务，或指定任务清单中的任务 |
| `feishu_task_patch` | 更新任务：标题、截止日期、完成状态、负责人 |
| `feishu_task_delete` | 删除任务 |
| `feishu_task_list_lists` | 列出所有任务清单 |
| `feishu_task_create_list` | 创建任务清单 |
| `feishu_task_patch_list` | 重命名任务清单 |
| `feishu_task_delete_list` | 删除任务清单 |

### 消息（IM）

| 工具 | 说明 |
|---|---|
| `feishu_im_send` | 向用户或群组发送文本、富文本、交互卡片或文件/图片；使用 `reply_to`（消息ID）可线程化回复 |
| `feishu_im_read` | 读取群聊中的最新消息 |
| `feishu_im_search` | 按关键词搜索消息 |
| `feishu_im_fetch_resource` | 将消息中的文件或图片下载到本地临时路径 |
| `feishu_im_patch` | 编辑已发送的消息 |
| `feishu_im_watch` | 阻塞等待新消息、卡片 callback 或定时任务触发，三者合一返回 |

### 交互卡片

以下工具发送的卡片会在用户交互后自动更新。

| 工具 | 说明 |
|---|---|
| `feishu_im_send_confirm` | 发送确认/取消对话卡片；`blocking=true` 可阻塞等待点击 |
| `feishu_im_send_form` | 发送表单卡片（支持密码/隐藏字段）；`blocking=true` 可阻塞等待提交 |
| `feishu_im_send_progress` | 发送多步骤进度追踪卡片 |
| `feishu_im_patch_progress` | 推进进度卡片到下一步 |

### 定时任务（在监听循环中使用）

| 工具 | 说明 |
|---|---|
| `feishu_schedule_create` | 创建一次性或循环（cron）定时提醒，在监听循环中触发 |
| `feishu_schedule_list` | 列出待触发的定时任务 |
| `feishu_schedule_delete` | 删除定时任务 |

### 文档

| 工具 | 说明 |
|---|---|
| `feishu_doc_search` | 按关键词搜索文档和 Wiki 页面 |
| `feishu_doc_fetch` | 获取文档内容（纯文本 + 带 ID 的块列表） |
| `feishu_doc_create` | 创建新文档 |
| `feishu_doc_append` | 向文档追加块（段落、标题、列表、代码、标注、图片等） |
| `feishu_doc_patch` | 编辑或替换已有块 |
| `feishu_doc_delete` | 删除块 |
| `feishu_doc_delete_file` | 从云盘永久删除整个文档（或文件/表格/多维表格） |

---

## 技能（Skills）

服务器将 SKILL.md 文件以 MCP Prompt 形式暴露。通过"使用 feishu-calendar 技能"或客户端的 Prompt 选择器注入上下文。

| Prompt | 说明 |
|---|---|
| `lark-mcp-guide` | 概览：核心概念、标识符、认证、所有工具模块 |
| `feishu-calendar` | 日历操作：创建、列出、修改、删除 |
| `feishu-task` | 任务管理：创建、列出、修改、删除，以及任务清单 |
| `feishu-people` | 用户搜索和 open_id 解析 |
| `feishu-im` | 消息：发送（含线程回复）、读取、搜索、文件、附件、编辑 |
| `feishu-interactive-cards` | 确认对话、表单、进度追踪卡片 |
| `feishu-watch-loop` | 自主监听循环规则：循环结构、飞书回复、定时任务 |
| `feishu-doc` | 文档：创建、获取、追加、编辑、删除、搜索 |

---

## OAuth 权限范围

在飞书应用的**安全设置 → OAuth 权限范围**中配置以下权限，并启用**用户 OAuth**（设备流）。

**日历**
```
calendar:calendar:read
calendar:calendar.event:create  calendar:calendar.event:delete
calendar:calendar.event:read    calendar:calendar.event:reply
calendar:calendar.event:update  calendar:calendar.free_busy:read
```

**任务**
```
task:task:read  task:task:write  task:task:writeonly
task:tasklist:read  task:tasklist:write
```

**文档**
```
docx:document:readonly  docx:document:create  docx:document:write_only
search:docs:read
space:document:delete  space:document:move  space:document:retrieve
drive:drive.metadata:readonly  drive:file:download  drive:file:upload
docs:document:export  docs:document.media:download  docs:document.media:upload  docs:document:copy
wiki:node:copy  wiki:node:create  wiki:node:move  wiki:node:read  wiki:node:retrieve
wiki:space:read  wiki:space:retrieve  wiki:space:write_only
```

**始终需要**
```
offline_access
```

消息和人员搜索使用 App Token（TAT），无需 OAuth 权限。

---

## Token 存储

`~/.config/lark-mcp/tokens.json` — 明文 JSON，在过期前 5 分钟自动刷新。

---

## 已知限制

- `feishu_calendar_list` 时间范围上限为 40 天（受 Lark `instance_view` API 限制）
- `feishu_doc_search` 需要用户认证（纯 App Token 不可用）
- `feishu_doc_fetch` 纯文本输出不包含行内公式内容 — 公式在 `content` 字符串中显示为空格（公式本身以 `equation` 元素正确存储，只是文本提取未处理）
