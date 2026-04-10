# Feishu Card Schema 2.0 — Complete Element Index

Full reference of all card element types, based on `LARK_tools/card_struct.py` (github.com/a4001234567/LARK_tools) and verified test results (2026-03-23, mobile Feishu).

Field notation: **required** / *optional* / `FIXED` (always this value)

## Verification Status

| Element | Status | Notes |
|---|---|---|
| `markdown` | ✅ | Full syntax verified — see FEISHU-CARD-MARKDOWN.md |
| `div` | ✅ | text_size / text_color / text_align all work |
| `img` | ✅ | Requires uploaded img_key |
| `hr` | ✅ | |
| `person` | ❌ | Returns 400 — use `person_list` instead |
| `person_list` | ✅ | Works for single and multiple users |
| `chart` | ✅ | linearProgress verified; other VChart types untested |
| `table` | ✅ | Column types, pagination work |
| `column_set` | ✅ | bisect / flow / stretch |
| `collapsible_panel` | ✅ | Expand/collapse works |
| `interactive_container` | ✅ | Callback fires correctly |
| `button` | ✅ | primary / danger / default / laser |
| `input` | ✅ | text / password types |
| `form` + submit | ✅ | form_value returned on submit |
| `select_static` | ✅ | |
| `checker` | ✅ | checked_style strikethrough works |
| `overflow` | ✅ | Three-dot menu renders |
| `date_picker` | ✅ | |
| `picker_time` | ✅ | |
| `picker_datetime` | ✅ | |
| `multi_select_static` | ❓ untested | |
| `select_person` | ❓ untested | |
| `multi_select_person` | ❓ untested | |
| `select_img` | ❓ untested | Needs img_keys |
| `img_combination` | ❓ untested | Needs img_keys |

---

## Top-level Card Structure

```
card
├── schema            FIXED "2.0"
├── config?           config object
├── card_link?        link object (card-level click URL)
├── header?           header object
└── body?             body object
    └── elements[]    list of element objects
```

### config

| Field | Type | Default | Notes |
|---|---|---|---|
| `streaming_mode` | bool | false | CardKit streaming |
| `update_multi` | bool | true | allow patch after send |
| `enable_forward` | bool | true | allow forwarding |
| `width_mode` | str | "default" | "default" \| "fill" |

### header

| Field | Type | Notes |
|---|---|---|
| `title` | text | **required** — `plain_text` or `markdown` |
| `subtitle` | text | optional |
| `template` | str | `blue` `green` `orange` `red` `grey` `wathet` `indigo` `purple` `violet` `carmine` |
| `text_tag_list` | text_tag[] | colored label chips beside the title |
| `icon` | icon | header icon |

### text_tag

| Field | Type | Default |
|---|---|---|
| `tag` | FIXED | `"text_tag"` |
| `text` | plain_text | |
| `color` | str | `"blue"` — same palette as header template |

---

## Text Types

### plain_text

```json
{ "tag": "plain_text", "content": "hello" }
```

### markdown (as text, e.g. in header.title)

```json
{ "tag": "markdown", "content": "**hello**" }
```

---

## Presenter Elements (display-only)

### markdown

```json
{
  "tag": "markdown",
  "content": "**bold** *italic* `code`\n[link](https://...)\n<font color=\"red\">red</font>",
  "text_align": "left",
  "text_size": "normal"
}
```

### div

Structured text with per-element styling:

```json
{
  "tag": "div",
  "text": {
    "tag": "plain_text",
    "content": "文字内容",
    "text_size": "normal",
    "text_color": "default",
    "text_align": "left",
    "lines": 2
  }
}
```

`text_size`: `"heading-0"` through `"heading-4"`, `"normal"`, `"notation"`
`text_color`: `"default"` `"grey"` `"red"` `"orange"` `"yellow"` `"green"` `"wathet"` `"blue"` `"purple"` `"carmine"`

### img

```json
{
  "tag": "img",
  "img_key": "img_v3_xxx",
  "alt": { "tag": "plain_text", "content": "图片描述" },
  "title": { "tag": "plain_text", "content": "图片标题" },
  "scale_type": "crop_center",
  "size": "large",
  "preview": true
}
```

`img_key` must be obtained by uploading via Feishu API first.
`scale_type`: `"crop_center"` `"crop_top"` `"fit_horizontal"`
`size`: `"large"` `"medium"` `"small"` `"tiny"` or `"WxH"` e.g. `"200x150"`

