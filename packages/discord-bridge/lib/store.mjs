// 极小的 JSON 键值存盘：每次写都先写临时文件再改名，进程中途被杀也不会留下半个文件。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export class JsonStore {
  constructor(dir, file) {
    if (!dir) throw new Error('JsonStore 需要存储目录');
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, file);
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

// 状态目录：环境变量 DSH_DISCORD_STATE，没有就用 ~/.dsh-discord/state
export const stateDir = () => process.env.DSH_DISCORD_STATE || path.join(os.homedir(), '.dsh-discord', 'state');

// 本地接口（/send_file、/submit）的 bearer token 文件：config.apiTokenFile，没有就用状态目录下的 api_token（第一次自动生成）
export function apiTokenFile(config = {}) {
  const file = config.apiTokenFile || path.join(stateDir(), 'api_token');
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return file;
}
