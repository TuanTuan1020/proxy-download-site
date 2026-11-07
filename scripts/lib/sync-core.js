import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { readState, updateState, getSourceState, pruneVersions } from './state.js';
import { classifyRelease, filterByPlatform } from './classify.js';
import { fetchOfficialChecksums } from './checksums.js';
import { downloadToFile, checkMagic, assertAllowedUrl } from './http.js';
import { createStore } from './store.js';
import { createLogger } from './log.js';
import { publishSiteData } from './publish.js';
import { loadSiteConfig, sourceList } from './config.js';
import { MAGIC_SIGNATURES, contentTypeForFilename } from '../../web/assets/shared.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 存储键：packages/<id>/<tag>/<filename>，版本化避免 CDN 缓存混淆 */
export function keyFor(sourceId, tag, filename) {
  const safeTag = String(tag).replace(/[^\w.+\-]/g, '_');
  const safeName = String(filename).replace(/[/\\?%*:|"<>]/g, '_');
  return `packages/${sourceId}/${safeTag}/${safeName}`;
}

function backoff(attempt) {
  return Math.round(Math.min(1500 * 2 ** attempt, 30000) * (0.7 + Math.random() * 0.6));
}

async function downloadWithRetry(asset, destPath, { logger, maxBytes }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await downloadToFile(asset.url, destPath, {
        expectedSize: asset.sizeExact ? asset.size : null,
        maxBytes,
        onProgress: ({ bytes }) => logger.debug('下载进度', { file: asset.name, bytes }),
      });
    } catch (error) {
      lastError = error;
      logger.warn('下载失败，准备重试', {
        file: asset.name,
        attempt: attempt + 1,
        error: String(error?.message || error),
      });
      if (attempt < 2) await sleep(backoff(attempt));
    }
  }
  throw lastError;
}

function isUnchanged(record, asset) {
  if (!record) return false;
  if ((record.assetUpdatedAt || null) !== (asset.updatedAt || null)) return false;
  if ((record.officialDigest || null) !== (asset.digest || null)) return false;
  if (asset.sizeExact && record.size !== asset.size) return false;
  return true;
}

/**
 * 同步一个项目的所有匹配资产。
 * 单个资产失败不影响其他资产，也不会破坏已成功版本的下载指向。
 */
