/**
 * broker — 把 watch 从 Agent 手里搬出来的常驻中转站。
 *
 * 职责（越傻越对）：
 *   1. 持有一条飞书长连接，收应用能收到的所有消息 + 卡片回调
 *   2. 游标切批：每批 = 上次 flush 之后的所有新事件（batch 不是 queue）
 *   3. Agent 空闲时 spawn 一轮 claude -p --resume，把整批喂进去
 *   4. 定时 schedule 也在这儿触发（原本挂在 watch 的 tick 上）
 *
 * 不做：语义判断、摘要、会话路由（只有单会话）、把白咲自己发的回推。
 *
 * 运行：npx tsx broker/broker.ts
 * 设计定稿见 wiki: https://nankai.feishu.cn/wiki/CLf1wSR6NiLuy1kZ0C6cHgh3n6f
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Cron } from 'croner';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── 配置 ────────────────────────────────────────────────────────────────────

// 缺月环境里 LARK_APP_ID/SECRET 放在 ~/.claude/settings.json 的 env 块，
// 手动跑 broker 时把它补进 process.env（已存在的环境变量优先）。
function loadSettingsEnv(): void {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
    for (const [k, v] of Object.entries(raw?.env ?? {})) {
      if (process.env[k] === undefined && typeof v === 'string') process.env[k] = v;
    }
  } catch { /* 忽略：环境变量可能已在外部提供 */ }
}
loadSettingsEnv();

const APP_ID     = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
if (!APP_ID || !APP_SECRET) {
  process.stderr.write('[broker] 缺少 LARK_APP_ID / LARK_APP_SECRET\n');
  process.exit(1);
}

const SESSION_CWD    = process.env.BROKER_CWD    || '/home/guiz/yet-another-lark-mcp-main';
const SESSION_ID     = process.env.BROKER_SESSION_ID || '2b4800df-aefe-427b-be94-419e1d5e1b09';
const CLAUDE_BIN     = process.env.BROKER_CLAUDE_BIN || 'claude';
const TZ             = process.env.LARK_TIMEZONE || 'Asia/Shanghai';
const LOG_DIR        = join(homedir(), '.config', 'lark-broker');
const LOG_FILE       = join(LOG_DIR, 'broker.log');
const NAMES_FILE     = join(LOG_DIR, 'names.json');
const SCHEDULES_DIR  = join(homedir(), '.config', 'lark-mcp');
const SCHEDULES_FILE = join(SCHEDULES_DIR, 'schedules.json');
const CARDS_FILE     = join(SCHEDULES_DIR, 'cards.json');

mkdirSync(LOG_DIR, { recursive: true });

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  process.stderr.write(stamped);
  try { appendFileSync(LOG_FILE, stamped, 'utf-8'); } catch { /* best-effort */ }
}

// ── 批元素：消息 / 卡片回调 / 定时触发 ──────────────────────────────────────

type MessageItem = {
  kind:        'message';
  message_id:  string;
  chat_id:     string;
  chat_name?:  string;
  sender_id:   string;
  sender_name?: string;
  sender_type: string;   // 'user' | 'app'
  msg_type:    string;
  create_time: number;   // unix ms
  content:     any;
  parent_id?:  string;
};

type CardItem = {
  kind:       'card';
  message_id: string;    // 被点击的卡片消息 id
  open_id:    string;
  open_name?: string;
  action:     string;    // 按钮回调值，或 'form_submit'
  value:      any;
  form_value: any;
  timestamp:  number;
};

type ScheduleItem = {
  kind:    'schedule';
  id:      string;
  label:   string;
  fire_at: number;
  cron?:   string;
};

// 卡片寿命到点 —— Agent 收到后调 feishu_im_expire_cards 把它 patch 成已失效。
type CardExpiredItem = {
  kind:       'card_expired';
  message_id: string;
  card_type:  string;   // 'confirm' | 'form' | 'progress'
  title?:     string;
  expiry_at:  number;
};

type BatchItem = MessageItem | CardItem | ScheduleItem | CardExpiredItem;

// 待推送队列 —— flush 时整批取走并清空。
const pending: BatchItem[] = [];

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

