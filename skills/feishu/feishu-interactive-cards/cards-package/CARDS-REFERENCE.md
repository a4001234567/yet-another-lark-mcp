# Feishu Interactive Cards — Reference Guide

This package contains card builders and lifecycle infrastructure for Lark/Feishu interactive cards (Card Schema 2.0), extracted from the `lark-mcp-server` project for reuse.

---

## Contents

```
cards-package/
├── CARDS-REFERENCE.md          ← this file
└── src/
    ├── cards/
    │   ├── confirm.ts          ← simple confirm/cancel card
    │   ├── progress.ts         ← multi-step progress card
    │   ├── auth.ts             ← OAuth flow card
    │   ├── info.ts             ← display-only info card
    │   ├── identity-form.ts    ← preset identity form (name, ID, phone)
    │   ├── credential-form.ts  ← preset credential form (username, password)
    │   └── index.ts            ← re-exports all builders
    └── card-registry.ts        ← interactive lifecycle (confirm + dynamic form)
```

---

## Card Schema 2.0 Basics

Every card is a plain JSON object with this top-level structure:

```json
{
  "schema": "2.0",
  "config": { "update_multi": true },   // optional: allow the card to be patched later
  "header": {
    "template": "blue",                  // color: blue | green | orange | red | grey | wathet | indigo | purple | violet
    "title":    { "tag": "plain_text", "content": "Card title" },
    "subtitle": { "tag": "plain_text", "content": "Optional subtitle" }
  },
  "body": {
    "elements": [ /* ... elements ... */ ]
  }
}
```

### Common body elements

| Element tag | Purpose |
|---|---|
| `markdown` | Rich text block. Supports bold `**text**`, `[links](url)`, `<font color="grey">colored</font>` |
| `hr` | Horizontal divider line |
| `img` | Image (requires uploaded `img_key`) |
| `div` | Structured text with `text_size`, `text_color`, `text_align` |
| `person` | Inline user avatar + name display |
| `person_list` | List of user avatars + names |
| `button` | Clickable button (see Button section below) |
| `column_set` | Horizontal layout container |
| `column` | Column within a `column_set` |
| `collapsible_panel` | Expandable panel with header + body |
| `interactive_container` | Clickable container that fires a callback behavior |
| `form` | Form container for input elements |
| `input` | Text input field (inside a `form`) |
| `select_static` | Single-choice dropdown with fixed options |
| `multi_select_static` | Multi-choice dropdown with fixed options |
| `select_person` | Person picker (single) |
| `multi_select_person` | Person picker (multi) |
| `select_img` | Image selection (single or multi) |
| `checker` | Checkbox with optional strikethrough on check |
| `overflow` | Three-dot overflow menu with action options |
| `date_picker` | Date picker |
| `picker_time` | Time picker |
| `picker_datetime` | Date + time picker |
| `chart` | Chart element (progress bar via `linearProgress`, others via VChart spec) |
| `table` | Native data table with column types, sorting, pagination |

### Minimal markdown card

The simplest way to send rich markdown content — no header, just a `markdown` element:

```typescript
const card = {
  schema: '2.0',
  body: {
    elements: [
      { tag: 'markdown', content: 'Your **markdown** here\n\n| col | col |\n|---|---|\n| a | b |' },
    ],
  },
};
await sendCard(openId, card);
```

This is the recommended alternative to `post` messages when you need colors, pipe tables, or more flexibility.

---

### Sending a card

Serialize the card object to a JSON string and send via the Lark IM API:

```typescript
const card = buildConfirmCard({ title: '确认删除', body: '此操作不可撤销' });

await larkClient.im.message.create({
  params: { receive_id_type: 'open_id' },
  data: {
    receive_id: 'ou_xxx',
    msg_type:   'interactive',
    content:    JSON.stringify(card),
  },
});
```

### Patching (updating) a card in-place

Cards with `config.update_multi = true` can be patched after sending:

```typescript
await larkClient.im.message.patch({
  path:  { message_id: 'om_xxx' },
  data:  { content: JSON.stringify(updatedCard) },
});
```

Patching replaces the entire card body visible to the user — useful for progress updates and state transitions (active → responded → expired).

---

## Buttons

Buttons have two distinct interaction models:

### 1. Callback button (triggers a server-side callback)

```json
{
  "tag": "button",
  "type": "primary",
  "text": { "tag": "plain_text", "content": "确认" },
  "behaviors": [{
    "type":  "callback",
    "value": { "action": "confirm", "extra": "any data you want back" }
  }]
}
```

