// lobby 插件：开帖 / 接回历史会话的命令（从旧桥接主频道搬来）。在 dsh 管的任意频道/帖子里发都行：
//   /cc 标题、/codex 标题     在 config.parent 下开一个新帖子，绑定全新的 Claude Code / Codex 会话
//   /sessions、/codex-sessions 列出本机最近 10 个 Claude / Codex 会话（包括在电脑终端里开的）
//   /resume 编号[!]、/codex-resume 编号[!]  把列表里的会话接到新帖子（在它原来的目录里续上）；
//                              5 分钟内还在更新的标 ⚠️，要加 ! 确认（两边同时用会把记录写乱）
//   /list                      看已经绑定到帖子的会话
// 过渡期 parent 是旧桥接的主频道「常规」：新帖子是它下面的公开帖，旧网关不管这些帖子（dsh 的频道写在 status.json 里）。
// 帖子开好后交给 threads 插件：引擎、会话 ID、工作目录都写进它的帖子状态。
import { existsSync } from 'node:fs';
import os from 'node:os';
import { JsonStore, stateDir } from './store.mjs';
import { HELP, LOBBY_COMMAND } from './commands.mjs';
import { formatAgo, listClaudeSessions, listCodexSessions, RECENTLY_ACTIVE_MS } from './local_sessions.mjs';

export const name = 'lobby';
export const inject = ['discord', 'threads'];

const LABEL = { cc: 'Claude Code', codex: 'Codex' };