// 白咲自己的 open_id（用于过滤自己发的消息，避免自回环）。启动时拉取，拉不到就留空。
let ownOpenId = '';

async function fetchOwnOpenId(): Promise<void> {
  try {
    const res: any = await (client as any).request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    ownOpenId = res?.bot?.open_id ?? '';
    if (ownOpenId) log(`自己(bot) open_id = ${ownOpenId}`);
  } catch (e: any) {
    log(`拉取 bot 信息失败（自过滤将失效）: ${e?.message ?? e}`);
  }
}

// 会话名 / 发送者名。优先级：names.json 手填 > 接口查 > 兜底。
// 背景：单聊(chat_mode=p2p)的 im.chat.get 根本不返回 name 字段；contact.user.get
// 在缺 contact 名字 scope 时也不返回 name。所以 names.json 作为可手填的兜底。
type NamesCfg = { _comment?: string; chats?: Record<string, string>; users?: Record<string, string> };
let namesCfg: NamesCfg = {};

function loadNames(): void {
  try { namesCfg = JSON.parse(readFileSync(NAMES_FILE, 'utf-8')); }
  catch { namesCfg = {}; }
}

// 首次运行时落一份带示例的配置，方便直接填。
function ensureNamesFile(): void {
  try { readFileSync(NAMES_FILE); } catch {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(NAMES_FILE, JSON.stringify({
        _comment: 'chat_id / open_id 到显示名的映射，接口查不到时用这里兜底。改完 30s 内自动生效。',
        chats: { 'oc_301ffef087b1570f6e3b76ae1ab1c302': '私聊·缺月' },
        users: { 'ou_66ec2934c2cf8f312aa4b6b03050984a': '缺月' },
      }, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }
}

const chatNameCache = new Map<string, string | undefined>();
const userNameCache = new Map<string, string | undefined>();

async function lookupChatName(chat_id: string): Promise<string | undefined> {
  if (chatNameCache.has(chat_id)) return chatNameCache.get(chat_id);
  let name: string | undefined;
  try {
    const res: any = await (client as any).im.chat.get({ path: { chat_id } });
    const d = res?.data;
    name = d?.name || undefined;
    if (!name && d?.chat_mode === 'p2p') name = '私聊';   // 单聊没有 name 字段
  } catch { /* 无 scope */ }
  name = name ?? namesCfg.chats?.[chat_id];
  if (name) chatNameCache.set(chat_id, name);
  return name;
}

async function lookupUserName(open_id: string): Promise<string | undefined> {
  if (userNameCache.has(open_id)) return userNameCache.get(open_id);
  // 不再调 contact.user.get：本应用没有通讯录读取 scope，调用必回 41050「no user authority error」，
  // 且飞书 SDK 会把每次失败请求打到 stderr 刷屏。名字只认 names.json 手填的兜底。
  const name = namesCfg.users?.[open_id];
  if (name) userNameCache.set(open_id, name);
  return name;
}

// ── 长连接接收 ──────────────────────────────────────────────────────────────

const stderrLogger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
  error: (...a: any[]) => { process.stderr.write(`[lark-ws] ${a.join(' ')}\n`); },
};

function startReceiver(): void {
  const dispatcher = new lark.EventDispatcher({ logger: stderrLogger }).register({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'im.message.receive_v1': async (data: any) => {
      const msg = data?.message;
      if (!msg) return;

      const senderId   = data?.sender?.sender_id?.open_id ?? '';
      const senderType = data?.sender?.sender_type ?? 'user';
      if (ownOpenId && senderId === ownOpenId) return;   // 白咲自己发的跳过

      let content = msg.content;
      try { content = JSON.parse(content); } catch { /* 留原字符串 */ }

      const item: MessageItem = {
        kind:        'message',
        message_id:  msg.message_id ?? '',
        chat_id:     msg.chat_id ?? '',
        sender_id:   senderId,
        sender_type: senderType,
        msg_type:    msg.message_type ?? 'text',
        create_time: parseInt(msg.create_time ?? '0', 10),
        content,
        parent_id:   msg.parent_id || undefined,
      };
      item.chat_name   = await lookupChatName(item.chat_id);
      item.sender_name = await lookupUserName(item.sender_id);

      pending.push(item);
      log(`收到消息 chat=${item.chat_name ?? item.chat_id} from=${item.sender_name ?? item.sender_id}(${senderType}) type=${item.msg_type} id=${item.message_id}`);
      scheduleTick();
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'card.action.trigger': async (data: any) => {
      const item: CardItem = {
        kind:       'card',
        message_id: data?.context?.open_message_id ?? '',
        open_id:    data?.operator?.open_id ?? '',
        action:     data?.action?.value?.action ?? (data?.action?.form_value !== undefined ? 'form_submit' : 'unknown'),
        value:      data?.action?.value ?? {},
        form_value: data?.action?.form_value ?? {},
        timestamp:  Date.now(),
      };
      item.open_name = await lookupUserName(item.open_id);

      pending.push(item);
      log(`卡片回调 msg=${item.message_id} by=${item.open_name ?? item.open_id} action=${item.action}`);
      scheduleTick();
      // 行内更新卡片需要 Agent 侧 MCP 的内存 registry，broker 拿不到 —— 只 ack 一个 toast。
      return { toast: { type: 'info', content: '已收到' } };
    },
  });

  const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, logger: stderrLogger });

  // 卡片回调以 type="card" 下发，SDK 默认丢弃；重映射成 "event" 让它被路由。
  const anyWs = wsClient as any;
  const origHandle = anyWs.handleEventData.bind(anyWs);
  anyWs.handleEventData = (data: any) => {
    const t = data.headers?.find?.((h: any) => h.key === 'type')?.value;
    if (t === 'card') {
      return origHandle({
        ...data,
        headers: data.headers.map((h: any) => h.key === 'type' ? { ...h, value: 'event' } : h),
      });
    }
    return origHandle(data);
  };

  wsClient.start({ eventDispatcher: dispatcher })
    .then(() => log('飞书长连接已建立，开始接收'))
    .catch((err: Error) => { log(`长连接启动失败: ${err.message}`); process.exit(1); });
}

