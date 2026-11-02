// 会话服务：管理常驻 CC / Codex 进程（engines.mjs），一个对话（channelId，可以是任意字符串键）一个进程。
// 由插件（index.mjs）按需拉起，和 dsh 进程分开跑，所以 dsh 热重载/重启不会打断正在跑的会话。
// 只监听 127.0.0.1，所有请求要带 Bearer token。接口：
//   POST /send     {channelId, engine, sessionId, cwd, text}  发一条消息（没有进程就起一个；会话 ID 变了就换进程）
//   POST /stop     {channelId}                                 中断正在跑的这一轮
//   POST /close    {channelId}                                 关掉这个对话的进程
//   POST /answer   {id, allow}                                 答复审批
//   POST /shutdown                                             关掉所有进程并退出（插件 stopOnDispose 时用）
//   GET  /status                                               各会话状态
//   GET  /events?boot=..&since=N                               SSE 事件流：session / permission / result
// 事件带递增序号，存在内存里（最近 500 条）；插件重载后带 since 重连就能补上漏掉的事件。
// 环境变量：PA_PORT、PA_TOKEN 或 PA_TOKEN_FILE、PA_IDLE_MIN（会话空闲多久关进程）、PA_TURN_MIN（一轮最长）、
//   PA_EXIT_IDLE_MIN（没有会话也没有订阅者多久后服务自己退出，0 = 不退出）、PA_LOG_FILE（日志另写一份到文件）。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, restartKeys } from './engines.mjs';

const PORT = Number(process.env.PA_PORT ?? 8797);
const IDLE_MIN = Number(process.env.PA_IDLE_MIN ?? 60);
const TURN_MIN = Number(process.env.PA_TURN_MIN ?? 30);
const EXIT_IDLE_MIN = Number(process.env.PA_EXIT_IDLE_MIN ?? 0);
const token = process.env.PA_TOKEN ?? readFileSync(process.env.PA_TOKEN_FILE, 'utf8').trim();
const boot = randomUUID();
const log = (...a) => {
  const line = [new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a].join(' ');
  console.log(line);
  if (process.env.PA_LOG_FILE) try { appendFileSync(process.env.PA_LOG_FILE, `${new Date().toISOString().slice(0, 10)} ${line}\n`); } catch {}
};

// ---- 事件 ----
const events = [];
let seq = 0;
const subscribers = new Set();
// 进度类事件（工具调用）只推给当前订阅者，不进缓冲，免得把结果事件挤出去
function publishLive(ev) {
  const e = { live: true, boot, at: Date.now(), ...ev };
  for (const res of subscribers) res.write(`data: ${JSON.stringify(e)}

`);
}

