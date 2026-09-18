/**
 * 墨羽飞书 broker v2：独占飞书长连接 + 常驻 ACP 会话
 *
 * 与 v1 的区别：不再每轮 spawn 一个一次性 headless，而是常驻一个
 * `dsh --profile acp` 子进程，用 ACP（stdio JSON-RPC）驱动同一个会话：
 * 会话连续、可以恢复，进程重启后 session/resume 接着用。
 *
 * 分工：
 *   broker   —— 唯一的长连接持有者，收消息/卡片回调，攒批，管理 ACP 子进程
 *   dsh acp  —— 常驻会话本体，挂着墨水自己的 lark MCP（session/new 时挂上）
 *   回复     —— 仍由会话里的 agent 调 mcp__lark__feishu_im_send 发出；
 *               若一轮结束却没有调用过发送工具，broker 兜底把最后一段文本发出去
 *
 * 已知取舍（v1）：
 *   - session/request_permission 目前自动选第一个 allow 选项，只记日志。
 *     以后可以改成发飞书确认卡、等回调再回答。
 *   - 长连接断了不会重放期间的消息（飞书不补投）。
 *
 * 运行：node broker.mjs   （必须在沙箱外；它要 spawn dsh acp 并用管道通信）
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Writable, Readable } from 'node:stream';
import * as lark from '@larksuiteoapi/node-sdk';
import * as acp from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------
const HOME = homedir();
const CREDS = JSON.parse(readFileSync(join(HOME, '.dsh', 'secrets', 'lark.json'), 'utf8'));
const RUN_DIR = join(HOME, 'lark-mcp', 'broker-run');
mkdirSync(RUN_DIR, { recursive: true });
const LOG_FILE = join(RUN_DIR, 'broker.log');
const STATE_FILE = join(RUN_DIR, 'state.json');
const ACP_PID_FILE = join(RUN_DIR, 'acp.pid');

const NODE = process.execPath;
const DSH_BIN = 'C:\\Users\\sumiha\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const WORKSPACE = 'C:\\Users\\sumiha';
const SLIM_SERVER = 'C:\\Users\\sumiha\\lark-mcp\\lark-mcp\\local\\slim-server.mjs';
const TURN_WARN_MS = 15 * 60 * 1000;

// 会话模型：resume 回来的会话带着自己存下来的模型选择，profile 里的默认值只在新建
// 会话时生效。所以每次接上会话都显式设一次 model 选项，指定成带视觉的 deepseek-flash。
const SESSION_MODEL_PROVIDER = 'deepseek-official';
const SESSION_MODEL_ID = 'deepseek-flash';

// ── 气泡：Live2DViewerEX 的本地 ExAPI（ws://127.0.0.1:10086/api）──────────────
// 只打在本机的「墨羽」模型（槽位 1）上，跟白咲的 guiz（槽位 0）互不干扰。
// 规矩（缺月 2026-09-15 定）：非阻塞 fire-and-forget，连不上就静默丢；
// 绝不允许冒泡这一步挡在工具返回或一轮的返回路径上。
const LIVE2D_WS = 'ws://127.0.0.1:10086/api';
const LIVE2D_MODEL_ID = 1;
const LIVE2D_BUBBLE_MS = 10_000;
let bubbleSeq = 1;

function bubble(text) {
    if (!text) return;
    if (typeof WebSocket === 'undefined') return;   // 老 Node 没有全局 WebSocket，静默跳过
    try {
        const msg = {
            msg: 11000, // DisplayBubbleText
            msgId: bubbleSeq++,
            data: {
                id: LIVE2D_MODEL_ID,
                text: String(text).slice(0, 120),
                choices: [],
                textFrameColor: 0x000000,
                textColor: 0x66d9e8, // 墨羽的冷青；ViewerEX 控制台若配过字色会盖掉，认了
                duration: LIVE2D_BUBBLE_MS,
            },
        };
        const ws = new WebSocket(LIVE2D_WS);
        const close = () => { try { ws.close(); } catch { /* ignore */ } };
        ws.addEventListener('open', () => { try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ } setTimeout(close, 300); });
        ws.addEventListener('error', close);
        setTimeout(close, 3000);
    } catch { /* ViewerEX 没开就算了 */ }
}

