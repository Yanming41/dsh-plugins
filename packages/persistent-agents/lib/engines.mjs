// 常驻的 CC / Codex 会话（照 cc-connect 的做法）：一个帖子一个进程，进程一直开着，每条消息写进它的 stdin。
//   ClaudeSession —— claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio
//                    消息是一行一个 JSON；权限审批是同一条流里的 control_request / control_response。
//   CodexSession  —— codex app-server：stdio 上的 JSON-RPC，initialize → thread/start|resume → turn/start；
//                    审批是服务端发来的 request（item/*/requestApproval），回 {decision}。
// 两者都是 EventEmitter，事件：
//   'session' (sessionId)                     拿到/换了会话 ID
//   'permission' ({ id, tool, input })        要审批，调 answer(id, allow)
//   'result' ({ text, error })                这一轮结束
//   'exit' (reason)                           进程退出（之后这个对象不能再用）
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.USERPROFILE ?? '';
const npmDir = path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm');

// Windows 上从注册表重新读完整 PATH（系统 + 用户）：拉起服务的宿主（比如 dsh）PATH 可能不全，
// CC / Codex 跑命令时会找不到常用程序。只读一次。
let fullPath;
function windowsPath() {
  if (fullPath !== undefined) return fullPath;
  try {
    const ps = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    fullPath = execFileSync(ps, ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { fullPath = ''; }
  return fullPath;
}

// 子进程环境：去掉从启动者继承的 Claude Code 会话变量（否则新起的 CC 会以为自己是别的会话的子会话），Windows 上补全 PATH
export function cleanEnv(env = process.env) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$)/.test(k)));
  if (process.platform === 'win32' && windowsPath()) {
    const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
    const have = (out[key] ?? '').split(';').filter(Boolean);
    const seen = new Set(have.map((d) => d.toLowerCase()));
    out[key] = [...have, ...windowsPath().split(';').filter((d) => d && !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()))].join(';');
  }
  return out;
}

// 直接用绝对路径起程序，不经过 cmd.exe：claude 是 exe，codex 是 npm 包里的 js（用当前 node 跑）
export function launchSpec(engine) {
  if (engine === 'cc') {
    const exe = [path.join(home, '.local', 'bin', 'claude.exe'), path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')].find(existsSync);
    if (!exe) throw new Error('找不到 claude（~/.local/bin/claude.exe）');
    return exe.endsWith('.js') ? { cmd: process.execPath, pre: [exe] } : { cmd: exe, pre: [] };
  }
  if (engine === 'codex') {
    const js = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!existsSync(js)) throw new Error(`找不到 codex（${js}）`);
    return { cmd: process.execPath, pre: [js] };
  }
  throw new Error(`未知引擎 ${engine}`);
}

class BaseSession extends EventEmitter {
  constructor(engine, { sessionId, cwd, log, settings }) {
    super();
    this.settings = settings ?? {}; // { model, effort, mode }：帖子里 /model /effort /mode 设的
    this.engine = engine;
    this.sessionId = sessionId ?? null;
    this.cwd = cwd;
    this.log = log ?? (() => {});
    this.busy = false;
    this.alive = false;
    this.stderr = '';
  }

  spawnProc(args) {
    const { cmd, pre } = launchSpec(this.engine);
    const child = spawn(cmd, [...pre, ...args], { cwd: this.cwd, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.alive = true;
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      let msg; try { msg = JSON.parse(line); } catch { return; }
      try { this.onMessage(msg); } catch (e) { this.log(`${this.engine}: 处理消息出错 ${e?.stack || e}`); }
    });
    child.on('error', (e) => this.exited(`启动失败：${e.message}`));
    child.on('exit', (code) => this.exited(`进程退出（退出码 ${code}）${this.stderr.trim() ? `：${this.stderr.trim().slice(-800)}` : ''}`));
  }

