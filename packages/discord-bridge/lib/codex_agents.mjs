// 从旧桥接 discord_dm/codex_instructions.mjs 搬来（标记行保持一致，新旧桥接写的是同一份、不会互相当成手写的）。
// Codex 和 Claude Code 用同一套说明，避免两边各写一份慢慢跑偏：
// - 全局偏好的唯一来源是 ~/.claude/CLAUDE.md，
//   同步成 Codex 自动读取的 $CODEX_HOME/AGENTS.md（Codex 平时在别处用也会读到，内容本来就是全局的）。
// - Discord 专用说明（选项按钮、复制块、tars 回报、发文件）来自 cc_discord_prompt.md，
//   只在桥接调用 Codex 时作为 developer_instructions 传入。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

const MARK = "<!-- generated from ~/.claude/CLAUDE.md by discord_dm/codex_instructions.mjs; edit the source, not this file -->";
const note = (owner) => `下面是 ${owner} 的全局协作说明，和 Claude Code 读的是同一份。文中写「Claude Code」或「我」的地方同样适用于你(Codex)；`
  + `提到 Claude 专属功能(memory 目录、Claude in Chrome 等)时按同样的意图用你自己的工具完成。`;

export function syncCodexAgents({ owner = '用户', claudeMd, codexHome }) {
  if (!existsSync(claudeMd)) return { written: false, reason: "no CLAUDE.md" };
  const target = path.join(codexHome, "AGENTS.md");
  const body = `${MARK}\n\n${note(owner)}\n\n${readFileSync(claudeMd, "utf8")}`;
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    if (current === body) return { written: false, reason: "up to date" };
    if (!current.startsWith(MARK)) return { written: false, reason: "AGENTS.md was written by hand; not overwriting" };
  }
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(`${target}.tmp`, body, "utf8");
  renameSync(`${target}.tmp`, target);
  return { written: true };
}