### img_combination

Multiple images in a grid:

```json
{
  "tag": "img_combination",
  "combination_mode": "bisect",
  "img_list": [
    { "img_key": "img_v3_aaa" },
    { "img_key": "img_v3_bbb" }
  ]
}
```

`combination_mode`: `"bisect"` `"trisect"` `"quartet"` etc.

### person

> ❌ Returns 400 — `person` as a standalone element does not work in Schema 2.0. Use `person_list` even for a single person.

### person_list

Multiple users in a row:

```json
{
  "tag": "person_list",
  "persons": [{ "id": "ou_aaa" }, { "id": "ou_bbb" }],
  "show_avator": true,
  "show_name": true,
  "size": "medium",
  "lines": 1
}
```

### hr

```json
{ "tag": "hr" }
```

### chart

Progress bar (linearProgress):

```json
{
  "tag": "chart",
  "chart_spec": {
    "type": "linearProgress",
    "data": { "values": [{ "value": 75, "name": "progress" }] },
    "color": ["#3370FF"],
    "appendPadding": [0, 0, 0, 0]
  },
  "aspect_ratio": "2:1",
  "height": "auto"
}
```

Full chart via VChart spec — see VChart documentation for other types.

### table

```json
{
  "tag": "table",
  "columns": [
    { "name": "name",   "display_name": "姓名", "data_type": "text", "width": "100px" },
    { "name": "score",  "display_name": "分数", "data_type": "number", "horizontal_align": "right" },
    { "name": "date",   "display_name": "日期", "data_type": "date", "date_format": "YYYY-MM-DD" }
  ],
  "rows": [
    { "name": "Alice", "score": 95, "date": 1711123200000 },
    { "name": "Bob",   "score": 82, "date": 1711209600000 }
  ],
  "page_size": 10,
  "row_height": "low",
  "header_style": { "bold": true, "background_style": "grey" }
}
```

`data_type`: `"text"` `"number"` `"date"` `"lark_md"` `"options"`
`row_height`: `"low"` `"medium"` `"high"` `"custom"` (use with `row_max_height`)

---

## Layout Elements

### column_set

```json
{
  "tag": "column_set",
  "flex_mode": "bisect",
  "columns": [
    {
      "tag": "column",
      "width": "weighted",
      "weight": 1,
      "elements": [ /* ... */ ]
    }
  ]
}
```

`flex_mode`: `"bisect"` `"trisect"` `"quartet"` `"flow"` `"stretch"` `null` (auto)

### collapsible_panel

```json
{
  "tag": "collapsible_panel",
  "expanded": false,
  "header": {
    "title": { "tag": "plain_text", "content": "折叠标题" },
    "background_color": "grey",
    "icon": { "tag": "chevron-down", "token": "chevron-down_outlined" }
  },
  "border": { "color": "grey", "corner_radius": "5px" },
  "elements": [ /* any elements */ ]
}
```

### interactive_container

Entire region acts as a clickable button:

```json
{
  "tag": "interactive_container",
  "behaviors": [{ "type": "callback", "value": { "action": "click", "id": "123" } }],
  "hover_tips": { "tag": "plain_text", "content": "点击查看" },
  "has_border": true,
  "border_color": "grey",
  "corner_radius": "8px",
  "padding": "12px",
  "elements": [ /* any presenter elements */ ]
}
```

---

## Interactive Elements

All interactive elements fire a behavior on user action.

### Behavior types

```json
{ "type": "callback", "value": { /* any JSON object, returned verbatim */ } }
{ "type": "open_url", "default_url": "https://...", "android_url": "...", "ios_url": "..." }
{ "type": "form_action", "behavior": "submit" }
```

### button

```json
{
  "tag": "button",
  "type": "primary",
  "size": "medium",
  "text": { "tag": "plain_text", "content": "确认" },
  "behaviors": [{ "type": "callback", "value": { "action": "confirm" } }],
  "disabled": false,
  "disabled_tips": { "tag": "plain_text", "content": "已处理" },
  "confirm": {
    "title": { "tag": "plain_text", "content": "确认操作" },
    "text":  { "tag": "plain_text", "content": "此操作不可撤销" }
  }
}
```

`type`: `"default"` `"primary"` `"danger"` `"laser"`
`action_type`: `"form_submit"` (use instead of `behaviors` for form submit buttons)

### input

