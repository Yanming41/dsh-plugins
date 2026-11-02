// secret-guard：密钥泄漏守卫。在文本进入会话日志 / 模型上下文、以及发往外部的路上打码。
//
// dsh 发给模型的请求是会话日志的纯函数（llm/stream 拿到的是冻结对象，不许改写），所以守的是「进日志的入口」：
// 进来的全是打过码的，模型从头到尾见不到明文，它自己的回复和工具调用参数也就带不出明文。
//   agent/pre-step          用户消息（含粘贴进来的密钥）
//   tools/post-execute      工具结果
//   tools/ptc-dispatch-log  run_code 子调用的日志副本
//   system-prompt/assemble  系统提示词（instructions 文件里写了密钥也拦得住）
//   session-telemetry/record 导出的遥测记录
// 出口：提供 secretGuard 服务（scrub / scrubDeep），发 Discord 消息、写日志这类调用方自己接上。
//
// 怎么认：装了 secret-vault 就先用它的 scrub（保险柜里存过的值精确比对，含 base64/hex/url 编码形式，加规则兜底）；
// 没装就只靠 @sanity-labs/secret-scan 的 1100+ 条规则。另外可以配自定义正则。
import { scan } from '@sanity-labs/secret-scan';

export const name = 'secret-guard';

const defaults = {
  vault: 'auto',     // auto：有 secretVault 服务就用它精确认存过的值；off：只用规则
  rules: true,       // secret-scan 规则库（vault 在时由 vault 那边跑，这里不重复）
  extra: [],         // [{ name, pattern }]，自定义正则，命中换成 [secret:custom:name]
  hooks: { userInput: true, toolOutput: true, ptcLog: true, systemPrompt: true, telemetry: true },
  log: true,         // 打码时记一行（只记位置和数量，不记内容）
};

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function compileExtra(extra = []) {
  return extra.map(({ name: n, pattern }) => {
    if (!NAME.test(String(n))) throw new Error(`secret-guard: extra 规则名「${n}」只能用小写字母、数字和 -`);
    try { return { name: n, re: new RegExp(pattern, 'g') }; } catch (e) { throw new Error(`secret-guard: extra 规则「${n}」的正则写错了：${pattern}`, { cause: e }); }
  });
}

/** 只用规则打码（没有保险柜时）。重叠命中取先出现、更长的 */
export function scrubWithRules(text, { rules = true, extra = [] } = {}) {
  if (typeof text !== 'string' || !text) return text;
  const hits = [];
  if (rules) for (const s of scan(text)) hits.push({ start: s.start, end: s.end, label: `unregistered:${s.rule}` });
  for (const { name: n, re } of extra) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) if (m[0]) hits.push({ start: m.index, end: m.index + m[0].length, label: `custom:${n}` });
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let pos = 0;
  for (const h of hits) {
    if (h.start < pos) continue;
    out += `${text.slice(pos, h.start)}[secret:${h.label}]`;
    pos = h.end;
  }
  return out + text.slice(pos);
}

export function apply(ctx, options = {}) {
  const config = { ...defaults, ...options, hooks: { ...defaults.hooks, ...options.hooks } };
  const extra = compileExtra(config.extra);
  const log = ctx.logger ?? console;

  const scrub = (text) => {
    if (typeof text !== 'string' || !text) return text;
    const vault = config.vault === 'auto' ? ctx.get('secretVault', false) : null;
    if (vault?.scrub) return scrubWithRules(vault.scrub(text), { rules: false, extra });
    return scrubWithRules(text, { rules: config.rules, extra });
  };

  // 深度遍历：所有字符串都过一遍；没变就原样返回同一个对象（保持引用，不打扰下游的相等判断）
  const scrubDeep = (value, seen = new WeakSet()) => {
    if (typeof value === 'string') return scrub(value);
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((v) => { const s = scrubDeep(v, seen); if (s !== v) changed = true; return s; });
      return changed ? next : value;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) { const s = scrubDeep(v, seen); if (s !== v) changed = true; next[k] = s; }
    return changed ? next : value;
  };

  // 内容块：只改 text 块，图片等原样
  const scrubBlocks = (content) => {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const next = content.map((b) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return b;
      const t = scrub(b.text);
      if (t === b.text) return b;
      changed = true;
      return { ...b, text: t };
    });
    return changed ? next : content;
  };

  const note = (where) => { if (config.log) log.info?.(`secret-guard: 在 ${where} 打了码`); };

  const service = {
    /** 文本打码 */
    scrub,
    /** 对象里所有字符串打码（没变返回原对象） */
    scrubDeep,
    /** 是否接上了保险柜（能精确认存过的值） */
    get vaultLinked() { return config.vault === 'auto' && Boolean(ctx.get('secretVault', false)?.scrub); },
  };
  ctx.provide('secretGuard', service);

  // 前置（prepend）监听，先让下游决定，再对最终采纳的内容打码
  if (config.hooks.userInput) {
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next();
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      let changed = false;
      const messages = decision.messages.map((m) => {
        const content = scrubBlocks(m.content);
        if (content === m.content) return m;
        changed = true;
        return { ...m, content };
      });
      if (!changed) return decision;
      note('用户消息');
      return { ...decision, messages };
    }, { prepend: true });
  }

  if (config.hooks.toolOutput) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (decision?.kind !== 'accept' || decision.value !== undefined) return decision;
      const content = decision.content ?? result?.content;
      const scrubbed = scrubBlocks(content);
      if (scrubbed === content) return decision;
      note(`工具 ${exec?.name ?? '?'} 的结果`);
      return { ...decision, content: scrubbed };
    }, { prepend: true });
  }

  if (config.hooks.ptcLog) {
    ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
      const content = await next();
      const scrubbed = scrubBlocks(content);
      if (scrubbed !== content) note(`run_code 子调用 ${dispatch?.name ?? '?'} 的日志`);
      return scrubbed;
    }, { prepend: true });
  }

  if (config.hooks.systemPrompt) {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      if (!assembly) return assembly;
      const sections = scrubDeep(assembly.sections);
      const contexts = scrubDeep(assembly.contexts);
      const variables = scrubDeep(assembly.variables);
      if (sections === assembly.sections && contexts === assembly.contexts && variables === assembly.variables) return assembly;
      note('系统提示词');
      return { ...assembly, sections, contexts, variables };
    }, { prepend: true });
  }

  if (config.hooks.telemetry) {
    ctx.on('session-telemetry/record', (record, next) => {
      const r = next();
      const s = scrubDeep(r);
      if (s !== r) note('遥测记录');
      return s;
    }, { prepend: true });
  }
}
