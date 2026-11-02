// dsh 插件 persistent-agents：常驻的 Claude Code / Codex 会话，提供 ctx.persistentAgents。
// 每个对话（channelId，任意字符串键）一个常驻进程：CC 走 stream-json + stdio 权限，Codex 走 app-server，消息直接写进去，不用每轮冷启动。
//
// 进程模型：会话进程归独立的会话服务（server.mjs）管，插件只是它的客户端。插件载入时服务没在跑就自己拉起（detached，
// 和 dsh 进程分开），所以插件热重载、dsh 重启都不会打断正在跑的会话；插件卸载时只断开连接、停止订阅。
// 服务是外部资源（类似数据库连接）：exitIdleMin 分钟内没有会话也没有插件连着，它会自己退出；
// 要严格随插件生灭就开 stopOnDispose，卸载时连服务一起关掉。
//
// 事件（session / permission / result）走服务的 SSE 流，带序号；插件重载后带序号重连，漏掉的事件会补发。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const name = 'persistent-agents';

export const defaults = {
  port: 8797,
  stateDir: path.join(os.homedir(), '.dsh-persistent-agents'),
  window: false,      // Windows 上在可见的独立终端窗口里跑服务（关窗口 = 停服务）；否则后台跑，日志写 stateDir/server.log
  stopOnDispose: false,
  idleMin: 60,        // 会话空闲多久关进程（会话记录还在，下次 --resume / thread/resume）
  turnMin: 30,        // 一轮最长跑多久，超时中断
  exitIdleMin: 30,    // 服务没有会话也没有订阅者多久后自己退出；0 = 一直跑
  cwd: os.homedir(),  // 新会话的默认工作目录
};

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, v) => { writeFileSync(`${file}.tmp`, JSON.stringify(v)); renameSync(`${file}.tmp`, file); };
const refused = (e) => /ECONNREFUSED|fetch failed/.test(String(e?.cause?.code ?? e?.message ?? e));