// ── 定时 schedule（原挂在 watch 的 tick，现挪到 broker） ────────────────────
// 单一事实来源是 ~/.config/lark-mcp/schedules.json（按 appId 分键）。
// 每个 claude -p 会新起一个 MCP 进程、启动时从文件加载，所以 broker 改写文件后
// 下一轮 Agent 就能读到最新状态。

function loadScheduleStore(): Record<string, any[]> {
  try {
    const raw = JSON.parse(readFileSync(SCHEDULES_FILE, 'utf-8'));
    if (Array.isArray(raw)) return { [APP_ID]: raw };   // 兼容旧的扁平数组格式
    return raw;
  } catch { return {}; }
}

function saveScheduleStore(store: Record<string, any[]>): void {
  try {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
    writeFileSync(SCHEDULES_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e: any) { log(`写 schedules 失败: ${e?.message ?? e}`); }
}

function nextCronMs(expression: string, timezone?: string): number | null {
  try {
    const next = new Cron(expression, { timezone }).nextRun();
    return next ? next.getTime() : null;
  } catch { return null; }
}

function pollSchedules(): void {
  loadNames();   // 顺带把 names.json 改动捞进来（30s 内生效）
  const store = loadScheduleStore();
  const list  = store[APP_ID] ?? [];
  const now   = Date.now();
  const due   = list.filter((s: any) => !s.fired && s.fire_at <= now);
  if (due.length === 0) return;

  const keep = list.filter((s: any) => !due.includes(s));
  for (const s of due) {
    pending.push({ kind: 'schedule', id: s.id, label: s.label, fire_at: s.fire_at, cron: s.cron });
    log(`schedule 触发 #${s.id} ${s.label}`);
    if (s.cron) {
      const next = nextCronMs(s.cron, s.timezone);
      if (next !== null) keep.push({
        ...s, id: String(Date.now()), fire_at: next,
        fire_at_iso: new Date(next).toISOString(), fired: false,
      });
    }
  }
  store[APP_ID] = keep;
  saveScheduleStore(store);
  scheduleTick();
}

// ── 卡片过期扫描（搭在同一个 30s tick 上） ──────────────────────────────────
// 单一事实来源是 ~/.config/lark-mcp/cards.json（每轮 MCP 启动时落盘/加载）。
// broker 只做一件事：读文件、比 expiry_at，到点的塞进 pending 把 Agent 叫醒。
// 已通知过的记在内存 Set 里，避免同一张卡每 30s 重复叫醒；Agent patch 成功后
// 会把条目从文件里删掉，之后自然不再命中。

const notifiedExpired = new Set<string>();

function loadCardStore(): { registry: Record<string, any>; progress: Record<string, any> } {
  try {
    const raw  = JSON.parse(readFileSync(CARDS_FILE, 'utf-8'));
    const mine = Array.isArray(raw) ? {} : (raw[APP_ID] ?? {});
    return { registry: mine.registry ?? {}, progress: mine.progress ?? {} };
  } catch { return { registry: {}, progress: {} }; }
}

function pollCards(): void {
  const now = Date.now();
  const { registry, progress } = loadCardStore();
  let pushed = false;

  const consider = (key: string, message_id: string, card_type: string, title: string | undefined, expiry_at: any) => {
    if (typeof expiry_at !== 'number' || expiry_at > now) return;
    if (notifiedExpired.has(key)) return;
    notifiedExpired.add(key);
    pending.push({ kind: 'card_expired', message_id, card_type, title, expiry_at });
    log(`卡片过期 ${card_type} ${message_id}${title ? ` 「${title}」` : ''}`);
    pushed = true;
  };

  for (const [message_id, entry] of Object.entries<any>(registry))
    consider('r:' + message_id, message_id, entry?.card_type ?? 'confirm', entry?.title, entry?.expiry_at);
  for (const [message_id, state] of Object.entries<any>(progress))
    consider('p:' + message_id, message_id, 'progress', state?.title, state?.expiry_at);

  // 条目已被 Agent 删掉的，忘掉它的通知记录，免得 Set 无限增长
  const present = new Set([
    ...Object.keys(registry).map(id => 'r:' + id),
    ...Object.keys(progress).map(id => 'p:' + id),
  ]);
  for (const key of notifiedExpired) if (!present.has(key)) notifiedExpired.delete(key);

  if (pushed) scheduleTick();
}

// ── Driver：把一批事件喂给一轮 claude -p ────────────────────────────────────

// 无头一轮里要告诉 Agent：你在 broker 模式下，别去碰 watch，收尾就直接结束。
const BROKER_SYSTEM_PROMPT =
  '[broker 模式] 你正由 broker 驱动、跑在无头会话里，本轮要处理的事件已随输入给你。' +
  '不要调用 feishu_im_watch——它已被搬走，飞书长连接由 broker 持有。' +
  '回复照常用 feishu_im_send 等工具发给正确的会话/发送者，然后直接结束本轮；' +
  'broker 会继续收消息，在下一轮再喂给你。';

let busy = false;

function fmtTime(ms: number): string {
  if (!ms) return '?';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
}

function contentToText(o: any): string {
  if (typeof o === 'string') return o;
  if (o && typeof o === 'object') {
    if (typeof o.text === 'string') return o.text;
    return JSON.stringify(o);
  }
  return '';
}

/** 把整批事件渲染成一段给 Agent 读的文本。严格保留来源，供其决定 send 给谁。 */
function renderBatch(batch: BatchItem[]): string {
  const lines: string[] = [`【broker 推来 ${batch.length} 条事件】`];
  batch.forEach((e, i) => {
    lines.push('');
    if (e.kind === 'message') {
      const who   = `${e.sender_name ?? '?'}(${e.sender_id}, ${e.sender_type})`;
      const where = `${e.chat_name ?? '?'}(${e.chat_id})`;
      lines.push(`#${i + 1} 消息 | 会话: ${where} | 发送者: ${who} | 时间: ${fmtTime(e.create_time)} | 类型: ${e.msg_type} | msg_id: ${e.message_id}`);
      if (e.parent_id) lines.push(`   (回复自 parent_id=${e.parent_id})`);
      lines.push(`   内容: ${contentToText(e.content)}`);
    } else if (e.kind === 'card') {
      lines.push(`#${i + 1} 卡片回调 | 卡片 msg_id: ${e.message_id} | 点击者: ${e.open_name ?? '?'}(${e.open_id}) | 动作: ${e.action} | 时间: ${fmtTime(e.timestamp)}`);
      if (e.form_value && Object.keys(e.form_value).length) lines.push(`   表单值: ${JSON.stringify(e.form_value)}`);
      if (e.value && Object.keys(e.value).length) lines.push(`   附带值: ${JSON.stringify(e.value)}`);
      lines.push(`   → 若是确认卡/表单卡，调 feishu_im_card_responded 把卡面刷成已确认/已取消/已提交`);
    } else if (e.kind === 'card_expired') {
      lines.push(`#${i + 1} 卡片过期 | msg_id: ${e.message_id} | 类型: ${e.card_type}${e.title ? ` | 标题: ${e.title}` : ''} | 到点: ${fmtTime(e.expiry_at)}`);
      lines.push(`   → 调 feishu_im_expire_cards 把它 patch 成已失效`);
    } else {
      lines.push(`#${i + 1} 定时提醒触发 | ${e.label} (id=${e.id}${e.cron ? `, cron=${e.cron}` : ''}) | 原定时间: ${fmtTime(e.fire_at)}`);
    }
  });
  return lines.join('\n');
}

function runTurn(batch: BatchItem[]): Promise<void> {
  const prompt = renderBatch(batch);
  log(`—— 起一轮，${batch.length} 条 ——`);

  return new Promise<void>((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        '-p', '--resume', SESSION_ID,
        '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions',
        '--append-system-prompt', BROKER_SYSTEM_PROMPT,
      ],
      {
        cwd: SESSION_CWD,
        // LARK_NO_WATCH: Agent 侧 MCP 纯发送；LARK_BROKER: 让 SessionStart hook 让路，别去恢复 watch
        env: { ...process.env, LARK_NO_WATCH: '1', LARK_BROKER: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const outFile = join(LOG_DIR, `turn-${Date.now()}.jsonl`);
    child.stdout.on('data', (d: Buffer) => { try { appendFileSync(outFile, d); } catch {} });
    child.stderr.on('data', (d: Buffer) => { process.stderr.write(`[claude] ${d}`); });

    child.on('error', (err) => { log(`spawn claude 失败: ${err.message}`); resolve(); });
    child.on('close', (code) => { log(`—— 一轮结束 (exit ${code})，输出存 ${outFile} ——`); resolve(); });

    child.stdin.write(prompt + '\n');
    child.stdin.end();
  });
}

function scheduleTick(): void {
  setImmediate(tick);
}

async function tick(): Promise<void> {
  if (busy || pending.length === 0) return;
  busy = true;
  const batch = pending.splice(0, pending.length);
  try {
    await runTurn(batch);
  } catch (e: any) {
    log(`一轮异常: ${e?.message ?? e}`);
  } finally {
    busy = false;
    if (pending.length > 0) scheduleTick();   // 跑完期间又来事件，接着下一轮
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // DRY：跳过飞书长连接，只喂一条假消息跑一轮，用来单独验证 driver
  // （避免和交互会话抢 WS，也避免 resume 到正在用的 session）。
  if (process.env.BROKER_DRY) {
    const text = process.env.BROKER_DRY_TEXT || 'broker dry run：收到一条测试消息';
    log(`DRY 模式 | cwd=${SESSION_CWD} session=${SESSION_ID} claude=${CLAUDE_BIN}`);
    await runTurn([{
      kind: 'message', message_id: 'om_dry', chat_id: 'oc_dry', chat_name: 'dry',
      sender_id: 'ou_dry', sender_name: '缺月', sender_type: 'user',
      msg_type: 'text', create_time: Date.now(), content: { text },
    }]);
    process.exit(0);
  }

  log(`broker 启动 | cwd=${SESSION_CWD} session=${SESSION_ID} claude=${CLAUDE_BIN}`);
  ensureNamesFile();
  loadNames();
  await fetchOwnOpenId();
  startReceiver();
  setInterval(() => { pollSchedules(); pollCards(); }, 30_000);   // 30s 扫一遍：定时任务 + 卡片过期（顺带重载 names.json）
}

main();