/** 工具调用 → 气泡文案：shell／命令类冒命令本身，其余冒工具名。 */
function bubbleForTool(update) {
    const title = String(update?.title ?? update?.kind ?? '工具');
    const cmd = update?.rawInput?.command ?? update?.rawInput?.cmd;
    const probe = (title + ' ' + (typeof cmd === 'string' ? cmd : '')).toLowerCase();
    if (probe.includes('live2d') || probe.includes('bubble-send')) return;   // 防自激
    if (typeof cmd === 'string' && cmd.trim()) {
        bubble('⚡ ' + cmd.trim().replace(/\s+/g, ' ').slice(0, 80));
        return;
    }
    bubble('🔧 ' + title.slice(0, 80));
}

const MCP_SERVERS = [
    {
        name: 'lark',
        command: NODE,
        args: [SLIM_SERVER],
        env: [
            { name: 'LARK_NO_WATCH', value: '1' },
            { name: 'LARK_BROKER', value: '1' },
        ],
    },
];

const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    process.stdout.write(line + '\n');
    try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* best effort */ }
}
const quietLogger = {
    debug() {},
    info(...a) { log('sdk: ' + fmt(a)); },
    warn(...a) { log('sdk warn: ' + fmt(a)); },
    error(...a) { log('sdk error: ' + fmt(a)); },
};
function readState() {
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
    try { writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2)); } catch (e) { log('state write failed: ' + e.message); }
}

process.on('unhandledRejection', (reason) => log('unhandledRejection (kept alive): ' + fmt([reason])));
process.on('uncaughtException', (err) => log('uncaughtException (kept alive): ' + (err?.message ?? err)));

// ---------------------------------------------------------------------------
// ACP：常驻会话
// ---------------------------------------------------------------------------
let acpCtx = null;         // ClientContext
let acpChild = null;
let sessionId = null;
let acpReady = false;
let turnText = '';
let turnSentViaTool = false;

const feishu = new lark.Client({ appId: CREDS.appId, appSecret: CREDS.appSecret, logger: quietLogger });

function onSessionUpdate(params) {
    const update = params?.update;
    if (!update) return;
    switch (update.sessionUpdate) {
        case 'agent_message_chunk':
            if (update.content?.type === 'text') turnText += update.content.text;
            break;
        case 'agent_thought_chunk':
            break; // 思考不落日志，太吵
        case 'tool_call': {
            const blob = JSON.stringify(update);
            if (blob.includes('feishu_im_send')) turnSentViaTool = true;
            log(`tool_call: ${update.title ?? update.toolCallId} [${update.status ?? '?'}]`);
            if ((update.status ?? 'in_progress') === 'in_progress') bubbleForTool(update);
            break;
        }
        case 'tool_call_update':
            log(`tool_call_update: ${update.toolCallId} [${update.status ?? '?'}]`);
            break;
        case 'usage_update':
            break;
        default:
            log(`session/update: ${update.sessionUpdate}`);
    }
}

async function requestPermission(params) {
    const options = params?.options ?? [];
    const pick = options.find((o) => o.kind === 'allow_once')
        ?? options.find((o) => o.kind === 'allow_always')
        ?? options[0];
    log(`permission requested: ${params?.toolCall?.title ?? '(untitled)'} → auto-select ${pick?.kind ?? 'none'} (${pick?.name ?? ''})`);
    if (!pick) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: pick.optionId } };
}

/**
 * 清理上一次硬杀留下的 ACP 孤儿进程。
 * 硬杀 broker 时，它拉起的 `dsh acp` 子进程会活下来，并且一直占着会话，
 * 导致下次启动 session/resume 失败、只能另起新会话（上下文就断了）。
 * 所以启动时按 pid 文件收一次尾：只认 12 小时以内的记录，避免 PID 复用误杀。
 */