function publish(ev) {
  const e = { seq: ++seq, boot, at: Date.now(), ...ev };
  events.push(e);
  if (events.length > 500) events.shift();
  for (const res of subscribers) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

// ---- 会话 ----
const sessions = new Map(); // channelId → { s, engine, lastUsed, turnTimer }
const permOwner = new Map(); // 审批 id → channelId

function closeSession(channelId, why) {
  const entry = sessions.get(channelId);
  if (!entry) return false;
  sessions.delete(channelId);
  clearTimeout(entry.turnTimer);
  entry.s.removeAllListeners('exit');
  if (entry.s.busy) publish({ type: 'result', channelId, engine: entry.engine, sessionId: entry.s.sessionId, text: '', error: `会话被关掉了（${why}）` });
  entry.s.close();
  log(`关闭 ${entry.engine} ${channelId}：${why}`);
  return true;
}

async function open(channelId, engine, sessionId, cwd, settings = {}) {
  const cur = sessions.get(channelId);
  // 同一引擎、同一会话（或者调用方没指定会话）、启动参数没变就复用；否则换进程
  if (cur?.s.alive && cur.engine === engine && (!sessionId || sessionId === cur.s.sessionId) && restartKeys(engine, settings) === restartKeys(engine, cur.s.settings)) {
    cur.s.settings = settings;
    return cur;
  }
  if (cur) closeSession(channelId, '换会话/换引擎');
  const s = createSession(engine, { sessionId: sessionId ?? (cur?.engine === engine ? cur.s.sessionId : null), cwd, settings, log: (m) => log(`[${channelId}] ${m}`) });
  const entry = { s, engine, lastUsed: Date.now(), turnTimer: null };
  sessions.set(channelId, entry);
  s.on('session', (id) => publish({ type: 'session', channelId, engine, sessionId: id }));
  s.on('tool', (t) => publishLive({ type: 'tool', channelId, engine, ...t }));
  s.on('permission', (p) => { permOwner.set(p.id, channelId); publish({ type: 'permission', channelId, engine, ...p }); });
  s.on('result', (r) => {
    clearTimeout(entry.turnTimer);
    entry.lastUsed = Date.now();
    log(`${engine} ${channelId} 这一轮结束${r.error ? `：${r.error.slice(0, 200)}` : ''}`);
    // /stop 中断的这一轮：CC 会报 error_during_execution，codex 报 interrupted，统一标成 interrupted、不算出错
    const interrupted = entry.interrupted; entry.interrupted = false;
    publish({ type: 'result', channelId, engine, sessionId: s.sessionId, ...r, ...(interrupted ? { error: null, interrupted: true } : {}) });
  });
  s.on('exit', (reason) => { if (sessions.get(channelId) === entry) sessions.delete(channelId); log(`${engine} ${channelId} ${reason}`); });
  log(`启动 ${engine} ${channelId}${sessionId ? ` --resume ${sessionId}` : '（新会话）'}`);
  try {
    await s.start();
  } catch (e) {
    closeSession(channelId, '启动失败');
    throw e;
  }
  return entry;
}

async function send({ channelId, engine, sessionId, cwd, text, settings }) {
  const cur = sessions.get(channelId);
  if (cur?.s.busy) return { ok: false, busy: true };
  const entry = await open(channelId, engine, sessionId, cwd ?? os.homedir(), settings ?? {});
  entry.lastUsed = Date.now();
  entry.s.send(text);
  clearTimeout(entry.turnTimer);
  entry.turnTimer = setTimeout(() => { log(`${engine} ${channelId} 超过 ${TURN_MIN} 分钟，中断`); try { entry.s.interrupt(); } catch {} }, TURN_MIN * 60_000);
  return { ok: true, sessionId: entry.s.sessionId };
}

// 空闲回收：不在跑的会话超过 IDLE_MIN 分钟就关进程
setInterval(() => {
  for (const [ch, e] of sessions) if (!e.s.busy && Date.now() - e.lastUsed > IDLE_MIN * 60_000) closeSession(ch, `空闲超过 ${IDLE_MIN} 分钟`);
  // 自我回收：没有会话、也没有插件连着超过 EXIT_IDLE_MIN 分钟，就自己退出，不留孤儿进程
  if (EXIT_IDLE_MIN > 0 && !sessions.size && !subscribers.size && Date.now() - lastActive > EXIT_IDLE_MIN * 60_000) {
    log(`没有会话也没有订阅者超过 ${EXIT_IDLE_MIN} 分钟，退出`);
    shutdown();
  }
}, 60_000).unref();
let lastActive = Date.now();

// ---- HTTP ----
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
});

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
  lastActive = Date.now();
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      // 同一次启动里补发 since 之后的；runner 重启过（boot 不同）就把缓存的全补上
      const since = url.searchParams.get('boot') === boot ? Number(url.searchParams.get('since') ?? 0) : 0;
      res.write(`event: hello\ndata: ${JSON.stringify({ boot, seq })}\n\n`);
      for (const e of events) if (e.seq > since) res.write(`data: ${JSON.stringify(e)}\n\n`);
      subscribers.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); subscribers.delete(res); lastActive = Date.now(); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { boot, seq, sessions: [...sessions].map(([channelId, e]) => ({ channelId, engine: e.engine, sessionId: e.s.sessionId, busy: e.s.busy, pid: e.s.child?.pid, idleSec: Math.round((Date.now() - e.lastUsed) / 1000) })) });
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const body = await readBody(req);
    if (url.pathname === '/send') {
      if (!body.channelId || !['cc', 'codex'].includes(body.engine) || typeof body.text !== 'string') return json(res, 400, { error: 'channelId / engine / text' });
      return json(res, 200, await send(body));
    }
    if (url.pathname === '/stop') {
      const e = sessions.get(body.channelId);
      if (!e?.s.busy) return json(res, 200, { ok: false });
      e.interrupted = true;
      e.s.interrupt();
      // 中断后 5 秒还没收尾就直接关进程（会话记录在，下次 --resume）
      setTimeout(() => { if (e.s.busy) closeSession(body.channelId, '中断没响应'); }, 5000);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/shutdown') { json(res, 200, { ok: true }); return shutdown(); }
    if (url.pathname === '/close') return json(res, 200, { ok: closeSession(body.channelId, '调用方要求') });
    if (url.pathname === '/answer') {
      const e = sessions.get(permOwner.get(body.id));
      const ok = Boolean(e?.s.alive && e.s.answer(body.id, Boolean(body.allow)));
      if (ok) permOwner.delete(body.id);
      return json(res, 200, { ok });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log(`请求出错 ${url.pathname}：${e?.stack || e}`);
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
  }
});
server.listen(PORT, '127.0.0.1', () => log(`persistent-agents 会话服务已启动 http://127.0.0.1:${PORT}（空闲 ${IDLE_MIN} 分钟关进程，一轮最长 ${TURN_MIN} 分钟）`));

function shutdown() { for (const ch of [...sessions.keys()]) closeSession(ch, '服务退出'); setTimeout(() => process.exit(0), 300); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