  exited(reason) {
    if (!this.alive) return;
    this.alive = false;
    if (this.busy) { this.busy = false; this.emit('result', { text: '', error: reason }); }
    this.emit('exit', reason);
  }

  write(obj) {
    if (!this.alive) throw new Error('会话进程已退出');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  finishTurn(result) {
    if (!this.busy) return;
    this.busy = false;
    this.emit('result', result);
  }

  close() {
    if (!this.alive) return;
    try { this.child.stdin.end(); } catch {}
    // Windows 上 kill 不会带走孙进程（MCP 服务器等），用 taskkill /T
    spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

// /mode 的档位 → claude --permission-mode
const CC_MODE = { plan: 'plan', accept: 'acceptEdits', auto: 'acceptEdits', default: 'default' };
// CC 的设置要在启动参数里给，变了就得换进程；Codex 每轮带上，不用换
export const restartKeys = (engine, settings = {}) => (engine === 'cc' ? JSON.stringify([settings.model ?? null, settings.effort ?? null, settings.mode ?? null]) : '');

export class ClaudeSession extends BaseSession {
  constructor(opts) {
    super('cc', opts);
    this.reqSeq = 0;
    this.texts = [];
  }

  async start() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', CC_MODE[this.settings.mode] ?? 'acceptEdits'];
    if (this.settings.model) args.push('--model', this.settings.model);
    if (this.settings.effort) args.push('--settings', JSON.stringify({ effortLevel: this.settings.effort }));
    if (this.sessionId) args.push('--resume', this.sessionId);
    this.spawnProc(args);
  }

  send(text) {
    this.busy = true;
    this.texts = [];
    this.write({ type: 'user', message: { role: 'user', content: text } });
  }

  onMessage(m) {
    if (m.session_id && m.session_id !== this.sessionId) { this.sessionId = m.session_id; this.emit('session', m.session_id); }
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) this.texts.push(c.text.trim());
        else if (c.type === 'tool_use') this.emit('tool', { name: c.name, input: c.input ?? {} }); // 给进度消息用
      }
    } else if (m.type === 'result') {
      const text = String(m.result ?? '').trim() || this.texts.at(-1) || '';
      this.finishTurn({ text, error: m.is_error ? String(m.result || m.subtype || '出错') : null });
    } else if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const id = String(m.request_id);
      this.pendingInput ??= new Map();
      this.pendingInput.set(id, m.request.input ?? {});
      this.emit('permission', { id, tool: m.request.tool_name, input: m.request.input ?? {} });
    }
  }

  answer(id, allow) {
    const input = this.pendingInput?.get(id);
    if (!input) return false;
    this.pendingInput.delete(id);
    const response = allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: '用户在 Discord 上拒绝了这次工具调用。停下来等用户的指示。' };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    return true;
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: `int-${++this.reqSeq}`, request: { subtype: 'interrupt' } });
  }
}

export class CodexSession extends BaseSession {
  constructor(opts) {
    super('codex', opts);
    this.rpcSeq = 0;
    this.calls = new Map();     // 我们发出的请求 id → {resolve, reject}
    this.approvals = new Map(); // 审批 id → 服务端请求的原始 id
    this.texts = [];
    this.turnId = null;
  }