When clicked, Lark sends a `card.action.trigger` event to your WebSocket connection. The `value` object is returned verbatim in the callback payload. Use it to embed task context.

**Button types:** `primary` (blue), `danger` (red), `default` (grey), `laser` (highlighted state after click)

### 2. URL button (opens a browser)

```json
{
  "tag": "button",
  "type": "primary",
  "text": { "tag": "plain_text", "content": "前往授权" },
  "behaviors": [{ "type": "open_url", "default_url": "https://..." }]
}
```

### 3. Form submit button (submits the enclosing form)

```json
{
  "tag":             "button",
  "type":            "primary",
  "form_action_type": "submit",
  "text":            { "tag": "plain_text", "content": "提交" }
}
```

### Disabling a button

```json
{
  "tag":          "button",
  "disabled":     true,
  "disabled_tips": { "tag": "plain_text", "content": "交互已失效" },
  "behaviors":    []
}
```

---

## Card Builders

### 1. Confirm Card — `cards/confirm.ts`

Two-button card for yes/no decisions. Minimal stateless builder (no lifecycle management).

```typescript
import { buildConfirmCard, buildConfirmRespondedCard } from './cards/confirm.js';

// Active state — send this first
const card = buildConfirmCard({
  title:         '删除事件',
  body:          '确定要删除「周五团队同步」吗？此操作不可撤销。',
  template:      'orange',       // default: 'orange'
  confirmLabel:  '删除',         // default: '确认'
  cancelLabel:   '保留',         // default: '取消'
  confirmValue:  'confirm',      // default: 'confirm' — returned in callback
  cancelValue:   'cancel',       // default: 'cancel'
});

// Responded state — patch the card with this after user clicks
const responded = buildConfirmRespondedCard(
  { title: '删除事件', template: 'grey' },
  '已保留',   // label of the chosen button
);
```

**Callback payload** (from `card.action.trigger`):
```json
{ "action": "confirm" }   // or "cancel"
```

---

### 2. Progress Card — `cards/progress.ts`

Multi-step task progress with collapsible panels and a linear progress bar.

```typescript
import { buildProgressCard, ProgressStep } from './cards/progress.js';

const steps: ProgressStep[] = [
  { label: '获取数据',    detail: '调用日历 API...' },
  { label: '处理结果',    detail: '过滤 + 排序事件...' },
  { label: '生成报告' },
];

// Send initially at step 0
const card = buildProgressCard('任务进度', steps, 0);
// → blue header "第 1/3 步进行中", first panel expanded

// Patch to step 1 (second step active)
const card2 = buildProgressCard('任务进度', steps, 1);

// Patch to completed (currentStep === steps.length)
const done = buildProgressCard('任务进度', steps, steps.length);
// → green header "已完成", progress bar at 100%
```

**States:**
- Done steps: grey background, collapsed
- Active step: blue background, white bold text, expanded
- Pending steps: no background, normal text, collapsed
- Completed: green header, all steps shown as done

**Workflow:**
```typescript
// 1. Send
const res = await client.im.message.create({ ... content: JSON.stringify(buildProgressCard(title, steps, 0)) });
const msgId = res.data.message_id;

// 2. Do work, patch on each step
for (let i = 1; i <= steps.length; i++) {
  // ... do step work ...
  await client.im.message.patch({
    path: { message_id: msgId },
    data: { content: JSON.stringify(buildProgressCard(title, steps, i)) },
  });
}
```

---

### 3. Auth Card — `cards/auth.ts`

OAuth flow card with URL button. Three terminal states.

```typescript
import { buildAuthCard, buildAuthSuccessCard, buildAuthFailCard, buildAuthDeniedCard } from './cards/auth.js';

// Step 1: Send auth card with the OAuth URL
const card = buildAuthCard(
  'https://open.feishu.cn/open-apis/authen/v1/authorize?...',
  '需要授权才能访问您的日历。请点击下方按钮完成授权。',  // optional description
);

// Step 2: Poll token; then patch to success or fail
await client.im.message.patch({ path: { message_id: msgId }, data: { content: JSON.stringify(buildAuthSuccessCard()) } });
// or
await client.im.message.patch({ path: { message_id: msgId }, data: { content: JSON.stringify(buildAuthFailCard()) } });
// or (if user cancelled)
await client.im.message.patch({ path: { message_id: msgId }, data: { content: JSON.stringify(buildAuthDeniedCard()) } });
```

---

### 4. Info Card — `cards/info.ts`

General-purpose display card. No interactive elements.