export async function syncSource(source, options = {}) {
  const logger = options.logger || createLogger(`sync:${source.id}`);
  const store = options.store || createStore();
  const force = Boolean(options.force);
  const onlyFiles = options.onlyFiles ? new Set(options.onlyFiles) : null;

  const state = readState();
  const sourceState = state.sources?.[source.id];
  const release = sourceState?.release;

  const result = { id: source.id, synced: [], skipped: [], failed: [], notes: [] };

  if (!source.mirror?.enabled) {
    result.notes.push('按许可证/发布条款仅提供官方入口，不同步文件');
    return result;
  }
  if (!release) {
    result.notes.push('尚无发布信息，跳过同步');
    return result;
  }

  const { matched } = classifyRelease(source, release);
  const scoped = filterByPlatform(source, matched);
  if (!scoped.length) {
    result.notes.push(`最新版本 ${release.tag} 没有匹配到安装包`);
    return result;
  }

  const checksums = await fetchOfficialChecksums(source, release);
  const maxBytes = env.maxAssetMb * 1024 * 1024;
  const versions = sourceState.versions || {};

  for (const asset of scoped) {
    if (onlyFiles && !onlyFiles.has(asset.name)) continue;
    const label = `${source.id} ${asset.name}`;

    if (asset.size && asset.size > maxBytes) {
      result.skipped.push({ file: asset.name, reason: `超过体积上限 ${env.maxAssetMb}MB` });
      logger.warn('安装包超过体积上限，跳过', { file: asset.name, size: asset.size });
      continue;
    }

    const existing = versions[release.tag]?.files?.[asset.name];
    if (!force && isUnchanged(existing, asset)) {
      const onDisk = await Promise.resolve(store.exists(existing.key)).catch(() => false);
      if (onDisk) {
        result.skipped.push({ file: asset.name, reason: '已同步且未变化' });
        continue;
      }
    }

    const key = keyFor(source.id, release.tag, asset.name);
    const tmpFile = path.join(env.tmpDir, `${source.id}-${Date.now()}-${asset.name.replace(/[^\w.\-]/g, '_')}`);

    try {
      assertAllowedUrl(asset.url);
      logger.info('开始同步安装包', { file: asset.name, size: asset.size });
      const download = await downloadWithRetry(asset, tmpFile, { logger, maxBytes });

      const magic = checkMagic(asset.format, download.sample, MAGIC_SIGNATURES);
      if (!magic.ok) throw new Error(magic.reason);

      const official = checksums.get(asset.name);
      let verified = 'self-only';
      if (official) {
        if (official !== download.sha256) {
          throw new Error(`SHA-256 与官方校验值不一致（官方 ${official}，实际 ${download.sha256}）`);
        }
        verified = 'official-checksums';
      } else if (asset.digest) {
        if (asset.digest !== download.sha256) {
          throw new Error(`SHA-256 与 GitHub 资产摘要不一致（摘要 ${asset.digest}，实际 ${download.sha256}）`);
        }
        verified = 'github-digest';
      }

      await store.putFile(tmpFile, key, { contentType: contentTypeForFilename(asset.name), filename: asset.name });
      fs.rmSync(tmpFile, { force: true });

      const syncTime = new Date().toISOString();
      const record = {
        filename: asset.name,
        role: asset.role,
        platform: asset.platform,
        arch: asset.arch,
        format: asset.format,
        variant: asset.variant,
        key,
        size: download.bytes,
        sha256: download.sha256,
        verified,
        officialDigest: asset.digest || null,
        assetId: asset.id || null,
        assetUpdatedAt: asset.updatedAt || null,
        officialUrl: asset.url,
        publishedAt: release.publishedAt || null,
        syncedAt: syncTime,
        contentType: download.contentType || contentTypeForFilename(asset.name),
      };

      await updateState((st) => {
        const ss = getSourceState(st, source.id);
        ss.versions[release.tag] = ss.versions[release.tag] || { syncedAt: syncTime, files: {} };
        ss.versions[release.tag].syncedAt = syncTime;
        ss.versions[release.tag].files[asset.name] = record;
        ss.lastSyncedAt = syncTime;
        ss.syncError = null;
        if (ss.assetErrors) delete ss.assetErrors[asset.name];
        const removed = pruneVersions(ss, env.retentionKeepVersions);
        if (removed.length) ss.prunedKeys = [...new Set([...(ss.prunedKeys || []), ...removed])];
      });

      // 每个文件校验通过后立即原子发布站点数据，确保下载指向永不指向未完成文件
      const fresh = readState();
      publishSiteData({
        sources: options.sources || sourceList(),
        siteConfig: options.siteConfig || loadSiteConfig(),
        state: fresh,
      });

      result.synced.push({ file: asset.name, size: download.bytes, sha256: download.sha256, verified });
      logger.info('安装包同步完成', { file: asset.name, verified, bytes: download.bytes, label });
    } catch (error) {
      const message = String(error?.message || error);
      fs.rmSync(tmpFile, { force: true });
      result.failed.push({ file: asset.name, error: message });
      logger.error('安装包同步失败（保留旧版本）', { file: asset.name, error: message });
      await updateState((st) => {
        const ss = getSourceState(st, source.id);
        ss.assetErrors = ss.assetErrors || {};
        ss.assetErrors[asset.name] = { error: message, at: new Date().toISOString() };
        ss.syncError = `${asset.name}: ${message}`;
      });
    }
  }

  return result;
}

/** 并发同步多个项目（每个项目内部串行，避免重复上传/带宽争抢） */
export async function syncAll(sources, options = {}) {
  const logger = options.logger || createLogger('sync');
  const store = options.store || createStore();
  const siteConfig = options.siteConfig || loadSiteConfig();
  const results = [];
  const queue = [...sources];
  const workers = Math.min(env.maxParallelSync, queue.length) || 1;

  const run = async () => {
    while (queue.length) {
      const source = queue.shift();
      try {
        results.push(
          await syncSource(source, { ...options, logger: createLogger(`sync:${source.id}`), store, siteConfig }),
        );
      } catch (error) {
        logger.error('项目同步异常', { id: source.id, error: String(error?.message || error) });
        results.push({ id: source.id, synced: [], skipped: [], failed: [{ file: '*', error: String(error?.message || error) }], notes: [] });
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
