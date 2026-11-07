import fs from 'node:fs';
import path from 'node:path';
import { env, readJson } from './env.js';

const LOCK_DIR = path.join(env.stateDir, 'locks');

function lockPath(name) {
  return path.join(LOCK_DIR, `${name.replace(/[^a-z0-9_-]/gi, '_')}.lock`);
}

/**
 * 文件锁：防止定时任务与手动任务、或多个项目实例重复同步/上传。
 * 使用 O_EXCL 原子创建；超过 ttlMs 未释放视为僵尸锁。
 */
export function acquireLock(name, { ttlMs = 30 * 60 * 1000 } = {}) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, name, acquiredAt: new Date().toISOString() }),
      );
      fs.closeSync(fd);
      return {
        ok: true,
        name,
        file,
        release() {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            /* 忽略 */
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const st = fs.statSync(file);
        stale = Date.now() - st.mtimeMs > ttlMs;
      } catch {
        stale = true;
      }
      if (stale) {
        fs.rmSync(file, { force: true });
        continue;
      }
      return { ok: false, name, holder: readJson(file, {}), file };
    }
  }
  return { ok: false, name, holder: null, file };
}

export function withLock(name, options, fn) {
  const lock = acquireLock(name, options);
  if (!lock.ok) {
    const holder = lock.holder || {};
    const at = holder.acquiredAt ? new Date(holder.acquiredAt).toLocaleString('zh-CN') : '未知时间';
    throw new Error(`任务「${name}」正在运行中（pid ${holder.pid ?? '?'}，开始于 ${at}），已跳过`);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => lock.release());
}

export function listLocks() {
  try {
    return fs
      .readdirSync(LOCK_DIR)
      .filter((f) => f.endsWith('.lock'))
      .map((f) => ({ file: f, ...readJson(path.join(LOCK_DIR, f), {}) }));
  } catch {
    return [];
  }
}