```typescript
import { buildInfoCard } from './cards/info.js';

const card = buildInfoCard({
  title:    '深圳天气',
  subtitle: '2026-03-23 08:00',
  template: 'blue',
  sections: [
    { type: 'kv',       key: '温度',  value: '23°C（体感 25°C）' },
    { type: 'kv',       key: '天气',  value: '多云转晴' },
    { type: 'divider' },
    { type: 'markdown', content: '建议穿**轻薄长袖**，无需外套。' },
  ],
});
```

**Section types:**
- `{ type: 'markdown', content }` — full-width markdown block
- `{ type: 'kv', key, value }` — two-column row: bold key on left, value on right
- `{ type: 'divider' }` — horizontal rule

---

### 5. Identity Form — `cards/identity-form.ts`

Preset form: name + ID number + phone. Demonstrates the form + submit button pattern.

```typescript
import { buildIdentityFormCard, buildIdentitySubmittedCard } from './cards/identity-form.js';

// Active state
const card = buildIdentityFormCard();

// Submitted state (patch after receiving form_submit callback)
const submitted = buildIdentitySubmittedCard('张三');  // pass the submitted name
```

**How form submit callbacks work:**

When the user clicks the submit button (type: `form_action_type: "submit"`), Lark sends a `card.action.trigger` event containing all filled input values as a flat object. The key in the result object is the `name` attribute of each `input` element:

```json
{
  "action": { "form_value": { "name_input": "张三", "id_number_input": "110101...", "phone_input": "138..." } }
}
```

---

### 6. Credential Form — `cards/credential-form.ts`

Preset form: username + password (`input_type: "password"` masks the input).

```typescript
import { buildCredentialFormCard, buildCredentialSubmittedCard } from './cards/credential-form.js';

const card = buildCredentialFormCard();
const submitted = buildCredentialSubmittedCard('student_id_123');
```

**Password input:** Add `input_type: "password"` to any `input` element to mask the field. The submitted value is still received in plaintext on the server side — Lark only masks the display.

---

## Interactive Lifecycle — `card-registry.ts`

The registry manages the full lifecycle of interactive cards: active → responded/submitted → expired.

This is the production-grade version of the confirm and form builders, used by the MCP tool layer. It supports:
- **Blocking mode**: the server-side tool blocks until the user responds
- **Non-blocking mode**: the tool returns immediately; the callback arrives as an event
- **Automatic expiry**: cards are registered with a TTL; expired cards are patched to a disabled state
- **Inline callback response**: Lark expects a response within 3 seconds of `card.action.trigger`

### Confirm lifecycle

```typescript
import {
  buildConfirmActiveCard, buildConfirmRespondedCard, buildConfirmExpiredCard,
  buildCallbackResponse,
  registerCard, lookupCard, removeCard, drainExpiredCards,
} from './card-registry.js';

// 1. Send the card
const entryBase = {
  card_type:    'confirm' as const,
  title:        '删除事件',
  body:         '确定要删除「周五团队同步」吗？',
  confirm_label: '删除',
  cancel_label:  '取消',
};
const card = buildConfirmActiveCard(entryBase);
const res  = await sendCard(card);          // your send wrapper
const msgId = res.data.message_id;

// 2. Register in the registry (non-blocking)
const expiry_at = Date.now() + 3600_000;   // 1 hour
registerCard(msgId, { ...entryBase, expiry_at });

// 3. On card.action.trigger event (WebSocket):
const entry = lookupCard(msgId);
if (entry) {
  const action = payload.action.value.action;  // "confirm" | "cancel"

  // Patch the card to responded state (also handled inline by buildCallbackResponse)
  await patchCard(msgId, buildConfirmRespondedCard(entry, action));

  removeCard(msgId);
  // → proceed with action
}

// 4. On each watch tick, drain expired cards:
const expired = drainExpiredCards();
for (const { message_id, entry } of expired) {
  await patchCard(message_id, buildConfirmExpiredCard(entry));
}
```

### Form lifecycle

```typescript
import {
  buildFormActiveCard, buildFormSubmittedCard, buildFormExpiredCard,
  registerCard, lookupCard, removeCard,
  FormField,
} from './card-registry.js';

const fields: FormField[] = [
  { name: 'title',  label: '任务标题', placeholder: '请输入', required: true },
  { name: 'due',    label: '截止时间', placeholder: 'YYYY-MM-DD' },
  { name: 'secret', label: '密钥',    hidden: true },
];

const entryBase = {
  card_type:    'form' as const,
  title:        '新建任务',
  body:         '请填写任务信息',
  confirm_label: '', cancel_label: '',   // unused for form type
  fields,
  submit_label: '创建',
};

const card = buildFormActiveCard(entryBase);
// ... send, registerCard, on callback: buildFormSubmittedCard(entry, form_value) ...
```

