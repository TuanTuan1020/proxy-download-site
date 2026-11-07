import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './lib/env.js';
import { readState } from './lib/state.js';
import { publishSiteData } from './lib/publish.js';
import { loadSiteConfig, sourceList, validateSources } from './lib/config.js';
import { createLogger, readRecentLogs } from './lib/log.js';
import { runUpdate } from './lib/update-core.js';
import { listLocks } from './lib/lock.js';
import { createStore } from './lib/store.js';
import { contentTypeForFilename, isStale } from '../web/assets/shared.js';

const logger = createLogger('server');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const scheduler = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastResult: null,
  nextRunAt: null,
  timer: null,
};

function downloadIndex() {
  const state = readState();
  const index = new Map();
  for (const sourceState of Object.values(state.sources || {})) {
    for (const [tag, version] of Object.entries(sourceState.versions || {})) {
      for (const record of Object.values(version.files || {})) {
        if (record?.key) index.set(record.key, { ...record, tag });
      }
    }
  }
  return index;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function serveFileRange(req, res, filePath, record) {
  const stat = await fsp.stat(filePath);
  const total = stat.size;
  const etag = `"${(record.sha256 || '').slice(0, 32) || stat.mtimeMs.toString(16)}"`;
  const baseHeaders = {
    'Content-Type': record.contentType || contentTypeForFilename(record.filename),
    'Content-Disposition': contentDisposition(record.filename || path.basename(filePath)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    let start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? total - 1 : Number(m[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    if (end >= total) end = total - 1;
    if (start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function handleDownload(req, res, urlPath) {
  const rawKey = decodeURIComponent(urlPath.replace(/^\/download\//, ''));
  const key = rawKey.replace(/^\/+/, '');

  if (!key.startsWith('packages/') || key.includes('..')) {
    return sendJson(res, 400, { error: '无效的下载路径' });
  }

  const record = downloadIndex().get(key);
  if (!record) {
    return sendJson(res, 404, {
      error: '该文件尚未同步完成或已下线',
      hint: '请使用页面上的“官方下载”入口，或稍后重试',
    });
  }

  if (env.storageDriver === 's3') {
    const store = createStore();
    const target = env.s3PublicBaseUrl ? store.publicUrl(key) : store.presignGet(key, 3600);
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    return res.end();
  }

  const store = createStore();
  const filePath = store.pathFor(key);
  try {
    await serveFileRange(req, res, filePath, record);
  } catch (error) {
    logger.error('读取安装包失败', { key, error: String(error?.message || error) });
    sendJson(res, 404, { error: '文件不存在', hint: '可能已被清理脚本移除，请刷新页面' });
  }
}

function staticTarget(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(env.webDir, rel);
  if (!full.startsWith(env.webDir + path.sep) && full !== path.join(env.webDir, 'index.html')) return null;
  return full;
}

async function handleStatic(req, res, urlPath) {
  const file = staticTarget(urlPath);
  if (!file) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) throw new Error('is directory');
    const ext = path.extname(file).toLowerCase();
    const isData = file.includes(`${path.sep}data${path.sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isData ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch {
    if (urlPath !== '/' && !urlPath.includes('.')) {
      // 前端为单页，未知路径回落到首页
      return handleStatic(req, res, '/');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function authorized(req) {
  if (!env.adminToken) return false;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length !== env.adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(env.adminToken));
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function publicStatus() {
  const state = readState();
  const site = JSON.parse(fs.readFileSync(path.join(env.webDir, 'data', 'site.json'), 'utf8'));
  return {
    generatedAt: site.generatedAt,
    stale: isStale(site.generatedAt, env.staleAfterMinutes),
    staleAfterMinutes: env.staleAfterMinutes,
    checkIntervalMinutes: env.checkIntervalMinutes,
    nextRunAt: scheduler.nextRunAt,
    scheduler: {
      running: scheduler.running,
      lastStartedAt: scheduler.lastStartedAt,
      lastFinishedAt: scheduler.lastFinishedAt,
      lastResult: scheduler.lastResult,
    },
    lastRuns: (state.runs || []).slice(-3),
    totals: site.totals,
    warnings: site.warnings,
  };
}

function adminStatus() {
  const state = readState();
  return {
    generatedAt: new Date().toISOString(),
    storage: { driver: env.storageDriver, publicDownloadBase: env.publicDownloadBase, s3PublicBaseUrl: env.s3PublicBaseUrl || null },
    github: { authenticated: Boolean(env.githubToken), htmlFallback: env.allowHtmlFallback },
    intervalMinutes: env.checkIntervalMinutes,
    scheduler: {
      running: scheduler.running,
      lastStartedAt: scheduler.lastStartedAt,
      lastFinishedAt: scheduler.lastFinishedAt,
      lastResult: scheduler.lastResult,
      nextRunAt: scheduler.nextRunAt,
    },
    locks: listLocks(),
    configErrors: validateSources(),
    runs: state.runs || [],
    sources: Object.fromEntries(
      Object.entries(state.sources || {}).map(([id, s]) => [
        id,
        {
          tag: s.release?.tag || null,
          lastCheckedAt: s.lastCheckedAt,
          lastCheckOkAt: s.lastCheckOkAt,
          lastSyncedAt: s.lastSyncedAt,
          checkError: s.checkError,
          syncError: s.syncError,
          dataSource: s.dataSource,
          consecutiveFailures: s.consecutiveFailures,
          nextRetryAt: s.nextRetryAt,
          assets: s.release?.assets?.length ?? 0,
          syncedFiles: Object.values(s.versions || {}).reduce((n, v) => n + Object.keys(v.files || {}).length, 0),
          assetErrors: s.assetErrors || {},
        },
      ]),
    ),
  };
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, ...publicStatus() });
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, publicStatus());
  }
  if (pathname.startsWith('/api/admin/')) {
    if (!env.adminToken) {
      return sendJson(res, 503, { error: '后台接口未启用：未配置 ADMIN_TOKEN' });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: '未授权', hint: '请携带 Authorization: Bearer <ADMIN_TOKEN>' });
    }
    if (pathname === '/api/admin/status' && req.method === 'GET') {
      return sendJson(res, 200, adminStatus());
    }
    if (pathname === '/api/admin/logs' && req.method === 'GET') {
      const lines = Math.min(Number(searchParams.get('lines')) || 100, 1000);
      return sendJson(res, 200, { lines: readRecentLogs(lines) });
    }
    if (pathname === '/api/admin/update' && req.method === 'POST') {
      if (scheduler.running) {
        return sendJson(res, 409, { error: '已有更新任务在运行', scheduler });
      }
      let body = {};
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      const only = Array.isArray(body.sources) && body.sources.length ? body.sources : null;
      scheduler.running = true;
      scheduler.lastStartedAt = new Date().toISOString();
      const runId = crypto.randomUUID();
      runUpdate({ reason: 'admin', only, force: Boolean(body.force) })
        .then((summary) => {
          scheduler.lastResult = summary;
        })
        .catch((error) => {
          scheduler.lastResult = { error: String(error?.message || error) };
          logger.error('手动更新失败', { error: String(error?.message || error) });
        })
        .finally(() => {
          scheduler.running = false;
          scheduler.lastFinishedAt = new Date().toISOString();
        });
      return sendJson(res, 202, { accepted: true, runId, only });
    }
    return sendJson(res, 404, { error: '未知的后台接口' });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

function scheduleNext() {
  const intervalMs = env.checkIntervalMinutes * 60 * 1000;
  scheduler.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  scheduler.timer = setTimeout(tick, intervalMs);
  if (scheduler.timer.unref) scheduler.timer.unref();
}

async function tick() {
  if (scheduler.running) {
    scheduleNext();
    return;
  }
  scheduler.running = true;
  scheduler.lastStartedAt = new Date().toISOString();
  try {
    const summary = await runUpdate({ reason: 'scheduler' });
    scheduler.lastResult = summary;
  } catch (error) {
    scheduler.lastResult = { error: String(error?.message || error) };
    logger.error('定时更新失败', { error: String(error?.message || error) });
  } finally {
    scheduler.running = false;
    scheduler.lastFinishedAt = new Date().toISOString();
    scheduleNext();
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname.startsWith('/download/')) return await handleDownload(req, res, url.pathname);
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        return await handleStatic(req, res, url.pathname);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
    } catch (error) {
      logger.error('请求处理失败', { path: url.pathname, error: String(error?.message || error) });
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
      else res.destroy();
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const port = Number(args.find((a) => a.startsWith('--port='))?.split('=')[1]) || env.port;
  const host = args.find((a) => a.startsWith('--host='))?.split('=')[1] || env.host;
  const updateOnStart = args.includes('--update-on-start');

  // 启动时至少发布一次站点数据，避免前端读不到文件
  try {
    publishSiteData({ sources: sourceList(), siteConfig: loadSiteConfig(), state: readState() });
  } catch (error) {
    logger.error('初始发布失败', { error: String(error?.message || error) });
  }

  const server = createServer();
  server.listen(port, host, () => {
    logger.info('站点已启动', { url: `http://${host}:${port}`, intervalMinutes: env.checkIntervalMinutes });
    console.log(`\n  本地预览： http://${host}:${port}\n`);
    scheduleNext();
    if (updateOnStart) {
      runUpdate({ reason: 'startup' }).catch((error) =>
        logger.error('启动更新失败', { error: String(error?.message || error) }),
      );
    }
  });

  const shutdown = () => {
    logger.info('正在停止服务');
    if (scheduler.timer) clearTimeout(scheduler.timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
