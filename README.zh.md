# Yet Another Lark MCP

个人用途的飞书/Lark MCP 服务器，支持日历、任务、消息、文档和人员搜索。

以 stdio 进程运行，接入 Claude Code、Claude Desktop、Cursor、Zed 或任意兼容 MCP 的客户端。

→ **[安装指南](INSTALL.md)**

---

## 和其他方案有什么不同

飞书开放平台有数百个原始 API 接口，大多数现有工具只是对这些接口一对一封装。本项目的做法不同：**为单人使用场景精简和重新设计接口**，并随附技能文件，让 AI 模型真正懂得如何使用——而不只是"有工具"。

### 三种使用层级

按需选择，逐步扩展：

| 层级 | 功能 | 所需认证 |
|---|---|---|
| **仅发送** | 发送消息、搜索人员。将 AI 用作飞书通知机器人。 | 仅需 App Token（无需 OAuth） |
| **双向交互** | 完整监听循环：接收消息、处理卡片 callback、运行 cron 定时任务。AI 成为可在飞书触达的个人助手。 | 仅需 App Token |
| **完整功能** | 以上全部 + 日历、任务、文档读写。 | 需要 OAuth（设备流，引导完成） |

每一层级都是前一层的超集——从小开始，按需添加 OAuth。

### 亮点

- **跑在任意 MCP 客户端上。** stdio 传输，兼容 Claude Code、Claude Desktop、Cursor、Zed 等。
- **监听循环。** `feishu_im_watch` 一次调用即可等待消息、卡片 callback 和定时任务。无需 webhook，无需轮询，无需守护进程。
- **多种交互卡片。** 确认/取消对话框、多字段输入表单（支持密码/隐藏字段）、实时更新的进度追踪卡片。AI 可以在飞书内向用户提问或请求确认。
- **技能文件随附。** 每个模块配套 SKILL.md，以 MCP Prompt 形式暴露，按需注入上下文。
- **按需 OAuth。** 需要用户授权时，服务器自动向账号所有者发送授权卡片，无需手动操作 token。

**已知限制：** 不支持飞书多维表格（Bitable）编辑。

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
| `feishu_im_send` | 发送文本、富文本、交互卡片或文件/图片；接受 open_id、chat_id 或 message_id（回复） |
| `feishu_im_read` | 读取群聊中的最新消息 |
| `feishu_im_search` | 按关键词搜索消息 |
| `feishu_im_fetch_resource` | 将消息中的文件或图片下载到本地路径 |
| `feishu_im_patch` | 编辑已发送的消息 |
| `feishu_im_watch` | 阻塞等待新消息、卡片 callback 或定时任务触发 |

### 交互卡片

| 工具 | 说明 |
|---|---|
| `feishu_im_send_confirm` | 发送确认/取消对话卡片；可选阻塞等待点击 |
| `feishu_im_send_form` | 发送表单卡片（支持密码/隐藏字段）；可选阻塞等待提交 |
| `feishu_im_send_progress` | 发送多步骤进度追踪卡片 |
| `feishu_im_patch_progress` | 推进进度卡片到下一步 |

### 定时任务

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
| `feishu_doc_delete_file` | 从云盘永久删除整个文档 |

---

## 技能（MCP Prompts）

服务器将 SKILL.md 文件以 MCP Prompt 形式暴露，按需注入上下文。

| Prompt | 说明 |
|---|---|
| `lark-mcp-guide` | 概览：核心概念、标识符、认证、所有工具模块 |
| `feishu-calendar` | 日历：创建、列出、修改、删除 |
| `feishu-task` | 任务：创建、列出、修改、删除，以及任务清单 |
| `feishu-people` | 用户搜索和 open_id 解析 |
| `feishu-im` | 消息：发送、回复、读取、搜索、文件、编辑 |
| `feishu-interactive-cards` | 确认对话框、表单、进度追踪卡片 |
| `feishu-watch-loop` | 自主监听循环规则与模式 |
| `feishu-doc` | 文档：创建、获取、追加、编辑、删除、搜索 |

---

## 已知限制

- `feishu_calendar_list` 时间范围上限为 40 天（受 Lark `instance_view` API 限制）
- `feishu_doc_search` 需要用户认证（纯 App Token 不可用）
- `feishu_doc_fetch` 纯文本输出不包含行内公式内容

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
