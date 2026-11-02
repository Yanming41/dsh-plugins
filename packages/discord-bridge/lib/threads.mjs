// threads 插件：把 discord 插件放行的帖子消息接到 Agent。每个帖子选一个引擎：
//   dsh   —— dsh 自己的 Agent（进程内，turn/end 时把回复发回帖子）
//   cc / codex —— 交给 persistent-agents 插件（packages/persistent-agents），每帖一个常驻 Claude Code / Codex 进程
// 帖子状态存在 state/threads.json：{ engine, dsh, cc, codex }（后三个是各引擎的会话 ID），旧格式(字符串)自动迁移。
// 共享上下文：每个帖子的对话记在 state/context/<帖子>.jsonl；切换引擎后，新引擎第一轮会带上
// 它没看到的、其他引擎在这个帖子里的对话（截到最近一段），不用你再复述。
// 帖子里的命令（也有斜杠命令版）：/agent [dsh|cc|codex] 查看/切换引擎；/new 给当前引擎开新会话；
// /stop 中止正在跑的一轮；/reload <插件id> 手动重载某个插件。
// 路由：消息里 @ 了某个 agent 的 bot（discord 插件的 agentBots），就交给它，并让它成为这个帖子的默认引擎；
// 没 @ 就交给当前默认引擎。一次只派给一个（@ 了多个只取第一个，不让两个 agent 同时做同一件事）。
// 回复、按钮、正在输入都用对应 agent 的身份发（没配身份就用主 bot）。agent 的回复走 sendReply：```choices 变选项按钮，代码块加「📋 复制」。
// 对外提供 ctx.threads.submit(channelId, text)：tars 回报之类的系统消息走这里，和用户消息同样处理。
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm';
import { apiTokenFile, JsonStore, stateDir as defaultStateDir } from './store.mjs';
import { bumpRev } from './reload.mjs';
import { ENGINES } from './adapters.mjs';
import { HELP, LOBBY_COMMAND } from './commands.mjs';
import { diffDelta, readWorkspaceDiffStats, validationKinds } from './workspace_diff.mjs';
import { syncCodexAgents } from './codex_agents.mjs';
import os from 'node:os';

export const name = 'threads';
export const inject = ['discord', 'agents', 'sessions', 'persistentAgents'];

const LABEL = { dsh: 'dsh Agent', cc: 'Claude Code', codex: 'Codex' };
const CONTEXT_CHARS = 6000; // 切换引擎时最多补这么多字的别家对话