```json
{
  "tag": "input",
  "name": "field_name",
  "element_id": "input_1",
  "placeholder": { "tag": "plain_text", "content": "请输入内容" },
  "input_type": "text",
  "required": false,
  "max_length": 500,
  "label": { "tag": "plain_text", "content": "字段名" },
  "label_position": "top",
  "rows": 3,
  "auto_resize": true
}
```

`input_type`: `"text"` `"password"` `"number"` `"email"` `"phone"`

### select_static

```json
{
  "tag": "select_static",
  "placeholder": { "tag": "plain_text", "content": "请选择" },
  "options": [
    { "text": { "tag": "plain_text", "content": "选项A" }, "value": "a" },
    { "text": { "tag": "plain_text", "content": "选项B" }, "value": "b", "icon": { "token": "..." } }
  ],
  "behaviors": [{ "type": "callback", "value": { "action": "selected" } }]
}
```

### multi_select_static

Same structure as `select_static` but `tag: "multi_select_static"` and requires `name` field.

### select_person / multi_select_person

```json
{
  "tag": "select_person",
  "placeholder": { "tag": "plain_text", "content": "选择负责人" },
  "options": [{ "value": "ou_aaa" }, { "value": "ou_bbb" }],
  "behaviors": [{ "type": "callback", "value": { "action": "assignee_change" } }]
}
```

### checker

```json
{
  "tag": "checker",
  "checked": false,
  "text": {
    "tag": "plain_text",
    "content": "待办项描述",
    "text_size": "normal",
    "text_color": "default"
  },
  "overall_checkable": true,
  "checked_style": { "show_strikethrough": true, "opacity": 0.5 },
  "behaviors": [{ "type": "callback", "value": { "action": "toggle", "id": "task_1" } }]
}
```

### overflow (three-dot menu)

```json
{
  "tag": "overflow",
  "options": [
    { "text": { "tag": "plain_text", "content": "编辑" }, "value": "edit" },
    { "text": { "tag": "plain_text", "content": "分享" }, "multi_url": { "url": "https://..." } }
  ]
}
```

Options with `value` fire a callback; options with `multi_url` open a URL.

### date_picker

```json
{
  "tag": "date_picker",
  "placeholder": { "tag": "plain_text", "content": "选择日期" },
  "initial_date": "2026-03-23",
  "required": false
}
```

`initial_date` format: `"YYYY-MM-DD"`

### picker_time

```json
{ "tag": "picker_time", "initial_time": "14:00" }
```

### picker_datetime

```json
{ "tag": "picker_datetime", "initial_datetime": "2026-03-23 14:00" }
```

### select_img

Image selection grid:

```json
{
  "tag": "select_img",
  "multi_select": false,
  "layout": "bisect",
  "aspect_ratio": "16:9",
  "options": [
    { "img_key": "img_v3_aaa", "value": "option_a" },
    { "img_key": "img_v3_bbb", "value": "option_b" }
  ]
}
```

---

## Form Pattern

Wrap inputs + a submit button in a `form` element:

```json
{
  "tag": "form",
  "name": "my_form",
  "direction": "vertical",
  "elements": [
    { "tag": "input",  "name": "title",    "placeholder": { "tag": "plain_text", "content": "标题" } },
    { "tag": "input",  "name": "content",  "placeholder": { "tag": "plain_text", "content": "内容" }, "rows": 4 },
    { "tag": "select_static", "name": "priority", "options": [...] },
    { "tag": "button", "text": { "tag": "plain_text", "content": "提交" }, "action_type": "form_submit" }
  ]
}
```

On submit, a `card.action.trigger` event fires with `form_value: { title: "...", content: "..." }`.

---

## Behavior & Callback Summary

| Behavior type | When to use |
|---|---|
| `callback` | Return data to your server; embed all needed state in `value` |
| `open_url` | Open a link in browser; no server callback |
| `form_action: "submit"` | Submit a form (use `action_type: "form_submit"` on button instead) |

Card callbacks arrive as new events. The `value` object is returned verbatim — embed all context needed to reconstruct the task.

---

## Source

Python type-safe card constructor: [github.com/a4001234567/LARK_tools](https://github.com/a4001234567/LARK_tools)
- `utils/struct.py` — `component`, `field`, `TypedList` type system
- `card_struct.py` — all element classes with `serialize()` → JSON
- `LarkCard.py` — same schema with slightly different class hierarchy (active development version)