export function apply(ctx, options = {}) {
  const config = { ...defaults, ...options };
  mkdirSync(config.stateDir, { recursive: true });
  const tokenFile = path.join(config.stateDir, 'token');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const token = readFileSync(tokenFile, 'utf8').trim();
  const cursorFile = path.join(config.stateDir, 'cursor.json');
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const serverScript = fileURLToPath(new URL('./server.mjs', import.meta.url));
  const listeners = { session: new Set(), permission: new Set(), result: new Set(), tool: new Set() };
  const busy = new Map(); // channelId → { engine, channelId, startedAt }
  const emit = (type, ...args) => { for (const fn of listeners[type]) Promise.resolve().then(() => fn(...args)).catch((e) => ctx.logger.error(`persistent-agents listener: ${e?.stack || e}`)); };
  const on = (type) => (fn) => { listeners[type].add(fn); return () => listeners[type].delete(fn); };

  const call = async (p, body) => {
    const r = await fetch(base + p, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`persistent-agents ${p} HTTP ${r.status}：${await r.text()}`);
    return r.json();
  };

  // ---- 拉起服务 ----
  let lastLaunch = 0;
  function launch() {
    if (Date.now() - lastLaunch < 60_000) return;
    lastLaunch = Date.now();
    const env = {
      ...process.env,
      PA_PORT: String(config.port), PA_TOKEN_FILE: tokenFile,
      PA_IDLE_MIN: String(config.idleMin), PA_TURN_MIN: String(config.turnMin), PA_EXIT_IDLE_MIN: String(config.exitIdleMin),
      PA_LOG_FILE: path.join(config.stateDir, 'server.log'),
    };
    let child;
    if (config.window && process.platform === 'win32') {
      // 可见的独立窗口：conhost 托管（不进 Windows Terminal 标签页），关掉窗口 = 停服务。
      // conhost 直接当子进程起会立刻退出，所以写一个 .cmd 启动器（PA_* 配置写在里面，token 只写文件路径），再用 PowerShell Start-Process 打开
      const launcher = path.join(config.stateDir, 'launch.cmd');
      const sets = Object.entries(env).filter(([k]) => k.startsWith('PA_')).map(([k, v]) => `set "${k}=${v}"`);
      writeFileSync(launcher, ['@echo off', 'title persistent-agents', ...sets, `"${process.execPath}" "${serverScript}"`, ''].join('\r\n'));
      const ps = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      child = spawn(ps, ['-NoProfile', '-Command', `Start-Process conhost.exe -ArgumentList 'cmd.exe /k ""${launcher}""'`], { env, stdio: 'ignore', windowsHide: true }); // 别 detached：没有控制台的 PowerShell 起不来窗口；窗口由 Start-Process 打开，本来就和 dsh 无关
    } else {
      child = spawn(process.execPath, [serverScript], { env, detached: true, stdio: 'ignore', windowsHide: true });
    }
    child.on('error', (e) => ctx.logger.error(`persistent-agents: 拉起会话服务失败 ${e.message}`));
    child.unref();
    ctx.logger.info(`persistent-agents: 会话服务没在跑，已拉起（${config.window ? '可见窗口' : '后台'}，:${config.port}）`);
  }

  // ---- 事件 ----
  function onEvent(e) {
    if (e.live) { if (e.type === 'tool') emit('tool', e); return; } // 不进游标，断线重连后不补
    const cursor = readJson(cursorFile);
    if (cursor?.boot === e.boot && e.seq <= cursor.seq) return; // 已经处理过
    writeJson(cursorFile, { boot: e.boot, seq: e.seq });
    if (e.type === 'session') emit('session', e);
    else if (e.type === 'permission') emit('permission', e);
    else if (e.type === 'result') {
      busy.delete(e.channelId);
      emit('result', { engine: e.engine, channelId: e.channelId }, { text: e.text, error: e.error, sessionId: e.sessionId, interrupted: e.interrupted });
    }
  }

  // SSE 订阅循环，断了就重连；插件卸载时 abort
  ctx.effect(() => {
    const ac = new AbortController();
    (async () => {
      while (!ac.signal.aborted) {
        try {
          const cursor = readJson(cursorFile) ?? {};
          const r = await fetch(`${base}/events?boot=${cursor.boot ?? ''}&since=${cursor.seq ?? 0}`, { headers, signal: ac.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          // 连上后对一下哪些对话还在跑（重载前发出去的消息）
          const st = await call('/status');
          for (const ch of [...busy.keys()]) if (!st.sessions.some((s) => s.channelId === ch && s.busy)) busy.delete(ch);
          for (const s of st.sessions) if (s.busy && !busy.has(s.channelId)) busy.set(s.channelId, { engine: s.engine, channelId: s.channelId });
          const dec = new TextDecoder();
          let buf = '';
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              if (block.startsWith('event:')) continue;
              const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
              if (data) { try { onEvent(JSON.parse(data)); } catch (e) { ctx.logger.error(`persistent-agents: 事件处理失败 ${e?.stack || e}`); } }
            }
          }
        } catch (e) {
          if (ac.signal.aborted) return;
          if (refused(e)) launch(); else ctx.logger.warn(`persistent-agents: 事件流断开 ${e?.message || e}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      ac.abort();
      if (config.stopOnDispose) call('/shutdown', {}).catch(() => {});
    };
  });

  ctx.provide('persistentAgents', {
    engines: ['cc', 'codex'],
    /** 正在跑的对话（每个对话最多一轮） */
    pending: () => [...busy.values()],
    /** 发一条消息；没有进程就起一个，sessionId 变了就换进程。结果从 onResult 回来 */
    async start({ engine, channelId, prompt, sessionId, cwd, settings }) {
      busy.set(channelId, { engine, channelId, startedAt: Date.now() });
      try {
        const r = await call('/send', { channelId, engine, sessionId: sessionId ?? null, cwd: cwd ?? config.cwd, text: prompt, settings: settings ?? {} });
        if (!r.ok) throw new Error(r.busy ? '上一轮还没跑完' : '发送失败');
        return r;
      } catch (e) {
        busy.delete(channelId);
        if (refused(e)) { launch(); throw new Error('会话服务没在跑，已尝试拉起，过几秒再发一次'); }
        throw e;
      }
    },
    /** 中断正在跑的这一轮；返回有没有中断 */
    async stop(channelId) { return (await call('/stop', { channelId })).ok; },
    /** 关掉这个对话的常驻进程（换新会话时用） */
    async close(channelId) { return (await call('/close', { channelId })).ok; },
    /** 各会话状态 */
    status: () => call('/status'),
    onResult: on('result'),
    onPermission: on('permission'),
    /** 工具调用进度：fn({ channelId, engine, name, input })；只推实时的，断线期间的不补 */
    onTool: on('tool'),
    onSession: on('session'),
    /** 答复审批；请求已经结束时返回 false */
    async answer(id, allow) { return (await call('/answer', { id, allow })).ok; },
  });
}
