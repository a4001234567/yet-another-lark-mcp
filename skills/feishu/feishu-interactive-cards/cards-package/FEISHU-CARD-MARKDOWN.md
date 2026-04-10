# Feishu Card Markdown — 特性清单与验证

本文档列出飞书卡片 `markdown` element 和 `post` 消息中支持的语法，并附验证状态。
（测试日期：2026-03-23，设备：移动端飞书）

---

## 消息类型对比

| 特性 | text | post | 卡片 markdown |
|---|---|---|---|
| 纯文字 | ✅ | ✅ | ✅ |
| 加粗 `**text**` | ❌ | ✅ | ✅ |
| 斜体 `*text*` | ❌ | ✅ | ✅ |
| 删除线 `~~text~~` | ❌ | ✅ | ✅ |
| 行内代码 `` `code` `` | ❌ | ✅ | ✅ |
| 超链接 | ❌ | ✅ | ✅ |
| 颜色 `<font color>` | ❌ | ❌ | ✅ |
| 管道表格 | ❌ | ❌ | ✅（实测） |
| @提及 | ❌ | ✅ | ❓ 待测 |
| 无序列表 `- ` | ❌ | ❌ | ✅（实测） |
| 有序列表 `1. ` | ❌ | ❌ | ✅（实测） |
| 代码块 ` ``` ` | ❌ | ❌ | ✅（实测） |
| 标题 `# ` | ❌ | ❌ | ✅（实测） |
| 引用 `> ` | ❌ | ❌ | ✅（实测） |
| 水平线 `---` | ❌ | ❌ | ✅（实测） |
| @提及 `<at id>` | ❌ | ✅ | ✅（实测） |
| 换行 | 用实际换行 | 用实际换行 | 用实际换行 |

---

## 卡片 Markdown 支持的格式（已确认）

### 文字样式

```
**加粗**
*斜体*
~~删除线~~
`行内代码`
```

### 颜色

```
<font color="red">红色</font>
<font color="green">绿色</font>
<font color="blue">蓝色</font>
<font color="grey">灰色</font>
<font color="orange">橙色</font>
```
支持的颜色值：`red` `green` `blue` `grey` `orange` `purple` `yellow` `wathet` `indigo` `violet` `carmine`

注：`<font>` 内不能嵌套 `**加粗**` 等 markdown 语法（实测不生效，已确认）

### 链接

```
[显示文字](https://open.feishu.cn)
```

### 管道表格（实测可用）

```
| 列1 | 列2 | 列3 |
|---|---|---|
| A | B | C |
| D | E | F |
```

### 换行

卡片 markdown 中，实际换行符（`\n`）生效。不需要 `<br>`。

---

## 待验证特性

### A. @提及

```
<at id="ou_xxx">用户名</at>
```
（post 消息用 `{tag: "at", user_id: "ou_xxx"}`，卡片 markdown 可能用 HTML-like 语法）

### B. 无序列表

```
- 第一项
- 第二项
- 第三项
```

### C. 有序列表

```
1. 第一步
2. 第二步
3. 第三步
```

### D. 代码块

````
```
代码内容
多行代码
```
````

或带语言标记：

````
```python
def hello():
    print("hello")
```
````

### E. 标题

```
# 一级标题
## 二级标题
### 三级标题
```

### F. 引用

```
> 这是引用内容
> 可以多行
```

### G. 水平线

```
---
```
（卡片有原生 `{ tag: 'hr' }` element，markdown 内的 `---` 是否渲染待确认）

### H. 图片嵌入

```
![alt](image_key)
```
（飞书可能支持用 image_key 嵌入图片到 markdown，待测）

---

## 卡片结构快速参考

### 最简 markdown 卡片

```json
{
  "schema": "2.0",
  "body": {
    "elements": [
      { "tag": "markdown", "content": "**加粗** 内容" }
    ]
  }
}
```

### 带标题的 markdown 卡片

```json
{
  "schema": "2.0",
  "header": {
    "template": "blue",
    "title": { "tag": "plain_text", "content": "标题" }
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "正文内容" }
    ]
  }
}
```

### 多段落 + 分割线

```json
{
  "schema": "2.0",
  "body": {
    "elements": [
      { "tag": "markdown", "content": "第一段" },
      { "tag": "hr" },
      { "tag": "markdown", "content": "第二段" }
    ]
  }
}
```

---

## 卡片 Element 验证结果

| Element | 状态 | 备注 |
|---|---|---|
| `markdown` | ✅ | 见上方完整语法表 |
| `hr` | ✅ | |
| `button` | ✅ | primary / danger / default / laser |
| `column_set` | ✅ | bisect / flow / stretch；手机端 stretch 可能折叠 |
| `collapsible_panel` | ✅ | 支持展开/折叠，可嵌套任意 element |
| `form` + `input` | ✅ | submit 按钮触发 form_value 回调 |
| `table` | ✅ | 原生表格，支持列宽/对齐/分页 |
| `chart` | ✅（linearProgress）| 其他图表类型未测 |
| `img` | ✅ | 需要已上传的 image_key |
| `note` | ❌ | Schema 2.0 不支持（1.0 特性）|

---

## 已知限制

1. `<font color>` 内不能嵌套 `**加粗**`
2. 卡片 markdown 里的图片嵌入语法未经验证
3. 管道表格无法指定列宽/对齐，需要用 `table` element
4. 手机端 `column_set` 的 `flex_mode: stretch` 可能折叠成竖排
5. `config.update_multi: true` 必须在发送时设置，发出后无法追加
6. `note` element 不存在于 Schema 2.0，发送会 400
7. img element 需要通过飞书 API 预先上传得到 image_key，不能直接用 URL