function cleanupStaleAcpChild() {
    try {
        if (!existsSync(ACP_PID_FILE)) return;
        const pid = Number(readFileSync(ACP_PID_FILE, 'utf8').trim());
        const ageMs = Date.now() - statSync(ACP_PID_FILE).mtimeMs;
        if (!Number.isInteger(pid) || pid <= 0) return;
        if (ageMs > 12 * 60 * 60 * 1000) {
            log(`stale acp.pid ignored (${Math.round(ageMs / 3600000)}h old)`);
            return;
        }
        process.kill(pid, 0); // 存在则抛错前先探活
        process.kill(pid);
        // 等它真的死透再连：否则新 ACP 会跟它还占着的会话撞车，resume 失败。
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 60; i++) {
            try { process.kill(pid, 0); } catch { break; }
            Atomics.wait(sleeper, 0, 0, 100);
        }
        log(`killed stale ACP child pid=${pid} (held the session after a hard kill)`);
    } catch (err) {
        if (err?.code !== 'ESRCH') log('stale ACP cleanup skipped: ' + err.message);
    }
}

function startAcpChild() {
    acpChild = spawn(NODE, [DSH_BIN, '--profile', 'acp'], { cwd: WORKSPACE, stdio: ['pipe', 'pipe', 'pipe'] });
    try { writeFileSync(ACP_PID_FILE, String(acpChild.pid)); } catch { /* best effort */ }
    acpChild.stderr.on('data', (d) => {
        const text = String(d).trim();
        if (text) log('acp stderr: ' + text.slice(0, 1000));
    });
    acpChild.on('exit', (code, signal) => {
        log(`acp child exited code=${code} signal=${signal}`);
        acpReady = false;
        acpCtx = null;
        sessionId = null;
        setTimeout(connectAcp, 5000);
    });
}

async function connectAcp() {
    try {
        if (!acpChild || acpChild.exitCode !== null) startAcpChild();
        const stream = acp.ndJsonStream(Writable.toWeb(acpChild.stdin), Readable.toWeb(acpChild.stdout));
        const app = acp.client({ name: 'moyu-broker' })
            .onRequest(acp.methods.client.session.requestPermission, (ctx) => requestPermission(ctx.params))
            .onNotification(acp.methods.client.session.update, (ctx) => onSessionUpdate(ctx.params));
        const conn = app.connect(stream);
        acpCtx = conn.agent;

        const init = await acpCtx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
        });
        log(`acp initialized (protocol v${init.protocolVersion})`);

        const saved = readState().sessionId;
        if (saved) {
            try {
                await acpCtx.request(acp.methods.agent.session.resume, {
                    sessionId: saved,
                    cwd: WORKSPACE,
                    mcpServers: MCP_SERVERS,
                });
                sessionId = saved;
                log('acp session resumed: ' + saved);
            } catch (err) {
                log('session resume failed (' + err.message + '), creating a new one');
            }
        }
        if (!sessionId) {
            const created = await acpCtx.request(acp.methods.agent.session.new, {
                cwd: WORKSPACE,
                mcpServers: MCP_SERVERS,
            });
            sessionId = created.sessionId;
            writeState({ sessionId });
            const opts = (created.configOptions ?? []).map((o) => o.id).join(', ');
            log(`acp session created: ${sessionId} (configOptions: ${opts || 'none'})`);
        }
        // 模型选项的值是 ACP 的 opaque selector：JSON.stringify([provider, model])。
        // 失败只记日志，不挡住通道（比如该 provider 下没这个模型 id）。
        try {
            const result = await acpCtx.request(acp.methods.agent.session.setConfigOption, {
                sessionId,
                configId: 'model',
                value: JSON.stringify([SESSION_MODEL_PROVIDER, SESSION_MODEL_ID]),
            });
            // 返回的是 { configOptions: [...] }，不是裸数组；两种形状都兜住。
            const list = Array.isArray(result) ? result : (result?.configOptions ?? []);
            const model = list.find?.((o) => o.id === 'model');
            log(`session model set: ${SESSION_MODEL_PROVIDER}/${SESSION_MODEL_ID} (now: ${model?.currentValue ?? 'ok'})`);
        } catch (err) {
            log('session model set failed: ' + err.message);
        }
        acpReady = true;
        tick();
    } catch (err) {
        log('acp connect failed: ' + err.message);
        acpReady = false;
        setTimeout(connectAcp, 5000);
    }
}