**form_value** from the callback event:
```json
{ "title": "写报告", "due": "2026-03-25", "secret": "s3cr3t" }
```

### CardEntry type reference

```typescript
type CardEntry = {
  card_type:     'confirm' | 'form';
  title:         string;
  body?:         string;
  confirm_label: string;
  cancel_label:  string;
  // form-specific
  fields?:       FormField[];
  submit_label?: string;
  // lifecycle
  expiry_at:     number;        // Date.now() + ms
  // blocking mode only
  resolve?: (result: { action: string; form_value?: Record<string, string> }) => void;
  reject?:  (err: Error) => void;
};

type FormField = {
  name:         string;    // key in form_value output
  label:        string;    // displayed label
  placeholder?: string;
  required?:    boolean;
  hidden?:      boolean;   // renders as password input
};
```

### Inline callback response

Lark requires a response to `card.action.trigger` within **3 seconds** or it will show an error. Return a `card` + `toast` response directly on the WebSocket connection:

```typescript
// In your ws.card.action.trigger handler:
const response = buildCallbackResponse(entry, action);
// response = { toast: { type: 'success'|'info', content: '已确认'|'已取消' }, card: { type: 'raw', data: <updatedCard> } }
ws.send(JSON.stringify(response));  // respond to Lark inline
// Then patch async via API for durability
setImmediate(() => void patchCard(msgId, updatedCard));
```

---

## Designing Custom Cards

### Step 1: Choose a base template

| Use case | Starting point |
|---|---|
| Yes/no decision | `buildConfirmCard` or `buildConfirmActiveCard` |
| Collect user input | `buildFormActiveCard` with custom `fields` |
| Long-running task | `buildProgressCard` + patch on each step |
| Display information | `buildInfoCard` |
| OAuth/auth flow | `buildAuthCard` → patch to success/fail |

### Step 2: Add lifecycle states

For any card users interact with, implement three states:

| State | When | How |
|---|---|---|
| **Active** | Card just sent | Buttons/inputs enabled |
| **Responded** | User clicked/submitted | Buttons disabled, show chosen action |
| **Expired** | TTL elapsed | Buttons disabled, subtitle "已失效" |

Transition by **patching** the card (PATCH message API) with the new state JSON.

### Step 3: Embed context in callback values

In channel/plugin mode (no persistent session), embed all task context in the button's `value`:

```json
{
  "behaviors": [{
    "type":  "callback",
    "value": {
      "intent":   "delete_event",
      "event_id": "evt_123_1741000000",
      "title":    "周会"
    }
  }]
}
```

The callback arrives as a new event. Extract the context from `value` to reconstruct the task without needing prior session state.

### Step 4: Column layout

Use `column_set` for side-by-side buttons or two-column key-value rows:

```json
{
  "tag": "column_set",
  "flex_mode": "bisect",           // bisect = equal halves; flow = auto-width; stretch = fill
  "background_style": "default",
  "columns": [
    {
      "tag": "column", "width": "weighted", "weight": 1,
      "vertical_align": "top",
      "elements": [ /* button or markdown */ ]
    },
    {
      "tag": "column", "width": "weighted", "weight": 1,
      "vertical_align": "top",
      "elements": [ /* button or markdown */ ]
    }
  ]
}
```

### Step 5: Header template colors

| Template | Color | Typical use |
|---|---|---|
| `blue` | Blue | Default / neutral / in-progress |
| `green` | Green | Success / completed |
| `orange` | Orange | Warning / confirmation required |
| `red` | Red | Danger / destructive action |
| `grey` | Grey | Expired / cancelled / disabled |
| `wathet` | Light blue | Forms / neutral input |
| `violet` | Violet | Cancelled state |
| `indigo` | Dark blue | Informational |
| `purple` | Purple | Accent |

---

## Complete Example: Custom Approval Card

```typescript
function buildApprovalCard(requester: string, amount: string): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'orange',
      title:    { tag: 'plain_text', content: '费用报销申请' },
      subtitle: { tag: 'plain_text', content: `申请人：${requester}` },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**报销金额：**${amount} 元` },
        { tag: 'hr' },
        {
          tag: 'column_set', flex_mode: 'bisect', background_style: 'default',
          columns: [
            {
              tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
              elements: [{
                tag: 'button', type: 'primary',
                text: { tag: 'plain_text', content: '批准' },
                behaviors: [{
                  type:  'callback',
                  value: { action: 'approve', requester, amount },
                }],
              }],
            },
            {
              tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
              elements: [{
                tag: 'button', type: 'danger',
                text: { tag: 'plain_text', content: '拒绝' },
                behaviors: [{
                  type:  'callback',
                  value: { action: 'reject', requester, amount },
                }],
              }],
            },
          ],
        },
      ],
    },
  };
}