export function apply(ctx, config = {}) {
  const stateDir = defaultStateDir();
  const owner = config.ownerName ?? '用户';
  const tokenPath = apiTokenFile(config).split(path.sep).join('/');
  const store = new JsonStore(stateDir, 'threads.json');
  const contextDir = path.join(stateDir, 'context');
  mkdirSync(contextDir, { recursive: true });
  const agentOptions = { provider: config.provider ?? 'deepseek-official', model: config.model ?? 'deepseek-flash' };
  const cwd = config.cwd ?? process.cwd();
  const apiPort = config.apiPort ?? 8796;
  const turns = new Map(); // dsh sessionId → { channelId, texts: [] }
  // Codex 和 CC 读同一份全局说明：~/.claude/CLAUDE.md 同步成 ~/.codex/AGENTS.md
  if (config.syncCodexAgents) {
    try {
      const r = syncCodexAgents({ owner, claudeMd: path.join(os.homedir(), '.claude', 'CLAUDE.md'), codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
      if (r.written) ctx.logger.info('threads: 已把 CLAUDE.md 同步到 Codex 的 AGENTS.md');
    } catch (e) { ctx.logger.warn(`threads: 同步 AGENTS.md 失败 ${e?.message || e}`); }
  }

  const stateOf = (channelId) => {
    const raw = store.get(channelId);
    if (typeof raw === 'string') return { engine: 'dsh', dsh: raw };
    return raw ?? { engine: config.defaultEngine ?? 'dsh' };
  };
  const save = (channelId, patch) => store.set(channelId, { ...stateOf(channelId), ...patch });

  // ---- 共享上下文 ----
  const contextFile = (channelId) => path.join(contextDir, `${channelId}.jsonl`);
  const record = (channelId, engine, role, text) => {
    if (text?.trim()) appendFileSync(contextFile(channelId), `${JSON.stringify({ at: Date.now(), engine, role, text: text.trim() })}\n`);
  };
  // engine 上一次参与之后，别的引擎在这个帖子里的对话
  function missedContext(channelId, engine) {
    let rows;
    try { rows = readFileSync(contextFile(channelId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return ''; }
    let last = -1;
    rows.forEach((r, i) => { if (r.engine === engine) last = i; });
    const missed = rows.slice(last + 1).filter((r) => r.engine !== engine);
    if (!missed.length) return '';
    let text = '';
    for (const r of missed.reverse()) {
      const line = `${r.role === 'user' ? owner : LABEL[r.engine]}：${r.text}\n`;
      if (text.length + line.length > CONTEXT_CHARS) { text = `…（更早的省略）\n${text}`; break; }
      text = line + text;
    }
    return `[这个帖子里你没看到的、其他引擎(${[...new Set(missed.map((r) => LABEL[r.engine]))].join('、')})的对话，供参考]\n${text}[以上是历史，下面是新消息]\n\n`;
  }

  // CC/Codex 的桥接提示：帖子 ID、发文件接口、tars 回报怎么接
  const bridgeHint = (channelId) => `[桥接提示：你在 Discord 帖子 ${channelId} 里，经由 dsh-discord 对话；你的最终文字回复会发回帖子。`
    + `要发本机文件/图片到帖子：curl -s http://127.0.0.1:${apiPort}/send_file -H "Authorization: Bearer $(cat ${tokenPath})" -H "Content-Type: application/json" -d '{"thread_id":"${channelId}","note":"说明","paths":["C:/path/a.png"]}'。`
    + (config.extraHint ?? '').replaceAll('{channelId}', channelId) // 自己环境里的额外说明，{channelId} 换成帖子 ID
    + `要${owner}拍板时在回复末尾加 \`\`\`choices 代码块（每行「按钮文字 | 点了以后作为${owner}的话发出的完整句子」），会变成按钮；可能要复制的命令、路径等单独放进 \`\`\` 代码块，会出现「📋 复制」按钮。]\n\n`;

  // ---- dsh 引擎 ----
  ctx.on('session/event', (session, event) => {
    const turn = turns.get(String(session?.id));
    if (!turn) return;
    if (event.type === 'assistant/message') {
      let text = '';
      for (const { chunk } of expandAssistantStream(event.data.stream)) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type?.startsWith('tool-call') && (chunk.name || chunk.toolCallName)) noteTool(turn.channelId, chunk.name || chunk.toolCallName, chunk.arguments);
      }
      if (text.trim()) turn.texts.push(text.trim());
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason;
      const reply = turn.texts.join('\n\n');
      const body = reply || (reason?.kind === 'error' ? `⚠️ 这一轮出错了：${reason.error?.message ?? '未知错误'}` : '(没有文字回复)');
      turn.texts = [];
      record(turn.channelId, 'dsh', 'assistant', reply);
      dshBusy.delete(turn.channelId);
      endStatus(turn.channelId, reason?.kind === 'error' ? 'error' : ['cancelled', 'aborted', 'user'].includes(reason?.kind) ? 'stopped' : 'done', reason?.error?.message);
      ctx.discord.sendReply(turn.channelId, body, { as: 'dsh' })
        .catch((e) => ctx.logger.error(`threads: 发送失败 ${e?.message || e}`))
        .finally(() => drain(turn.channelId));
    }
  });

  async function agentFor(channelId, { fresh = false } = {}) {
    let sessionId = fresh ? null : stateOf(channelId).dsh;
    let agent = sessionId ? ctx.agents.get(sessionId) : null;
    if (!agent && sessionId) {
      try {
        agent = (await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })).agent;
      } catch (e) {
        ctx.logger.warn(`threads: 恢复会话 ${sessionId} 失败，改开新会话：${e?.message || e}`);
      }
    }
    if (!agent) {
      sessionId = randomUUID();
      agent = (await ctx.agents.create({ sessionId, agentOptions, meta: { cwd, title: `discord ${channelId}` } })).agent;
      save(channelId, { dsh: sessionId });
    }
    turns.set(String(agent.session?.id ?? sessionId), turns.get(String(sessionId)) ?? { channelId, texts: [] });
    return agent;
  }

  // ---- cc / codex 引擎：结果由 persistent-agents 回调 ----
  ctx.effect(() => ctx.persistentAgents.onSession((e) => save(e.channelId, { [e.engine]: e.sessionId })));
  ctx.effect(() => ctx.persistentAgents.onResult(async (job, result) => {
    if (result.sessionId) save(job.channelId, { [job.engine]: result.sessionId });
    record(job.channelId, job.engine, 'assistant', result.text);
    await endStatus(job.channelId, result.interrupted ? 'stopped' : result.error ? 'error' : 'done', result.error);
    if (result.interrupted && !result.text?.trim()) return; // /stop 那边已经回过"已中止"了
    const body = result.text?.trim() || (result.error ? `⚠️ ${LABEL[job.engine]} 出错了：${result.error}` : '(没有文字回复)');
    await ctx.discord.sendReply(job.channelId, body, { as: job.engine })
      .finally(() => drain(job.channelId));
  }));
  // 被 /stop 中止且没有文字的那一轮上面提前 return 了，也要放下一条
  ctx.effect(() => ctx.persistentAgents.onResult((job, result) => { if (result.interrupted && !result.text?.trim()) drain(job.channelId); }));

  // ---- 状态展示：你的消息上 👀 收到 → ⏳ 在跑 → ✅ 完成 / ⏹️ 中止 / ❌ 出错；
  // 跑的时候一条进度消息原地刷新（已用时间、最近的工具调用）；论坛帖子的标签在 进行中 / 等待中 之间切换 ----
  const PROGRESS_EDIT_MS = 5000;
  const live = new Map(); // channelId → { engine, messageId, progressId, started, tools, timer, shown }
  const elapsed = (ms) => { const sec = Math.round(ms / 1000); return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`; };
  const describeTool = (name, input) => {
    let i = input;
    if (typeof i === 'string') { try { i = JSON.parse(i); } catch { i = {}; } }
    i ??= {};
    let arg = i.file_path ? path.basename(String(i.file_path)) : i.command || i.pattern || i.url || i.query || i.description || i.path || '';
    arg = String(Array.isArray(arg) ? arg.join(' ') : arg).replace(/\s+/g, ' ').replace(/`/g, "'").slice(0, 80);
    return arg ? `${name}: ${arg}` : String(name);
  };
  const progressText = (st) => `⏳ ${LABEL[st.engine]} 工作中 · 已用 ${elapsed(Date.now() - st.started)}\n`
    + (st.tools.length ? st.tools.slice(-5).map((t) => `• \`${t}\``).join('\n') : '思考中…');
  function noteTool(channelId, name, input) {
    const st = live.get(channelId);
    if (!st) return;
    st.tools.push(describeTool(name, input));
    let i = input;
    if (typeof i === 'string') { try { i = JSON.parse(i); } catch { i = {}; } }
    for (const k of validationKinds(i?.command)) st.checks.add(k);
  }
  // 完成行的补充：这一轮在工作目录里改了多少（git）、跑过哪些验证
  const summary = (st) => [
    st.delta && `改动 ${st.delta.files ? `${st.delta.files} 个新文件 ` : ''}+${st.delta.additions} −${st.delta.deletions}`,
    st.checks.size && `跑了${[...st.checks].join('、')}`,
  ].filter(Boolean).map((s) => ` · ${s}`).join('');
  ctx.effect(() => ctx.persistentAgents.onTool?.((e) => noteTool(e.channelId, e.name, e.input)) ?? (() => {}));

  async function startStatus(channelId, item) {
    const as = item.engine;
    await ctx.discord.react(channelId, item.messageId, '👀', { as, remove: true });
    await ctx.discord.react(channelId, item.messageId, '⏳', { as });
    ctx.discord.setStatusTag(channelId, '进行中');
    const st = { engine: as, messageId: item.messageId, started: Date.now(), tools: [], checks: new Set(), shown: '' };
    live.set(channelId, st);
    st.before = readWorkspaceDiffStats(stateOf(channelId).cwd ?? cwd);
    st.progressId = (await ctx.discord.send(channelId, `⏳ ${LABEL[as]} 收到，准备中…`, { as, silent: true }).catch(() => []))[0];
    st.timer = setInterval(() => {
      const text = progressText(st);
      if (!st.progressId || text === st.shown) return;
      st.shown = text;
      ctx.discord.edit(channelId, st.progressId, text, { as }).catch(() => {});
    }, PROGRESS_EDIT_MS);
    st.timer.unref?.();
  }
  async function endStatus(channelId, kind, error) {
    const st = live.get(channelId);
    if (!st) return;
    live.delete(channelId);
    clearInterval(st.timer);
    const took = elapsed(Date.now() - st.started);
    if (st.tools.length) st.delta = diffDelta(await st.before, await readWorkspaceDiffStats(stateOf(channelId).cwd ?? cwd));
    const line = kind === 'done' ? `✅ 完成 · 用时 ${took} · 工具调用 ${st.tools.length} 次${summary(st)}`
      : kind === 'stopped' ? `⏹ 已中止 · 用时 ${took} · 工具调用 ${st.tools.length} 次${summary(st)}`
        : `❌ 出错：${String(error ?? '未知错误').slice(0, 300)}`;
    if (st.progressId) await ctx.discord.edit(channelId, st.progressId, line, { as: st.engine }).catch(() => {});
    await ctx.discord.react(channelId, st.messageId, '⏳', { as: st.engine, remove: true });
    await ctx.discord.react(channelId, st.messageId, kind === 'done' ? '✅' : kind === 'stopped' ? '⏹️' : '❌', { as: st.engine });
    if (!queued(channelId).length) ctx.discord.setStatusTag(channelId, '等待中');
  }
  ctx.effect(() => () => { for (const st of live.values()) clearInterval(st.timer); });

  // ---- 工作区锁：每个帖子同一时间只有一个 agent 在跑（dsh / CC / Codex 都算）----
  // 忙的时候来的消息不拒绝，按顺序排队（存 state/queue.json，重启不丢）；上一轮结束自动发下一条，
  // 发的时候才算"切换引擎时补的上下文"，所以排在后面的 agent 能看到前一个 agent 这一轮的回复。
  const dshBusy = new Map(); // channelId → 发出时间
  const queue = new JsonStore(stateDir, 'queue.json');
  const queued = (channelId) => queue.get(channelId) ?? [];
  const dshRunning = (channelId) => {
    if (!dshBusy.has(channelId)) return false;
    const agent = stateOf(channelId).dsh ? ctx.agents.get(stateOf(channelId).dsh) : null;
    // 刚 followup 时状态可能还没变成 running；之后状态不是 running 又没收到 turn/end，就当它已经结束
    if (agent?.status === 'running' || Date.now() - dshBusy.get(channelId) < 5000) return true;
    dshBusy.delete(channelId);
    return false;
  };
  const claimed = new Set(); // 已决定发出、引擎还没标上忙碌的那一小段时间（防两条消息同时进来都以为空闲）
  const isBusy = (channelId) => claimed.has(channelId) || dshRunning(channelId) || ctx.persistentAgents.pending().some((j) => j.channelId === channelId);

  async function dispatch(channelId, item) {
    claimed.add(channelId);
    try {
      const missed = missedContext(channelId, item.engine);
      record(channelId, item.engine, 'user', item.text);
      if (item.engine === 'dsh') dshBusy.set(channelId, Date.now());
      await startStatus(channelId, item);
      await ctx.discord.typing(channelId, { as: item.engine });
      if (item.engine === 'dsh') {
        const agent = await agentFor(channelId);
        dshBusy.set(channelId, Date.now());
        agent.followup(createUserMessage({ content: [{ type: 'text', text: missed + item.text }], source: { kind: 'user' } }));
        return;
      }
      const s = stateOf(channelId);
      await ctx.persistentAgents.start({
        engine: item.engine,
        channelId,
        prompt: item.raw ? item.text : bridgeHint(channelId) + missed + item.text, // 自带命令不能加前缀，否则 CC 不认
        sessionId: s[item.engine],
        cwd: s.cwd ?? cwd,
        settings: s.settings?.[item.engine] ?? {},
      });
    } finally {
      claimed.delete(channelId);
    }
  }

  // 帖子空闲时把排队的下一条发出去
  const draining = new Set();
  async function drain(channelId) {
    if (draining.has(channelId)) return;
    draining.add(channelId);
    try {
      while (queued(channelId).length && !isBusy(channelId)) {
        const [item, ...rest] = queued(channelId);
        queue.set(channelId, rest);
        try {
          await dispatch(channelId, item);
          return;
        } catch (e) {
          dshBusy.delete(channelId);
          if (/上一轮还没跑完/.test(e?.message)) { // 重启后忙碌状态还没同步过来：放回队首，稍后再试
            queue.set(channelId, [item, ...queued(channelId)]);
            setTimeout(() => drain(channelId), 3000);
            return;
          }
          await endStatus(channelId, 'error', `没发出去：${e?.message || e}`);
        }
      }
    } finally {
      draining.delete(channelId);
    }
  }
  // 启动时把上次没发完的队列接着发（等 persistent-agents 同步完忙碌状态）
  ctx.effect(() => {
    const t = setTimeout(() => { for (const ch of Object.keys(queue.data)) drain(ch); }, 5000);
    return () => clearTimeout(t);
  });

  // ---- 权限审批按钮（CC）----
  ctx.effect(() => ctx.persistentAgents.onPermission(async (req) => {
    const input = JSON.stringify(req.input ?? {}, null, 1);
    const text = `🔐 ${LABEL[req.engine] ?? 'Agent'} 想用 **${req.tool}**：\n\`\`\`\n${input.slice(0, 1500)}\n\`\`\``;
    await ctx.discord.sendButtons(req.channelId, text, [
      { id: `dsh:perm:${req.id}:allow`, label: '允许', style: 'success' },
      { id: `dsh:perm:${req.id}:deny`, label: '拒绝', style: 'danger' },
    ], { as: req.engine });
  }));
  ctx.effect(() => ctx.discord.onButton(async (ev) => {
    const m = ev.customId.match(/^dsh:perm:(.+):(allow|deny)$/);
    if (!m) return;
    const ok = await ctx.persistentAgents.answer(m[1], m[2] === 'allow').catch(() => false);
    await ev.done(ok ? (m[2] === 'allow' ? '✅ 已允许' : '🙅 已拒绝') : '⌛ 这个请求已经超时或结束了');
  }));

  // ---- 消息入口 ----
  async function handle(channelId, text, attachments = [], agents = [], messageId = null) {
    if (/^\/todo\b/.test(text) || LOBBY_COMMAND.test(text)) return; // 归 todo-agent / lobby 插件处理
    let state = stateOf(channelId);
    const say = (body) => ctx.discord.send(channelId, body, { as: state.engine });

    // @ 路由
    const target = agents.find((a) => ENGINES.includes(a));
    if (target && target !== state.engine) { save(channelId, { engine: target }); state = stateOf(channelId); }
    if (agents.length > 1) await say(`👉 一次只派给一个 agent，这条交给 ${LABEL[state.engine]}`);
    if (target && !text) return say(`👋 ${LABEL[state.engine]} 在，这个帖子之后默认由我回复`);

    const agentCmd = text.match(/^\/agent(?:\s+(\w+))?$/);
    if (agentCmd) {
      const want = agentCmd[1]?.toLowerCase();
      if (!want) return say(`当前引擎：${LABEL[state.engine]}。可选：${ENGINES.join(' / ')}`);
      if (!ENGINES.includes(want)) return say(`没有引擎 ${want}，可选：${ENGINES.join(' / ')}`);
      save(channelId, { engine: want });
      return ctx.discord.send(channelId, `🔀 已切到 ${LABEL[want]}${state[want] ? '（接着它上次的会话，会补上切换期间的对话）' : '（新会话）'}`, { as: want });
    }
    if (text === '/new' || text === '/clear') {
      if (state.engine === 'dsh') await agentFor(channelId, { fresh: true });
      else { save(channelId, { [state.engine]: null }); await ctx.persistentAgents.close(channelId).catch(() => {}); }
      return say(`🆕 ${LABEL[state.engine]} 已开新会话`);
    }
    if (text === '/stop') {
      // 停正在跑的那个（不一定是当前默认引擎），排队的一起清掉
      const dropped = queued(channelId).length;
      queue.set(channelId, []);
      const note = dropped ? `，排队的 ${dropped} 条已清掉` : '';
      if (dshRunning(channelId)) {
        ctx.agents.get(state.dsh)?.cancel({ kind: 'user' });
        return say(`⏹️ 已中止 dsh Agent 这一轮${note}`);
      }
      const job = ctx.persistentAgents.pending().find((j) => j.channelId === channelId);
      const n = job && await ctx.persistentAgents.stop(channelId).catch(() => false);
      return say(n ? `⏹️ 已中止 ${LABEL[job.engine]} 正在跑的这一轮${note}` : `这个帖子现在没有在跑的任务${note}`);
    }
    if (/^\/help\b/.test(text)) return say(HELP);
    if (text === '/screen') { const st = live.get(channelId); return say(st ? progressText(st) : `🟢 ${LABEL[state.engine]} 空闲${queued(channelId).length ? `，排队 ${queued(channelId).length} 条` : ''}`); }
    if (text === '/end') {
      const ok = state.engine !== 'dsh' && await ctx.persistentAgents.close(channelId).catch(() => false);
      return say(ok ? `🔚 ${LABEL[state.engine]} 进程已关，对话记录还在，下条消息会接着原来的会话` : '现在没有在跑的进程');
    }
    // /model /effort /mode：记在帖子状态里，CC 换进程生效（会话不变），Codex 下一轮生效
    const setting = text.match(/^\/(model|effort|mode)(?:\s+(\S+))?$/);
    if (setting) {
      const [, key, value] = setting;
      if (state.engine === 'dsh') return say(`dsh Agent 不支持 /${key}（模型在 discord.patch.yml 里配）`);
      const all = state.settings ?? {};
      const cur = all[state.engine] ?? {};
      if (!value) return say(`${LABEL[state.engine]} 当前 ${key}：${cur[key] ?? '默认'}${key === 'mode' ? '（可选 plan / accept / auto / default）' : ''}`);
      if (key === 'mode' && !['plan', 'accept', 'auto', 'default'].includes(value)) return say('mode 可选：plan / accept / auto / default');
      save(channelId, { settings: { ...all, [state.engine]: { ...cur, [key]: value === 'default' && key !== 'mode' ? undefined : value } } });
      return say(`⚙️ ${LABEL[state.engine]} 的 ${key} 改成 ${value}，下一条消息起生效`);
    }
    // 原样交给 CC 的自带命令（结果作为回复发回来）
    const native = text.match(/^\/(compact|context|cost)\b/);
    if (native && state.engine !== 'cc') return say(`/${native[1]} 只有 Claude Code 支持，当前是 ${LABEL[state.engine]}`);
    const reload = text.match(/^\/reload\s+([\w-]+)$/);
    if (reload) {
      const ok = process.env.DSH_DISCORD_PATCH && bumpRev(process.env.DSH_DISCORD_PATCH, reload[1]);
      return say(ok ? `🔄 已触发重载：${reload[1]}` : `找不到插件 ${reload[1]}（看 discord.patch.yml 里的 id）`);
    }

    const attachNote = attachments.length
      ? `\n\n[附件已下载到本机：${attachments.map((a) => (a.path ? `${a.name} → ${a.path}` : `${a.name}（下载失败，链接 ${a.url}）`)).join('；')}]`
      : '';
    const item = { engine: state.engine, text: text + attachNote, at: Date.now(), messageId, ...(native ? { raw: true } : {}) };
    await ctx.discord.react(channelId, messageId, '👀', { as: state.engine });
    // 工作区锁：有 agent 在跑（或前面还有排队的），这条排到后面
    if (isBusy(channelId) || queued(channelId).length) {
      queue.set(channelId, [...queued(channelId), item]);
      const running = dshRunning(channelId) ? 'dsh' : ctx.persistentAgents.pending().find((j) => j.channelId === channelId)?.engine;
      return ctx.discord.send(channelId, `⏳ 排在第 ${queued(channelId).length} 条：等${running ? ` ${LABEL[running]} ` : '前面的'}这一轮结束，自动交给 ${LABEL[item.engine]}（/stop 会连排队的一起清掉）`, { as: state.engine, silent: true });
    }
    try {
      await dispatch(channelId, item);
    } catch (e) {
      dshBusy.delete(channelId);
      await endStatus(channelId, 'error', `没发出去：${e?.message || e}`);
      drain(channelId);
    }
  }

  // 开头 @ 主 bot 的消息：装了前台插件（ctx.frontdesk）就归它，不交给帖子的 agent
  const toFrontdesk = (text) => ctx.get('frontdesk', false) && ctx.discord.botUserId && new RegExp(`^\\s*<@!?${ctx.discord.botUserId}>`).test(text);
  ctx.effect(() => ctx.discord.onMessage((msg) => !msg.lobby && !toFrontdesk(msg.text) && handle(msg.channelId, msg.text.trim(), msg.attachments, msg.agents ?? [], msg.id)));
  ctx.provide('threads', {
    submit: (channelId, text) => handle(channelId, text),
    /** 中止正在跑的一轮（同帖子里发 /stop） */
    stop: (channelId) => handle(channelId, '/stop'),
    busy: (channelId) => isBusy(channelId),
    /** lobby 开帖后绑定：{ engine, title, cwd, cc|codex: 会话 ID } */
    bind: (channelId, patch) => save(channelId, patch),
    list: () => Object.fromEntries(Object.keys(store.data).map((id) => [id, stateOf(id)])),
  });
}
