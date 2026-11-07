import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './env.js';
import { createLogger } from './log.js';

const log = createLogger('store');

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function awsEncodePath(key) {
  return key
    .split('/')
    .map((segment) => awsEncode(segment))
    .join('/');
}

export class LocalStore {
  constructor(cfg = env) {
    this.driver = 'local';
    this.base = path.resolve(cfg.localStorageDir);
    fs.mkdirSync(this.base, { recursive: true });
    this.publicBase = cfg.publicDownloadBase;
  }

  pathFor(key) {
    const normalized = String(key).replace(/^\/+/, '');
    if (normalized.includes('..')) throw new Error(`非法的存储键：${key}`);
    const full = path.resolve(this.base, normalized);
    if (!full.startsWith(this.base + path.sep) && full !== this.base) {
      throw new Error(`存储键越界：${key}`);
    }
    return full;
  }

  async putFile(sourcePath, key) {
    const dest = this.pathFor(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(sourcePath, dest);
    } catch (error) {
      if (error.code === 'EXDEV') {
        fs.copyFileSync(sourcePath, dest);
        fs.rmSync(sourcePath, { force: true });
      } else {
        throw error;
      }
    }
    return { key, size: fs.statSync(dest).size };
  }

  exists(key) {
    return fs.existsSync(this.pathFor(key));
  }

  stat(key) {
    try {
      const st = fs.statSync(this.pathFor(key));
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async remove(key) {
    fs.rmSync(this.pathFor(key), { force: true });
  }

  publicUrl(key) {
    return `${this.publicBase}/${String(key).replace(/^\/+/, '')}`;
  }

  describe() {
    return { driver: this.driver, base: this.base, publicBase: this.publicBase };
  }
}

export class S3Store {
  constructor(cfg = env) {
    const s3 = cfg.s3;
    if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
      throw new Error('S3 存储配置不完整：需要 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY');
    }
    this.driver = 's3';
    this.endpoint = s3.endpoint.replace(/\/+$/, '');
    this.region = s3.region || 'auto';
    this.bucket = s3.bucket;
    this.accessKeyId = s3.accessKeyId;
    this.secretAccessKey = s3.secretAccessKey;
    this.publicBase = cfg.s3PublicBaseUrl || cfg.publicDownloadBase;
  }

  #target(key) {
    const base = new URL(this.endpoint);
    const prefix = base.pathname.replace(/\/+$/, '');
    const encodedKey = awsEncodePath(String(key).replace(/^\/+/, ''));
    return {
      host: base.host,
      canonicalUri: `${prefix}/${awsEncode(this.bucket)}/${encodedKey}`,
      url: `${base.protocol}//${base.host}${prefix}/${awsEncode(this.bucket)}/${encodedKey}`,
    };
  }

  #sign({ method, canonicalUri, host, amzDate, payloadHash, extraHeaders = {} }) {
    const dateStamp = amzDate.slice(0, 8);
    const headers = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };
    const sortedNames = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort();
    const canonicalHeaders = sortedNames
      .map((name) => `${name}:${String(headers[name] ?? headers[name.toLowerCase()]).trim()}\n`)
      .join('');
    const signedHeaders = sortedNames.join(';');
    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      headers,
    };
  }

  async putFile(sourcePath, key, { contentType = 'application/octet-stream', filename = '' } = {}) {
    const target = this.#target(key);
    const size = fs.statSync(sourcePath).size;
    const disposition = filename
      ? `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      : 'attachment';
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const signed = this.#sign({
      method: 'PUT',
      canonicalUri: target.canonicalUri,
      host: target.host,
      amzDate,
      payloadHash: 'UNSIGNED-PAYLOAD',
      extraHeaders: { 'content-type': contentType, 'content-disposition': disposition },
    });

    const res = await fetch(target.url, {
      method: 'PUT',
      headers: {
        ...signed.headers,
        Authorization: signed.authorization,
        'Content-Length': String(size),
        'Content-Type': contentType,
        'Content-Disposition': disposition,
      },
      body: fs.createReadStream(sourcePath),
      duplex: 'half',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`上传到对象存储失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    log.info('已上传对象', { key, size });
    return { key, size };
  }

  async head(key) {
    const target = this.#target(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const signed = this.#sign({
      method: 'HEAD',
      canonicalUri: target.canonicalUri,
      host: target.host,
      amzDate,
      payloadHash: 'UNSIGNED-PAYLOAD',
    });
    const res = await fetch(target.url, {
      method: 'HEAD',
      headers: { ...signed.headers, Authorization: signed.authorization },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`对象存储 HEAD 失败：HTTP ${res.status}`);
    return { size: Number(res.headers.get('content-length')) || 0 };
  }

  exists(key) {
    return this.head(key).then((r) => Boolean(r));
  }

  async remove(key) {
    const target = this.#target(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const signed = this.#sign({
      method: 'DELETE',
      canonicalUri: target.canonicalUri,
      host: target.host,
      amzDate,
      payloadHash: 'UNSIGNED-PAYLOAD',
    });
    const res = await fetch(target.url, {
      method: 'DELETE',
      headers: { ...signed.headers, Authorization: signed.authorization },
    });
    if (!res.ok && res.status !== 404) throw new Error(`删除对象失败：HTTP ${res.status}`);
  }

  publicUrl(key) {
    if (env.s3PublicBaseUrl) return `${env.s3PublicBaseUrl}/${String(key).replace(/^\/+/, '')}`;
    return `${env.publicDownloadBase}/${String(key).replace(/^\/+/, '')}`;
  }

  /** 私有桶时，下载路由用它签发临时 GET 地址 */
  presignGet(key, expiresSeconds = 3600) {
    const target = this.#target(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const params = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(Math.min(expiresSeconds, 604800)),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(params)
      .sort()
      .map((k) => `${awsEncode(k)}=${awsEncode(params[k])}`)
      .join('&');
    const canonicalRequest = [
      'GET',
      target.canonicalUri,
      canonicalQuery,
      `host:${target.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    return `${target.url}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  describe() {
    return { driver: this.driver, endpoint: this.endpoint, bucket: this.bucket, publicBase: this.publicBase };
  }
}

export function createStore(cfg = env) {
  if (cfg.storageDriver === 's3') return new S3Store(cfg);
  return new LocalStore(cfg);
}

/** 供本地下载路由读取文件（仅 local 驱动） */
export function localFilePathFor(key) {
  return new LocalStore(env).pathFor(key);
}
