// discord 插件：连 Discord 网关，提供 ctx.discord 服务（收消息/按钮订阅、发消息/按钮/文件、打字状态）。
// 只处理配置里列出的频道/帖子，其余消息一律忽略，这样可以和旧 bridge 共用同一个 bot token 并存。
// 重载本插件会断开重连网关；依赖 ctx.discord 的插件会被 Cordis 一起重启。
// 多身份：config.agentBots = { cc: 'bots/cc-token', … }，每个 agent 一个 bot（token 从 secret-vault 取）。
// 主 bot（DISCORD_TOKEN）负责收消息，是唯一的入口，所以 4 个 bot 都在也不会抢着回；agent bot 也连网关，
// 但只接自己发出的按钮点击，并用自己的头像名字发消息、显示正在输入。消息里 @ 到的 agent 放在 event.agents 里。
// 另外在 127.0.0.1:<apiPort> 开一个本地接口 POST /send_file，给帖子里的 CC/Codex 发文件用（鉴权同旧 bridge 的 token）。
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildComponents, copyParts, extractInteractive } from './reply_buttons.mjs';
import { hasMath, toDiscordSegments } from './math_render.mjs';
import { splitMessage } from './split.mjs';
import { apiTokenFile, JsonStore, stateDir } from './store.mjs';

export const name = 'discord';

const STATUS_TAGS = ['进行中', '等待中', '已完成'];
const STYLE = { primary: ButtonStyle.Primary, success: ButtonStyle.Success, danger: ButtonStyle.Danger, secondary: ButtonStyle.Secondary };