export function apply(ctx, config = {}) {
  const parent = String(config.parent ?? '');
  const defaultCwd = config.cwd ?? os.homedir();
  const listing = new JsonStore(stateDir(), 'lobby.json'); // 上次列出来的会话，/resume 编号 按它取
  const lister = { cc: (opts) => (opts.listClaude ?? listClaudeSessions)(10), codex: (opts) => (opts.listCodex ?? listCodexSessions)(10) };
  const cmdName = { cc: { list: '/sessions', resume: '/resume' }, codex: { list: '/codex-sessions', resume: '/codex-resume' } };

  const boundTo = (engine, sessionId) => Object.entries(ctx.threads.list()).find(([, s]) => s[engine] === sessionId)?.[0];

  async function openThread(engine, title, intro, binding) {
    if (!parent) throw new Error('lobby 没配 parent（新帖子开在哪个频道下）');
    const name = `[${engine}] ${title}`.slice(0, 100);
    const threadId = await ctx.discord.createThread(parent, name, intro, { as: engine });
    ctx.threads.bind(threadId, { engine, title, ...binding });
    return threadId;
  }

  async function showSessions(channelId, engine) {
    const say = (t) => ctx.discord.send(channelId, t, { as: engine });
    const list = await lister[engine](config);
    listing.set(engine, list.map(({ sessionId, file, cwd, title }) => ({ sessionId, file, cwd, title })));
    if (!list.length) return say(`没找到本机的 ${LABEL[engine]} 会话记录。`);
    const rows = list.map((d, i) => {
      const bound = boundTo(engine, d.sessionId);
      const flags = bound ? [`已绑定 <#${bound}>`] : Date.now() - d.mtimeMs < RECENTLY_ACTIVE_MS ? ['⚠️ 最近还在更新'] : [];
      const prompt = (d.lastPrompt ?? '').replace(/\s+/g, ' ').slice(0, 60);
      return `**${i + 1}. ${d.title ?? '(无标题)'}** · ${formatAgo(Date.now() - d.mtimeMs)} · \`${d.cwd}\`${flags.length ? ` · ${flags.join(' · ')}` : ''}\n　└ ${prompt || '…'}`;
    });
    rows.push(`接上某个会话：\`${cmdName[engine].resume} 编号\`。标了 ⚠️ 的可能正开在别的终端里，确认没在用再 \`${cmdName[engine].resume} 编号!\``);
    return say(rows.join('\n'));
  }

  async function resume(channelId, engine, n, force) {
    const say = (t) => ctx.discord.send(channelId, t, { as: engine });
    const item = (listing.get(engine) ?? [])[n - 1];
    if (!item) return say(`编号不对，先发 \`${cmdName[engine].list}\` 看列表。`);
    const bound = boundTo(engine, item.sessionId);
    if (bound) return say(`这个会话已经绑定在 <#${bound}> 了，直接去那里聊。`);
    const st = await (config.stat ?? (async (f) => (await import('node:fs/promises')).stat(f)))(item.file).catch(() => null);
    if (!st) return say(`这个会话的记录文件找不到了，重新 \`${cmdName[engine].list}\` 看看。`);
    const idle = Date.now() - st.mtimeMs;
    if (!force && idle < RECENTLY_ACTIVE_MS) {
      return say(`「${item.title ?? item.sessionId.slice(0, 8)}」${formatAgo(idle)}还在更新，可能正开在别的终端里，两边同时用会把记录写乱。确认要接请发 \`${cmdName[engine].resume} ${n}!\``);
    }
    const title = item.title ?? `会话 ${item.sessionId.slice(0, 8)}`;
    const threadId = await openThread(engine, title, `接上之前的 ${LABEL[engine]} 会话「${title}」（目录 \`${item.cwd}\`），之前的上下文都在，直接发消息继续聊。`, { [engine]: item.sessionId, cwd: item.cwd });
    return say(`已接上 <#${threadId}>`);
  }

  async function handle(channelId, text) {
    const m = text.match(LOBBY_COMMAND);
    if (!m) return;
    try {
      const cmd = m[1];
      if (cmd === 'cc' || cmd === 'codex') {
        const title = text.slice(cmd.length + 1).trim().replace(new RegExp(`^(\\s*\\[${cmd}\\]\\s*)+`, 'i'), '').trim() || '未命名';
        if (!existsSync(defaultCwd)) return ctx.discord.send(channelId, `目录不存在：${defaultCwd}`);
        const threadId = await openThread(cmd, title, `${LABEL[cmd]} 新会话（目录 \`${defaultCwd}\`）。直接发消息吧；/stop 中止、/new 换新会话、/agent 换引擎。`, { [cmd]: null, cwd: defaultCwd });
        return ctx.discord.send(channelId, `已开会话 <#${threadId}>`, { as: cmd });
      }
      if (cmd === 'sessions') return showSessions(channelId, 'cc');
      if (cmd === 'codex-sessions') return showSessions(channelId, 'codex');
      if (cmd === 'resume' || cmd === 'codex-resume') {
        const engine = cmd === 'resume' ? 'cc' : 'codex';
        const r = text.match(/^\/[\w-]+\s+(\d+)\s*(!?)$/);
        if (!r) return ctx.discord.send(channelId, `用法：先 \`${cmdName[engine].list}\` 看列表，再 \`${cmd === 'resume' ? '/resume' : '/codex-resume'} 编号\`。`);
        return resume(channelId, engine, Number(r[1]), r[2] === '!');
      }
      if (cmd === 'list') {
        const rows = Object.entries(ctx.threads.list()).filter(([, s]) => s.title).map(([id, s]) =>
          `• <#${id}> · ${LABEL[s.engine] ?? s.engine} · ${ctx.threads.busy(id) ? '⏳工作中' : '🟢空闲'}${s.cwd ? ` · \`${s.cwd}\`` : ''}`);
        return ctx.discord.send(channelId, rows.length ? rows.join('\n') : '现在没有绑定的会话。发 `/cc 标题` 开 Claude Code，或 `/codex 标题` 开 Codex。');
      }
    } catch (e) {
      ctx.logger.error(`lobby: ${e?.stack || e}`);
      await ctx.discord.send(channelId, `❌ ${e?.message || e}`).catch(() => {});
    }
  }

  ctx.effect(() => ctx.discord.onMessage((msg) => {
    const text = msg.text.trim();
    if (msg.lobby && /^\/help\b/.test(text)) return ctx.discord.send(msg.channelId, HELP);
    return handle(msg.channelId, text);
  }));
}
