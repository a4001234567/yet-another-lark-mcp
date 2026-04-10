# lark-mcp-server — 身份与授权架构设计

## 问题

现有设计中，用户身份（owner open_id）和 OAuth 授权捆绑在一起：想知道「谁是主人」就必须先完成 OAuth，而 OAuth 需要打开浏览器完成设备流。这导致哪怕只是发条消息，也必须先授权。

## 目标

将「身份识别」和「权限授权」解耦，让三种使用场景互不干扰：

| 层级 | 需求 | 所用凭证 |
|---|---|---|
| Level 1 — 纯聊天 | 收发消息、回复、watch loop | App Token（机器人身份） |
| Level 2 — 授权操作 | 日历、任务、文档、人员 | User Token（OAuth） |
| Level 3 — 事件循环 | watch loop + 定时任务 | 依赖 Level 1，可选 Level 2 |

每一层依赖前面的层，但不依赖后面的层。纯聊天用户不需要做任何授权。

---

## 身份获取的解耦

### 现在

`feishu_auth_whoami` 用 User Token 调飞书接口返回 open_id，依赖 OAuth。

### 改后

Owner open_id 通过 App Token 调以下接口获取，不需要 OAuth：

```
GET /open-apis/application/v6/applications/{app_id}?lang=zh_cn
Authorization: Bearer <tenant_access_token>
```

返回字段：
- `data.app.owner.owner_id` — 当前应用 owner 的 open_id（优先使用，type=2 表示企业内成员）
- `data.app.creator_id` — 应用创建者的 open_id（fallback）

启动时用 App Token 拉一次，缓存 owner open_id，之后无需 OAuth 即可知道「主人是谁」。

---

## 分模块 OAuth

### 原则

不要一次性申请所有 scope，按模块申请最小权限。

| 模块 | OAuth Scope |
|---|---|
| `im` | `im:message` `im:message:send_as_bot` `im:resource` |
| `calendar` | `calendar:calendar` `calendar:calendar:readonly` |
| `task` | `task:task:write` `task:tasklist:write` |
| `docs` | `docx:document` `search:docs:read` |
| `people` | `contact:user.base:readonly` |
| `all` | 全部以上 scope |

### 手动授权

用户可以主动调用 `feishu_auth_init` 并指定模块：

```
feishu_auth_init(module="calendar")   # 只申请日历权限
feishu_auth_init(module="all")        # 申请全部权限
feishu_auth_init()                    # 默认 = all（向后兼容）
```

### 按需自动授权

Level 2 工具在被调用时，先检查 User Token 是否包含所需 scope：

1. 有有效 token 且 scope 足够 → 直接执行
2. 有 token 但 scope 不足 → 在飞书发一张授权卡片给 owner，提示需要追加哪些权限，owner 点击后触发 OAuth
3. 没有 token → 在飞书发授权卡片，owner 点击后触发 OAuth，OAuth 完成后自动重试原请求

授权卡片发往 owner 的飞书（open_id 已在启动时从 App Token 获取），不需要用户主动去 Claude Code 里调工具。

---

## 新的初始化流程

### 启动时（无需用户操作）

1. 用 App ID + Secret 获取 Tenant Access Token（App Token）
2. 调 `GET /open-apis/application/v6/applications/{app_id}` 拿 owner open_id
3. 缓存 owner open_id
4. 注册全部工具（Level 1 + Level 2），但 Level 2 工具内部检查 token
5. 启动 WebSocket 长连接

### 首次使用 Level 2 功能时

1. 工具检测到缺少 User Token 或对应 scope
2. 用 App Token 以机器人身份给 owner 发一张授权卡片（在飞书里）
3. Owner 在飞书点「授权」，跳转 OAuth 页面
4. 授权完成，token 存入 `~/.config/lark-mcp/tokens.json`
5. 工具自动重试

---

## 与现有设计的对比

| 维度 | 现在 | 改后 |
|---|---|---|
| 启动依赖 | 必须先跑 `feishu_auth_init` | 启动即可用，OAuth 按需触发 |
| owner 识别 | 依赖 User Token | App Token 即可（application 接口） |
| 授权粒度 | 一次性全部 scope | 按模块最小权限 |
| 授权入口 | Claude Code CLI 里手动调工具 | 飞书卡片，对话内完成 |
| 纯聊天场景 | 需要授权 | 不需要，App Token 即可 |

---

## 待决定

- **scope 检测方案**：飞书 User Token 本身不携带 scope 列表，需要本地记录「本次 OAuth 申请了哪些 scope」或每次调用时捕获 403 `insufficient_scope` 错误来触发补授权。建议：本地 token 文件增加 `granted_scopes` 字段，授权时写入，工具调用前比对。
- **多用户支持**：当前设计 owner = 唯一使用者。如果未来需要支持多用户各自授权，需要按 open_id 存储多个 token，工具根据消息来源（sender open_id）选用对应 token。暂不在本次实现。