// ---------------------------------------------------------------------------
// 攒批与出轮
// ---------------------------------------------------------------------------
const pending = [];
let busy = false;

function renderBatch(batch) {
    const parts = [];
    for (const e of batch) {
        if (e.kind === 'message') {
            parts.push(`[飞书消息] chat_id=${e.chat_id} message_id=${e.message_id} 发件人=${e.sender_id} 时间=${e.time}`);
            parts.push(e.text);
            if (e.thread_id) parts.push(`(话题 thread_id=${e.thread_id} — 想回在这个话题里，就回复这条 message_id 并带 reply_in_thread=true)`);
        } else {
            parts.push(`[卡片回调] chat_id=${e.chat_id} 卡片=${e.message_id} 点击者=${e.open_id} action=${e.action}`);
            parts.push(`value=${JSON.stringify(e.value)} form_value=${JSON.stringify(e.form_value)}`);
        }
        parts.push('');
    }
    return parts.join('\n');
}

function buildPrompt(batch, batchFile) {
    return [
        '（broker）一批飞书事件到了，原文在 ' + batchFile + '，需要的话先读它。',
        '回复必须用 mcp__lark__feishu_im_send 发回飞书：receive_id 用事件里的 chat_id，要串在那条消息下面就把它作为 reply_to。',
        '飞书不渲染 markdown，只发纯文本，话短一点、口语一点。',
        '一批里多个事件一并处理；只是知会、不需要回的就不用发。',
    ].join('\n') + '\n\n' + renderBatch(batch);
}

async function promptTurn(batch) {
    const batchFile = join(RUN_DIR, `batch-${Date.now()}.txt`);
    writeFileSync(batchFile, renderBatch(batch), 'utf8');
    turnText = '';
    turnSentViaTool = false;
    bubble('在听');

    const timer = setTimeout(async () => {
        log(`turn still running after ${TURN_WARN_MS} ms — sending session/cancel`);
        try { await acpCtx?.notify(acp.methods.agent.session.cancel, { sessionId }); } catch { /* best effort */ }
    }, TURN_WARN_MS);

    try {
        await acpCtx.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: buildPrompt(batch, batchFile) }],
        });
    } finally {
        clearTimeout(timer);
    }

    // 兜底发送已按缺月要求删除（2026-09-14）：一轮里没调 feishu_im_send 就什么都不发，
    // 免得把写给自己看的判断当成回复甩进群里。要回就显式发，不回就闭嘴。
    bubble(`结束：${batch.length} 条`);
    log(`turn finished (sentViaTool=${turnSentViaTool}, textLen=${turnText.length})`);
}

async function tick() {
    if (busy || pending.length === 0 || !acpReady) return;
    busy = true;
    const batch = pending.splice(0, pending.length);
    log(`turn start with ${batch.length} event(s)`);
    try {
        await promptTurn(batch);
    } catch (err) {
        log('turn failed: ' + err.message);
    }
    busy = false;
    if (pending.length) tick();
}

function pushEvent(e) {
    pending.push(e);
    if (!acpReady) log(`event queued while acp not ready (${pending.length} pending)`);
    tick();
}