  request(method, params) {
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start() {
    this.spawnProc(['app-server']);
    this.once('exit', (reason) => { for (const c of this.calls.values()) c.reject(new Error(reason)); this.calls.clear(); });
    await this.request('initialize', {
      clientInfo: { name: 'dsh-discord', title: 'dsh-discord', version: '0.1.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['command/exec/outputDelta', 'item/agentMessage/delta', 'item/plan/delta', 'item/fileChange/outputDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'] },
    });
    this.write({ jsonrpc: '2.0', method: 'initialized' });
    const params = { cwd: this.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', experimentalRawEvents: false, persistExtendedHistory: false };
    let resp;
    if (this.sessionId) {
      try { resp = await this.request('thread/resume', { ...params, threadId: this.sessionId }); } catch (e) { this.log(`codex: 恢复 ${this.sessionId} 失败，开新会话：${e.message}`); }
    }
    resp ??= await this.request('thread/start', params);
    const id = resp?.thread?.id;
    if (!id) throw new Error('codex app-server 没返回 thread id');
    if (id !== this.sessionId) { this.sessionId = id; this.emit('session', id); }
  }

  send(text) {
    this.busy = true;
    this.texts = [];
    const { model, effort } = this.settings;
    this.request('turn/start', { threadId: this.sessionId, input: [{ type: 'text', text, text_elements: [] }], approvalPolicy: 'on-request', ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
      .then((r) => { this.turnId = r?.turn?.id ?? this.turnId; })
      .catch((e) => this.finishTurn({ text: '', error: `turn/start 失败：${e.message}` }));
  }

  onMessage(m) {
    if (m.id != null && !m.method) { // 我们请求的回复
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.error) c.reject(new Error(m.error.message ?? JSON.stringify(m.error))); else c.resolve(m.result);
      return;
    }
    if (m.id != null && m.method) return this.onServerRequest(m);
    const p = m.params ?? {};
    switch (m.method) {
      case 'turn/started': this.turnId = p.turn?.id ?? this.turnId; break;
      case 'item/started': { // 给进度消息用
        const it = p.item ?? {};
        if (it.type === 'commandExecution') this.emit('tool', { name: '命令', input: { command: it.command } });
        else if (it.type === 'fileChange') this.emit('tool', { name: '改文件', input: { path: (it.changes ?? []).map((c) => c.path).join(', ') } });
        else if (it.type === 'mcpToolCall') this.emit('tool', { name: `MCP ${it.server ?? ''}`.trim(), input: { description: it.tool } });
        else if (it.type === 'webSearch') this.emit('tool', { name: '搜索', input: { query: it.query } });
        break;
      }
      case 'item/completed':
        if (p.item?.type === 'agentMessage' && p.item.text?.trim()) this.texts.push(p.item.text.trim());
        break;
      case 'turn/completed': {
        const failed = p.turn?.status === 'failed' || p.turn?.error;
        this.finishTurn({ text: this.texts.join('\n\n'), error: failed ? (p.turn?.error?.message || '这一轮失败了') : null });
        break;
      }
      case 'error':
        if (p.message && !p.willRetry) this.log(`codex: ${p.message}`);
        break;
    }
  }

  onServerRequest(m) {
    const p = m.params ?? {};
    let tool, input;
    if (m.method === 'item/commandExecution/requestApproval') { tool = 'Shell 命令'; input = { command: p.command, cwd: p.cwd, reason: p.reason }; }
    else if (m.method === 'item/fileChange/requestApproval') { tool = '改文件'; input = { reason: p.reason, grantRoot: p.grantRoot }; }
    else if (m.method === 'item/permissions/requestApproval') { tool = '提升权限'; input = p; }
    else return this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
    const id = `cx${m.id}`;
    this.approvals.set(id, { rpcId: m.id, method: m.method, params: p });
    this.emit('permission', { id, tool, input });
  }

  answer(id, allow) {
    const a = this.approvals.get(id);
    if (!a) return false;
    this.approvals.delete(id);
    const result = a.method === 'item/permissions/requestApproval'
      ? (allow ? { permissions: a.params.permissions ?? {}, scope: 'turn' } : { permissions: {}, scope: 'turn' })
      : { decision: allow ? 'accept' : 'decline' };
    this.write({ jsonrpc: '2.0', id: a.rpcId, result });
    return true;
  }

  interrupt() {
    if (this.turnId) this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch((e) => this.log(`codex: 中断失败 ${e.message}`));
  }
}

export function createSession(engine, opts) {
  if (engine === 'cc') return new ClaudeSession(opts);
  if (engine === 'codex') return new CodexSession(opts);
  throw new Error(`未知引擎 ${engine}`);
}