export function apply(ctx, config = {}) {
  const token = config.token || process.env.DISCORD_TOKEN;
  if (!token) throw new Error('没有 Discord bot token：配置 token，或设环境变量 DISCORD_TOKEN');
  // 配置里的频道 + lobby 开出来的帖子（存 state/channels.json，重启不丢）
  const opened = new JsonStore(stateDir(), 'channels.json');
  // 大厅（config.lobbies）：event.lobby = true。threads 不接大厅的消息；lobby 插件只处理会话命令，其余留给别的插件（比如前台 agent）
  const lobbies = new Set((config.lobbies ?? []).map(String));
  const channels = new Set([...(config.channels ?? []), ...lobbies, ...(opened.get('threads') ?? [])].map(String));
  // 旧网关读 status.json 里的频道列表，列在里面的它就不回应
  const writeStatus = () => new JsonStore(stateDir(), 'status.json').set('discord', { ready: client.isReady(), at: new Date().toISOString(), channels: [...channels], rev: config.rev ?? 0 });
  const ownerId = String(config.ownerId ?? process.env.OWNER_ID ?? '');
  const attachDir = path.join(stateDir(), 'attachments');
  const listeners = new Set();
  const buttonListeners = new Set();
  const emit = (set, event) => { for (const fn of set) Promise.resolve().then(() => fn(event)).catch((e) => ctx.logger.error(`discord listener: ${e?.stack || e}`)); };

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });
  const agentClients = new Map(); // agent 键 → Client
  const agentByUserId = new Map(); // bot 用户 ID → agent 键
  const pick = (as) => (as && agentClients.get(as)?.isReady() ? agentClients.get(as) : client);

  // 附件下载到本机，Agent 拿本地路径直接读（Discord 的附件链接会过期）
  async function download(message) {
    const out = [];
    for (const a of message.attachments.values()) {
      const item = { name: a.name, url: a.url, size: a.size, contentType: a.contentType };
      try {
        const dir = path.join(attachDir, new Date().toISOString().slice(0, 10));
        mkdirSync(dir, { recursive: true });
        item.path = path.join(dir, `${message.id}_${a.name.replace(/[\\/:*?"<>|]/g, '_')}`);
        writeFileSync(item.path, Buffer.from(await (await fetch(a.url)).arrayBuffer()));
      } catch (e) {
        ctx.logger.warn(`discord: 附件下载失败 ${a.name}：${e?.message || e}`);
        delete item.path;
      }
      out.push(item);
    }
    return out;
  }

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !channels.has(message.channelId)) return;
    if (ownerId && message.author.id !== ownerId) return;
    // @ 到的 agent，按在正文里出现的顺序；正文里去掉这些 @
    let text = message.content ?? '';
    const lobby = lobbies.has(message.channelId);
    const agents = [];
    for (const m of text.matchAll(/<@!?(\d+)>/g)) {
      const key = agentByUserId.get(m[1]);
      if (key && !agents.includes(key)) agents.push(key);
    }
    if (agents.length) text = text.replace(/<@!?(\d+)>/g, (all, id) => (agentByUserId.has(id) ? '' : all)).replace(/[ \t]{2,}/g, ' ').trim();
    emit(listeners, {
      id: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      text,
      agents,
      lobby,
      attachments: message.attachments.size ? await download(message) : [],
    });
  });

  // 斜杠命令(由旧网关的 register_commands.mjs 一起注册，scope=dsh 的旧网关不回应)：
  // 先在 3 秒内回一条只有自己看得到的确认，再还原成手打文字当普通消息交给订阅者。
  // 按钮：custom_id 以 dsh: 开头的归我们（旧网关会跳过），先 deferUpdate 占住交互再交给订阅者。
  const SLASH = new Set(['agent', 'new', 'reload', 'stop', 'todo', 'help', 'end', 'clear', 'screen', 'model', 'effort', 'mode', 'compact', 'context', 'cost', 'cc', 'codex', 'sessions', 'resume', 'codex-sessions', 'codex-resume', 'list', '2b-new']);
  const onInteraction = async (interaction, fromAgent) => {
    if (!channels.has(interaction.channelId)) return;
    if (interaction.isButton() && /^dsh:(ch|cp):/.test(interaction.customId)) return onReplyButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('dsh:')) {
      if (ownerId && interaction.user.id !== ownerId) return interaction.reply({ content: '这个按钮只有主人能点。', ephemeral: true }).catch(() => {});
      await interaction.deferUpdate().catch(() => {});
      return emit(buttonListeners, {
        channelId: interaction.channelId,
        customId: interaction.customId,
        // 点完把按钮去掉、正文后面标上结果，避免重复点
        done: (note) => interaction.editReply({ content: `${interaction.message.content}\n${note}`, components: [] }).catch(() => {}),
      });
    }
    if (fromAgent || !interaction.isChatInputCommand() || !SLASH.has(interaction.commandName)) return;
    if (ownerId && interaction.user.id !== ownerId) return;
    // 布尔选项（/resume 的 force）还原成手打的 !
    const opts = interaction.options.data;
    const arg = opts.filter((o) => typeof o.value !== 'boolean').map((o) => o.value).join(' ');
    const text = `/${interaction.commandName}${arg ? ` ${arg}` : ''}${opts.some((o) => o.value === true) ? '!' : ''}`;
    await interaction.reply({ content: `收到：\`${text}\``, ephemeral: true }).catch(() => {});
    emit(listeners, { id: interaction.id, channelId: interaction.channelId, authorId: interaction.user.id, text, agents: [], attachments: [], lobby: lobbies.has(interaction.channelId) });
  };
  client.on('interactionCreate', (i) => onInteraction(i, false));

  // ---- 回复里的选项按钮 / 📋 复制（sendReply 挂上的）----
  // 记录存 state/buttons.json：key → { channelId, choices, blocks, chosen }，只留最近 MAX_BUTTONS 条
  const MAX_BUTTONS = 300;
  const buttons = new JsonStore(stateDir(), 'buttons.json');
  const saveButton = (key, rec) => {
    const keys = Object.keys(buttons.data);
    if (keys.length >= MAX_BUTTONS) for (const k of keys.sort((a, b) => buttons.data[a].ts - buttons.data[b].ts).slice(0, keys.length - MAX_BUTTONS + 1)) delete buttons.data[k];
    buttons.set(key, rec);
  };
  async function onReplyButton(interaction) {
    const [, kind, key, idx] = interaction.customId.split(':');
    const rec = buttons.get(key);
    const ephemeral = (content) => interaction.reply({ content, ephemeral: true }).catch(() => {});
    if (ownerId && interaction.user.id !== ownerId) return ephemeral('这个按钮只有主人能点。');
    if (!rec) return ephemeral('这个按钮已经过期了。');
    if (kind === 'cp') {
      // 每段单独一条只有自己看得见的消息，长按「复制文字」正好是那段
      const parts = copyParts(rec.blocks);
      await ephemeral(parts[0]);
      for (const p of parts.slice(1)) await interaction.followUp({ content: p, ephemeral: true }).catch(() => {});
      return;
    }
    const choice = rec.choices[Number(idx)];
    if (!choice) return ephemeral('这个按钮不认识。');
    if (rec.chosen != null) return ephemeral(`已经选过「${rec.choices[rec.chosen].label}」了。`);
    rec.chosen = Number(idx);
    buttons.set(key, rec);
    // 按钮全部禁用、选中的标绿；频道里留一条记录，再把这句话当成主人发的消息交给订阅者
    await interaction.update({ components: buildComponents(key, rec) }).catch(() => {});
    const quoted = choice.text === choice.label ? '' : `\n> ${choice.text.slice(0, 300).replace(/\n/g, '\n> ')}`;
    await interaction.channel?.send(`🔘 ${config.ownerName ?? '用户'} 选了：**${choice.label}**${quoted}`).catch(() => {});
    emit(listeners, { id: interaction.id, channelId: interaction.channelId, authorId: interaction.user.id, text: choice.text, agents: [], attachments: [] });
  }

  // 出口打码：装了 secret-guard 就把发出去的文字过一遍（没装原样发）
  const guardText = (text) => ctx.get('secretGuard', false)?.scrub(text) ?? text;

  async function sendFiles(channelId, paths, note, { as } = {}) {
    note = guardText(note);
    const channel = await pick(as).channels.fetch(channelId);
    const files = paths.slice(0, 10).map((p) => new AttachmentBuilder(readFileSync(p), { name: path.basename(p) }));
    return (await channel.send({ content: note || undefined, files })).id;
  }

  // 回复正文：有 LaTeX 时单独成行的公式渲染成图片跟在对应文字后面，行内公式转 Unicode（lib/math_render.mjs）。
  // 拆成多条时只有最后一条推送通知，前面的静默发。
  async function sendRich(channelId, text, as) {
    let segments = [{ text, images: [] }];
    if (hasMath(text)) {
      try { segments = toDiscordSegments(text); } catch (e) { ctx.logger.warn(`discord: 公式处理失败，按原文发 ${e?.message || e}`); }
    }
    const msgs = [];
    for (const seg of segments) {
      const parts = seg.text ? splitMessage(seg.text) : [''];
      parts.forEach((p, i) => msgs.push({ content: p, images: i === parts.length - 1 ? seg.images : [] }));
    }
    const channel = await pick(as).channels.fetch(channelId);
    const ids = [];
    for (const [i, m] of msgs.entries()) {
      if (!m.content && !m.images.length) continue;
      const payload = {
        content: m.content || undefined,
        files: m.images.map((b, k) => new AttachmentBuilder(b, { name: `formula-${k + 1}.png` })),
        ...(i < msgs.length - 1 ? { flags: MessageFlags.SuppressNotifications } : {}),
      };
      ids.push((await channel.send(payload)).id);
    }
    return ids;
  }

  const service = {
    get ready() { return client.isReady(); },
    /** 主 bot 的用户 ID（识别「@主 bot」用） */
    get botUserId() { return client.user?.id ?? null; },
    /** 频道最近的消息（从旧到新）：[{ id, authorId, author, bot, text }] */
    async recent(channelId, limit = 15) {
      const msgs = await (await client.channels.fetch(channelId)).messages.fetch({ limit });
      return [...msgs.values()].reverse().map((m) => ({ id: m.id, authorId: m.author.id, author: m.member?.displayName ?? m.author.username, bot: m.author.bot, text: m.content || (m.attachments.size ? '[附件]' : '') }));
    },
    /** 频道/帖子名字 */
    async channelName(channelId) { return (await client.channels.fetch(channelId).catch(() => null))?.name ?? null; },
    /** 订阅本插件放行的消息；返回取消订阅函数（请包在调用方的 ctx.effect 里）。 */
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** 订阅 dsh: 开头的按钮点击：{ channelId, customId, done(note) } */
    onButton(fn) { buttonListeners.add(fn); return () => buttonListeners.delete(fn); },
    /** opts.as：用哪个 agent 的身份发（没配或没连上就用主 bot） */
    /** silent：静默发（进度、排队提示这类不需要推送的消息，手机不响） */
    async send(channelId, text, { as, silent = false } = {}) {
      const channel = await pick(as).channels.fetch(channelId);
      const ids = [];
      for (const part of splitMessage(guardText(text))) ids.push((await channel.send(silent ? { content: part, flags: MessageFlags.SuppressNotifications } : part)).id);
      return ids;
    },
    /** 发 agent 的回复：```choices 块变成选项按钮，其余代码块加「📋 复制」，按钮挂在最后一条上 */
    async sendReply(channelId, text, { as } = {}) {
      const { text: body, choices, blocks } = extractInteractive(guardText(text));
      const ids = await sendRich(channelId, body || '选一个：', as);
      if (!choices.length && !blocks.length) return ids;
      const key = randomBytes(5).toString('hex');
      const rec = { channelId, choices, blocks, ts: Date.now() };
      saveButton(key, rec);
      const msg = await (await pick(as).channels.fetch(channelId)).messages.fetch(ids.at(-1));
      await msg.edit({ components: buildComponents(key, rec) });
      return ids;
    },
    /** buttons: [{ id: 'dsh:...', label, style: primary|success|danger|secondary }] */
    async sendButtons(channelId, text, buttons, { as } = {}) {
      const channel = await pick(as).channels.fetch(channelId);
      const row = new ActionRowBuilder().addComponents(buttons.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(STYLE[b.style] ?? ButtonStyle.Secondary)));
      return (await channel.send({ content: guardText(text).slice(0, 1900), components: [row] })).id;
    },
    sendFiles,
    /** 给消息加 / 去掉表情（失败就算了，不影响对话） */
    async react(channelId, messageId, emoji, { as, remove = false } = {}) {
      if (!messageId) return;
      try {
        const msg = await (await pick(as).channels.fetch(channelId)).messages.fetch(messageId);
        if (remove) await msg.reactions.cache.get(emoji)?.users.remove(pick(as).user.id);
        else await msg.react(emoji);
      } catch {}
    },
    /** 改一条自己发的消息（进度消息原地刷新用） */
    async edit(channelId, messageId, text, { as } = {}) {
      const msg = await (await pick(as).channels.fetch(channelId)).messages.fetch(messageId);
      await msg.edit(guardText(text).slice(0, 1990));
    },
    /** 论坛帖子的状态标签（进行中 / 等待中 / 已完成）；不是论坛帖子、或论坛里没有这个标签就什么都不做 */
    async setStatusTag(channelId, status) {
      try {
        const th = await client.channels.fetch(channelId);
        const forum = th?.parent;
        if (!th?.isThread() || !forum?.availableTags) return;
        const want = forum.availableTags.find((t) => t.name === status);
        if (!want) return;
        const others = th.appliedTags.filter((id) => !STATUS_TAGS.includes(forum.availableTags.find((t) => t.id === id)?.name));
        await th.setAppliedTags([...others, want.id].slice(0, 5));
      } catch {}
    },
    /** 在 parentId 下开帖子（论坛频道开论坛帖，文字频道开公开帖），发第一条消息，并开始监听它；返回帖子 ID */
    async createThread(parentId, name, text, { as } = {}) {
      const parent = await client.channels.fetch(parentId);
      let thread;
      if (parent.availableTags) {
        const idle = parent.availableTags.find((t) => t.name === '等待中');
        thread = await parent.threads.create({ name, message: { content: guardText(text) }, appliedTags: idle ? [idle.id] : [] });
      } else {
        thread = await parent.threads.create({ name, autoArchiveDuration: 10080 });
      }
      channels.add(thread.id);
      opened.set('threads', [...(opened.get('threads') ?? []), thread.id]);
      writeStatus();
      if (!parent.availableTags) await service.send(thread.id, text, { as });
      return thread.id;
    },
    /** 已配置的 agent 身份：[{ key, userId, ready }] */
    agentBots: () => [...agentClients].map(([key, c]) => ({ key, userId: c.user?.id ?? null, ready: c.isReady() })),
    async typing(channelId, { as } = {}) {
      const channel = await pick(as).channels.fetch(channelId);
      await channel.sendTyping().catch(() => {});
    },
  };

  ctx.effect(() => {
    client.once('ready', () => {
      ctx.logger.info(`discord: 已连接，监听 ${channels.size} 个频道/帖子`);
      // 给外部健康检查用（不必看窗口输出就能确认连上了）
      writeStatus();
    });
    client.login(token)
      .catch((e) => ctx.logger.error(`discord: 登录失败 ${e?.message || e}`));
    return () => { client.destroy(); };
  });

  // agent 身份 bot：token 在 secret-vault 里，保险柜服务在时才启动（随它一起重载）
  if (config.agentBots && Object.keys(config.agentBots).length) {
    ctx.inject(['secretVault'], (c) => {
      for (const [key, ref] of Object.entries(config.agentBots)) {
        c.effect(() => {
          const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
          agentClients.set(key, bot);
          bot.on('interactionCreate', (i) => onInteraction(i, true));
          bot.once('ready', () => {
            agentByUserId.set(bot.user.id, key);
            ctx.logger.info(`discord: agent 身份 ${key} 已连接（${bot.user.tag}）`);
            new JsonStore(stateDir(), 'status.json').set(`agent:${key}`, { ready: true, at: new Date().toISOString(), tag: bot.user.tag });
          });
          c.secretVault.use(ref, (t) => bot.login(t))
            .catch((e) => ctx.logger.error(`discord: agent 身份 ${key} 登录失败 ${e?.message || e}`));
          return () => {
            if (bot.user) agentByUserId.delete(bot.user.id);
            agentClients.delete(key);
            bot.destroy();
          };
        });
      }
    });
  }

  // 本地接口：POST /send_file {thread_id, note, paths}，只能发到本插件监听的帖子
  ctx.effect(() => {
    if (!config.apiPort) return () => {};
    let apiToken = '';
    try { apiToken = readFileSync(apiTokenFile(config), 'utf8').trim(); } catch {}
    const server = http.createServer(async (req, res) => {
      const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!apiToken || req.headers.authorization !== `Bearer ${apiToken}`) return reply(401, { error: 'unauthorized' });
      if (req.method !== 'POST' || !['/send_file', '/submit'].includes(req.url)) return reply(404, { error: 'not found' });
      let body = '';
      for await (const chunk of req) body += chunk;
      // POST /submit {thread_id, text}：别的程序往本插件管的帖子转交任务，当成一条消息处理
      if (req.url === '/submit') {
        try {
          const { thread_id: threadId, text } = JSON.parse(body);
          if (!channels.has(String(threadId))) return reply(403, { error: `帖子 ${threadId} 不归 dsh-discord 管` });
          if (!String(text ?? '').trim()) return reply(400, { error: 'text 不能为空' });
          const [id] = await service.send(String(threadId), String(text).slice(0, 1990), { silent: true });
          emit(listeners, { id, channelId: String(threadId), authorId: 'bridge', text: String(text), agents: [], attachments: [] });
          return reply(200, { ok: true });
        } catch (e) {
          return reply(500, { error: e?.message || String(e) });
        }
      }
      try {
        const { thread_id: threadId, note, paths } = JSON.parse(body);
        if (!channels.has(String(threadId))) return reply(403, { error: `帖子 ${threadId} 不归 dsh-discord 管` });
        if (!Array.isArray(paths) || !paths.length) return reply(400, { error: 'paths 不能为空' });
        reply(200, { ok: true, message_id: await sendFiles(String(threadId), paths, note) });
      } catch (e) {
        reply(500, { error: e?.message || String(e) });
      }
    });
    server.listen(config.apiPort, '127.0.0.1');
    server.on('error', (e) => ctx.logger.error(`discord: 本地接口 :${config.apiPort} 启动失败 ${e?.message || e}`));
    return () => server.close();
  });

  ctx.provide('discord', service);
}
