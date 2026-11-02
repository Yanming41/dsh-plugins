// CC / Codex 适配器：拼命令行参数 + 解析输出。提示词一律走 stdin，参数里只有固定开关和会话 ID，不会有转义问题。
// 只是纯函数，方便测试；真正起进程的是 runner/turn.mjs。

export const ENGINES = ['dsh', 'cc', 'codex'];

// mcpConfig：CC 权限审批 MCP 的配置文件路径（有它才会在 Discord 上弹审批按钮，否则需要审批的工具直接失败）
export function buildCommand(engine, { sessionId, mcpConfig } = {}) {
  if (engine === 'cc') {
    const perm = mcpConfig ? ['--mcp-config', mcpConfig, '--permission-prompt-tool', 'mcp__perm__approve'] : [];
    return { cmd: 'claude', args: ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', ...perm, ...(sessionId ? ['--resume', sessionId] : [])] };
  }
  if (engine === 'codex') {
    const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write'];
    return { cmd: 'codex', args: sessionId ? ['exec', 'resume', sessionId, ...common, '-'] : ['exec', ...common, '-'] };
  }
  throw new Error(`未知引擎 ${engine}`);
}

// 返回 { text, sessionId, error }
export function parseOutput(engine, stdout) {
  if (engine === 'cc') {
    const line = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
    if (!line) return { text: '', sessionId: null, error: '没有 JSON 输出' };
    const r = JSON.parse(line);
    return { text: String(r.result ?? ''), sessionId: r.session_id ?? null, error: r.is_error ? String(r.result || r.subtype || '出错') : null };
  }
  let sessionId = null; const texts = []; let error = null;
  for (const l of stdout.split('\n')) {
    if (!l.trim().startsWith('{')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'thread.started') sessionId = e.thread_id ?? sessionId;
    else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) texts.push(e.item.text);
    else if (e.type === 'turn.failed' || e.type === 'error') error = e.error?.message ?? e.message ?? '出错';
  }
  return { text: texts.join('\n\n'), sessionId, error };
}
