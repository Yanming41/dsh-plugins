// 给同一台机器、同一个 Windows 用户下的其它进程（tars、Discord 桥接）用的只读入口：
// 直接读 vault.json，在调用方进程里解密，值不经过任何接口。每次调用都重新读文件，拿到 dsh 那边的最新写入。
// 写入（导入、复制条目）请走 dsh 的本机 API（/api/put、/api/copy），避免两个进程同时写同一个文件。
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDataKey } from './keyring.mjs';
import { Vault } from './vault.mjs';

export function openVault({ dir = path.join(os.homedir(), '.dsh-secret-vault'), keyProtector = process.platform === 'win32' ? 'dpapi' : 'file' } = {}) {
  const file = path.join(dir, 'vault.json');
  let key;
  const load = async () => {
    if (!existsSync(file)) throw new Error(`保险柜不存在：${file}`);
    key ??= await loadDataKey(dir, keyProtector);
    return new Vault(file, key, { scanRules: false, scrub: false });
  };
  return {
    summary: async (ref) => (await load()).summary(ref),
    has: async (ref) => (await load()).has(ref),
    list: async () => (await load()).list(),
    search: async (query, limit) => (await load()).search(query, limit),
    /** 取明文交给回调用，用完不留 */
    use: async (ref, fn) => (await load()).use(ref, fn),
  };
}
