import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

parseDotEnv(path.join(ROOT, '.env'));

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const str = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);

const abs = (p, fallbackDir) => {
  const v = str(p);
  if (!v) return fallbackDir;
  return path.isAbsolute(v) ? v : path.resolve(ROOT, v);
};

export const env = {
  root: ROOT,
  configDir: path.join(ROOT, 'config'),
  webDir: path.join(ROOT, 'web'),
  stateDir: path.join(ROOT, 'state'),
  tmpDir: path.join(ROOT, 'tmp'),
  logsDir: path.join(ROOT, 'state', 'logs'),

  // GitHub
  githubToken: str(process.env.GITHUB_TOKEN),
  githubApiBase: str(process.env.GITHUB_API_BASE, 'https://api.github.com').replace(/\/+$/, ''),
  allowHtmlFallback: str(process.env.ALLOW_HTML_FALLBACK, 'true') !== 'false',
  releasesPageSize: Math.min(num(process.env.RELEASES_PAGE_SIZE, 10), 30),

  // 定时任务
  checkIntervalMinutes: num(process.env.CHECK_INTERVAL_MINUTES, 8),
  staleAfterMinutes: num(process.env.STALE_AFTER_MINUTES, 30),
  maxAssetMb: num(process.env.MAX_ASSET_MB, 400),
  maxParallelSync: Math.max(1, Math.min(num(process.env.MAX_PARALLEL_SYNC, 2), 6)),
  retryBackoffMaxSeconds: num(process.env.RETRY_BACKOFF_MAX_SECONDS, 900),

  // 存储
  storageDriver: str(process.env.STORAGE_DRIVER, 'local').toLowerCase(),
  localStorageDir: abs(process.env.LOCAL_STORAGE_DIR, path.join(ROOT, 'storage', 'files')),
  s3: {
    endpoint: str(process.env.S3_ENDPOINT),
    region: str(process.env.S3_REGION, 'auto'),
    bucket: str(process.env.S3_BUCKET),
    accessKeyId: str(process.env.S3_ACCESS_KEY_ID),
    secretAccessKey: str(process.env.S3_SECRET_ACCESS_KEY),
  },
  s3PublicBaseUrl: str(process.env.S3_PUBLIC_BASE_URL).replace(/\/+$/, ''),
  publicDownloadBase: str(process.env.PUBLIC_DOWNLOAD_BASE, '/download').replace(/\/+$/, ''),
  retentionKeepVersions: Math.max(1, num(process.env.RETENTION_KEEP_VERSIONS, 2)),

  // 服务
  port: num(process.env.PORT, 8787),
  host: str(process.env.HOST, '127.0.0.1'),
  adminToken: str(process.env.ADMIN_TOKEN),
  siteName: str(process.env.SITE_NAME),
};

/** 需要在日志与对外输出中脱敏的敏感值 */
export const SECRETS = [
  env.githubToken,
  env.adminToken,
  env.s3.accessKeyId,
  env.s3.secretAccessKey,
].filter((v) => typeof v === 'string' && v.length >= 4);

export function hasStorageCredentials() {
  if (env.storageDriver === 'local') return true;
  if (env.storageDriver === 's3') {
    const s = env.s3;
    return Boolean(s.bucket && s.accessKeyId && s.secretAccessKey && s.endpoint);
  }
  return false;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
