import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createLogger } from './log.js';

const log = createLogger('http');

const USER_AGENT =
  'proxy-client-download-site/1.0 (+https://github.com/; github-release-mirror)';

/**
 * 允许访问的主机白名单。
 * 目的：避免把同步接口变成任意 URL 代理（SSRF），只允许 GitHub 官方域名。
 */
export const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'uploads.github.com',
]);

export function assertAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`无效的 URL：${rawUrl}`);
  }
  if (url.protocol !== 'https:') throw new Error(`只允许 https 下载源：${url.href}`);
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`不在允许列表中的下载源主机：${url.hostname}`);
  }
  return url;
}

export class HttpError extends Error {
  constructor(message, { status, url, retryAfter } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

export class RateLimitError extends Error {
  constructor(message, { resetAt } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt, base = 800, max = 20000) {
  const exp = Math.min(base * 2 ** attempt, max);
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

function parseRateLimit(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  return {
    remaining: remaining === null ? null : Number(remaining),
    resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
  };
}

/**
 * 带重试与超时的 JSON 请求（支持 ETag 条件请求）
 */
export async function fetchJson(url, options = {}) {
  const {
    etag,
    token,
    timeoutMs = 20000,
    retries = 3,
    allowNotModified = true,
    headers: extraHeaders = {},
  } = options;

  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const rate = parseRateLimit(res.headers);

      if (res.status === 304 && allowNotModified) {
        return { notModified: true, status: 304, etag, data: null, rate };
      }

      if (res.status === 403 || res.status === 429) {
        const bodyText = await res.text().catch(() => '');
        if (rate.remaining === 0 || /rate limit/i.test(bodyText)) {
          throw new RateLimitError(`GitHub API 限流：${bodyText.slice(0, 160)}`, {
            resetAt: rate.resetAt,
          });
        }
        throw new HttpError(`请求被拒绝（${res.status}）`, { status: res.status, url });
      }

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 408;
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const err = new HttpError(`HTTP ${res.status} ${url}`, {
          status: res.status,
          url,
          retryAfter,
        });
        if (!retryable || attempt === retries) throw err;
        lastError = err;
        await sleep(retryAfter ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new HttpError(`响应不是合法 JSON：${url}`, { status: res.status, url });
      }
      return { notModified: false, status: res.status, etag: res.headers.get('etag'), data, rate };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      lastError = error;
      if (attempt === retries) break;
      log.warn('请求失败，准备重试', { url, attempt, error: String(error?.message || error) });
      await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`请求失败：${url}`);
}

/** 抓取文本（HTML / Atom），带重试 */
export async function fetchText(url, options = {}) {
  const { timeoutMs = 25000, retries = 2, headers: extraHeaders = {} } = options;
  assertAllowedUrl(url);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...extraHeaders },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} ${url}`, { status: res.status, url });
        if (res.status < 500 || attempt === retries) throw err;
        lastError = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      return { text: await res.text(), finalUrl: res.url, status: res.status };
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`抓取失败：${url}`);
}

/** 跟随重定向解析最终 URL（用于 /releases/latest → tag） */
export async function resolveFinalUrl(url) {
  assertAllowedUrl(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  return { finalUrl: res.url, status: res.status };
}

const MAGIC_CHECK_BYTES = 64;

/**
 * 流式下载到临时文件：不把安装包读进内存。
 * 校验：HTTP 状态、总字节数、文件头魔数（防止把 HTML 错误页存成安装包）。
 */
export async function downloadToFile(url, destPath, options = {}) {
  const {
    expectedSize = null,
    maxBytes = null,
    timeoutMs = 15 * 60 * 1000,
    stallMs = 60 * 1000,
    onProgress = null,
  } = options;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  let currentUrl = url;
  let response = null;
  const controller = new AbortController();
  let stallTimer = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error('下载停滞超时')), stallMs);
  };
  const overallTimer = setTimeout(() => controller.abort(new Error('下载总超时')), timeoutMs);

  try {
    for (let hop = 0; hop < 6; hop += 1) {
      const target = assertAllowedUrl(currentUrl);
      resetStall();
      const res = await fetch(target, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'manual',
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new HttpError(`重定向缺少 Location：${currentUrl}`, { url: currentUrl });
        currentUrl = new URL(location, target).href;
        await res.arrayBuffer().catch(() => {});
        continue;
      }

      if (!res.ok) {
        throw new HttpError(`下载失败 HTTP ${res.status}：${currentUrl}`, {
          status: res.status,
          url: currentUrl,
        });
      }
      response = res;
      break;
    }

    if (!response) throw new HttpError(`重定向次数过多：${url}`, { url });

    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) {
      throw new HttpError(`下载源返回了 HTML 页面而不是安装包（Content-Type: ${contentType}）`, {
        url: currentUrl,
      });
    }

    const declaredSize = Number(response.headers.get('content-length')) || 0;

    const hash = crypto.createHash('sha256');
    const ws = fs.createWriteStream(destPath);
    let bytes = 0;
    let sample = Buffer.alloc(0);
    let lastReport = 0;

    const nodeStream = Readable.fromWeb(response.body);
    try {
      for await (const chunk of nodeStream) {
        bytes += chunk.length;
        hash.update(chunk);
        if (sample.length < MAGIC_CHECK_BYTES) {
          sample = Buffer.concat([sample, chunk.subarray(0, MAGIC_CHECK_BYTES - sample.length)]);
        }
        if (maxBytes && bytes > maxBytes) {
          throw new Error(`文件超过大小上限（>${Math.round(maxBytes / 1024 / 1024)}MB）`);
        }
        if (!ws.write(chunk)) await once(ws, 'drain');
        resetStall();
        const now = Date.now();
        if (onProgress && now - lastReport > 1000) {
          lastReport = now;
          onProgress({ bytes, declaredSize });
        }
      }
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    } catch (error) {
      ws.destroy();
      fs.rmSync(destPath, { force: true });
      throw error;
    }

    if (expectedSize && declaredSize && declaredSize !== expectedSize) {
      fs.rmSync(destPath, { force: true });
      throw new Error(`Content-Length（${declaredSize}）与发布记录（${expectedSize}）不一致`);
    }
    if (expectedSize && bytes !== expectedSize) {
      fs.rmSync(destPath, { force: true });
      throw new Error(`实际下载字节数（${bytes}）与发布记录（${expectedSize}）不一致`);
    }
    if (bytes === 0) {
      fs.rmSync(destPath, { force: true });
      throw new Error('下载内容为空');
    }

    return {
      bytes,
      sha256: hash.digest('hex'),
      sample: sample.toString('hex'),
      contentType,
      finalUrl: currentUrl,
    };
  } finally {
    clearTimeout(overallTimer);
    if (stallTimer) clearTimeout(stallTimer);
  }
}

/** 用文件头魔数判断内容是否与扩展名相符 */
export function checkMagic(format, sampleHex, signatures) {
  const allowed = signatures[format] || [];
  if (!allowed.length) return { ok: true, reason: '该格式无固定文件头，跳过魔数校验' };
  const hex = String(sampleHex || '').toLowerCase();
  if (allowed.some((sig) => hex.startsWith(sig))) return { ok: true, reason: '文件头符合预期' };
  const looksHtml = /^(3c21444f4354595045|3c68746d6c|0d0a3c68746d6c)/.test(hex) || hex.startsWith('3c');
  return {
    ok: false,
    reason: looksHtml
      ? '文件内容看起来是 HTML 页面（很可能是错误页），已拒绝'
      : `文件头与 ${format} 格式不符（${hex.slice(0, 16)}）`,
  };
}