function buildApprovalRespondedCard(requester: string, action: 'approve' | 'reject'): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: action === 'approve' ? 'green' : 'grey',
      title:    { tag: 'plain_text', content: '费用报销申请' },
      subtitle: { tag: 'plain_text', content: action === 'approve' ? '已批准' : '已拒绝' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `申请人：${requester}` },
      ],
    },
  };
}

// Usage:
const card = buildApprovalCard('张三', '1,200');
const res = await sendCard('ou_manager_xxx', card);
// On callback: patch to responded state
await patchCard(res.message_id, buildApprovalRespondedCard('张三', 'approve'));
```

---

## Additional Element Examples

### checker (checkbox)

```json
{
  "tag": "checker",
  "checked": false,
  "text": { "tag": "plain_text", "content": "任务项", "text_size": "normal" },
  "overall_checkable": true,
  "behaviors": [{ "type": "callback", "value": { "action": "toggle", "item_id": "1" } }]
}
```

Fires a callback when checked/unchecked. `checked_style` can add strikethrough + opacity on checked state.

### select_static (dropdown)

```json
{
  "tag": "select_static",
  "placeholder": { "tag": "plain_text", "content": "请选择优先级" },
  "options": [
    { "text": { "tag": "plain_text", "content": "高" }, "value": "high" },
    { "text": { "tag": "plain_text", "content": "中" }, "value": "medium" },
    { "text": { "tag": "plain_text", "content": "低" }, "value": "low" }
  ],
  "behaviors": [{ "type": "callback", "value": { "action": "priority_change" } }]
}
```

Use `multi_select_static` for checkboxes-style multi-selection.

### date_picker / picker_time / picker_datetime

```json
{ "tag": "date_picker",    "placeholder": { "tag": "plain_text", "content": "选择日期" }, "initial_date": "2026-03-23" }
{ "tag": "picker_time",    "placeholder": { "tag": "plain_text", "content": "选择时间" }, "initial_time": "14:00" }
{ "tag": "picker_datetime","placeholder": { "tag": "plain_text", "content": "选择日期时间" }, "initial_datetime": "2026-03-23 14:00" }
```

All three fire a callback with the selected value. Use inside a `form` to collect with `form_submit`.

### overflow (three-dot menu)

```json
{
  "tag": "overflow",
  "options": [
    { "text": { "tag": "plain_text", "content": "编辑" },  "value": "edit" },
    { "text": { "tag": "plain_text", "content": "删除" },  "value": "delete" },
    { "text": { "tag": "plain_text", "content": "分享" },  "multi_url": { "url": "https://..." } }
  ]
}
```

Options can fire a callback (via `value`) or open a URL (via `multi_url`).

### interactive_container (clickable zone)

```json
{
  "tag": "interactive_container",
  "behaviors": [{ "type": "callback", "value": { "action": "open_detail", "id": "123" } }],
  "hover_tips": { "tag": "plain_text", "content": "点击查看详情" },
  "elements": [
    { "tag": "markdown", "content": "**可点击的整个区域**\n点我展开详情" }
  ]
}
```

Wraps any elements in a clickable region. Useful for list-item style cards.

### person / person_list

```json
{ "tag": "person", "user_id": "ou_xxx", "show_avator": true, "show_name": true }

{
  "tag": "person_list",
  "persons": [{ "id": "ou_aaa" }, { "id": "ou_bbb" }],
  "show_avator": true,
  "show_name": true
}
```

---

## Lark Markdown Syntax (card body)

Feishu Markdown in cards differs from standard Markdown:

| Effect | Syntax |
|---|---|
| Bold | `**text**` |
| Italic | `*text*` |
| Strikethrough | `~~text~~` |
| Inline code | `` `code` `` |
| Link | `[label](https://...)` |
| Color | `<font color="red">text</font>` |
| At user | `<at id="ou_xxx">name</at>` |
| Line break | actual newline character (not `\n` escape) |

**Note:** Lark does not support nested markdown inside `<font>` tags. Use separate spans.

**Pipe tables work** inside card `markdown` elements:

```
| 列1 | 列2 | 列3 |
|---|---|---|
| A | B | C |
```

For large or sortable tables prefer the native `table` element instead.
