import fs from 'node:fs';
import path from 'node:path';
import { env, SECRETS } from './env.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function ensureDir() {
  fs.mkdirSync(env.logsDir, { recursive: true });
}

export function redact(text) {
  let out = String(text);
  for (const secret of SECRETS) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  // 顺手抹掉常见 token 形态
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer ***');
  return out;
}

function logFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(env.logsDir, `${day}.log`);
}

function append(line) {
  try {
    ensureDir();
    const file = logFile();
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件不存在时忽略 */
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    /* 日志失败不应影响主流程 */
  }
}

export function createLogger(scope = 'app') {
  const emit = (level, message, extra) => {
    const record = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: redact(message),
    };
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        record[k] = typeof v === 'string' ? redact(v) : v;
      }
    }
    const line = JSON.stringify(record);
    const prefix = `[${record.ts}] ${level.toUpperCase()} ${scope}`;
    if (level === 'error') console.error(prefix, record.msg, extra ?? '');
    else if (level === 'warn') console.warn(prefix, record.msg, extra ?? '');
    else console.log(prefix, record.msg, extra ?? '');
    append(line);
  };
  return {
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
    debug: (msg, extra) => {
      if (process.env.DEBUG) emit('debug', msg, extra);
    },
  };
}

/** 供后台接口读取最近日志（已脱敏） */
export function readRecentLogs(lines = 200) {
  try {
    const file = logFile();
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return text.slice(-Math.max(1, Math.min(lines, 2000))).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: '', level: 'info', msg: redact(line) };
      }
    });
  } catch {
    return [];
  }
}