// ---------------------------------------------------------------------------
// 飞书 WS 长连接
// ---------------------------------------------------------------------------
const dispatcher = new lark.EventDispatcher({ logger: quietLogger }).register({
    'im.message.receive_v1': async (data) => {
        try {
            const msg = data?.message;
            if (!msg) return;
            if (data?.sender?.sender_type === 'app') return; // 自己发的，丢掉，免得自回环
            let content = msg.content;
            try { content = JSON.parse(content); } catch { /* 保持字符串 */ }
            const text = typeof content === 'string' ? content : (content?.text ?? JSON.stringify(content));
            log(`message from ${data?.sender?.sender_id?.open_id} in ${msg.chat_id}: ${String(text).slice(0, 200)}`);
            pushEvent({
                kind: 'message',
                chat_id: msg.chat_id,
                message_id: msg.message_id,
                sender_id: data?.sender?.sender_id?.open_id,
                time: new Date(Number(msg.create_time)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                thread_id: msg.thread_id,   // 话题群：消息所属话题（omt_xxx），回复时带上 reply_in_thread=true
                text,
            });
        } catch (err) {
            log('message handler error: ' + err.message);
        }
    },
    'card.action.trigger': async (data) => {
        try {
            const action = data?.action;
            const context = data?.context;
            const event = {
                kind: 'card',
                chat_id: context?.chat_id,
                message_id: context?.open_message_id,
                open_id: data?.operator?.open_id,
                action: action?.value?.action ?? (action?.form_value !== undefined ? 'form_submit' : 'unknown'),
                value: action?.value ?? {},
                form_value: action?.form_value ?? {},
            };
            log('card callback: ' + JSON.stringify(event));
            pushEvent(event);
            return { toast: { type: 'info', content: '正在处理…' } };
        } catch (err) {
            log('card handler error: ' + err.message);
        }
    },
});

const wsClient = new lark.WSClient({ appId: CREDS.appId, appSecret: CREDS.appSecret, logger: quietLogger });

// 卡片回调在 SDK 里以 headers type="card" 下发，默认被丢弃；重映射成 "event" 才会被路由。
const origHandleEventData = wsClient.handleEventData.bind(wsClient);
wsClient.handleEventData = (data) => {
    const msgType = data?.headers?.find?.((h) => h.key === 'type')?.value;
    if (msgType === 'card') {
        return origHandleEventData({
            ...data,
            headers: data.headers.map((h) => (h.key === 'type' ? { ...h, value: 'event' } : h)),
        });
    }
    return origHandleEventData(data);
};

log(`broker v2 starting (appId=${CREDS.appId}, workspace=${WORKSPACE})`);

// 单实例锁：同一个 app 挂两条长连接会抢事件，所以第二个 broker 直接退出。
const LOCK_PORT = 48231;
const lock = createServer();
lock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log(`another broker is already running (port ${LOCK_PORT} busy) — exiting`);
        process.exit(1);
    }
    log('lock server error: ' + err.message);
});
lock.listen(LOCK_PORT, '127.0.0.1', () => {
    log(`single-instance lock held on 127.0.0.1:${LOCK_PORT}`);
    wsClient.start({ eventDispatcher: dispatcher })
        .then(() => log('WS long connection active'))
        .catch((err) => log('WS start failed: ' + err.message));
    cleanupStaleAcpChild();
    connectAcp();
    startControlServer();
});

// 优雅退出：先让 ACP 会话收干净（停稳式取消、drain、flush），再退出。
// 这样下次起 broker 恢复会话更稳；硬杀可能让会话恢复失败、只能另起新的。
let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — closing ACP session before exit`);
    try {
        if (acpCtx && sessionId) {
            await Promise.race([
                acpCtx.request(acp.methods.agent.session.close, { sessionId }),
                new Promise((resolve) => setTimeout(resolve, 8000)),
            ]);
            log('ACP session closed');
        }
    } catch (err) {
        log('session close failed (continuing to exit): ' + err.message);
    }
    try { acpChild?.kill(); } catch { /* best effort */ }
    process.exit(0);
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGBREAK', () => { void shutdown('SIGBREAK'); });

// ---------------------------------------------------------------------------
// 本机控制口：stop-moyu.cmd / status-moyu.cmd 用它，不需要管理员权限。
// 只绑回环，只认这两个路径。
// ---------------------------------------------------------------------------
const CONTROL_PORT = 48233;
function startControlServer() {
    const server = createHttpServer((req, res) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/status') {
            const body = JSON.stringify({
                running: true,
                sessionId,
                acpReady,
                acpChildPid: acpChild?.pid ?? null,
                busy,
                pendingEvents: pending.length,
                uptimeSec: Math.round(process.uptime()),
            }, null, 2);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(body);
            return;
        }
        if (path === '/stop') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('stopping\n');
            setTimeout(() => { void shutdown('control /stop'); }, 200);
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
    });
    server.on('error', (err) => log('control server error: ' + err.message));
    server.listen(CONTROL_PORT, '127.0.0.1', () => log(`control endpoint on 127.0.0.1:${CONTROL_PORT} (/status, /stop)`));
}
