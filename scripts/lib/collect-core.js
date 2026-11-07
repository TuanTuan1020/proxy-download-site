import { env } from './env.js';
import { fetchReleases, pickReleases } from './github.js';
import { updateState, readState, getSourceState } from './state.js';
import { createLogger } from './log.js';
import { publishSiteData } from './publish.js';
import { loadSiteConfig } from './config.js';

const logger = createLogger('collect');

function retryDelayMs(failures) {
  const base = 60 * 1000;
  const max = env.retryBackoffMaxSeconds * 1000;
  const raw = base * 2 ** Math.max(0, failures - 1);
  return Math.min(raw, max);
}

/**
 * 采集单个项目的 Release 元数据。
 * - 使用 ETag 条件请求，未变化时只更新“最近检查时间”
 * - 失败时记录错误、退避，并保留上一次成功数据
 */
export async function collectSource(source, options = {}) {
  const log = options.logger || logger;
  const state = readState();
  const sourceState = state.sources?.[source.id] || {};
  const now = Date.now();

  if (sourceState.nextRetryAt && Date.parse(sourceState.nextRetryAt) > now && !options.force) {
    return {
      id: source.id,
      skipped: true,
      reason: `退避中，下次重试 ${sourceState.nextRetryAt}`,
    };
  }

  try {
    const result = await fetchReleases(source, sourceState);
    const checkedAt = new Date().toISOString();

    if (result.notModified) {
      await updateState((st) => {
        const ss = getSourceState(st, source.id);
        ss.lastCheckedAt = checkedAt;
        ss.checkError = null;
        ss.consecutiveFailures = 0;
        ss.nextRetryAt = null;
      });
      log.info('未变化（ETag 命中）', { id: source.id });
      return { id: source.id, notModified: true };
    }

    const picked = pickReleases(result.releases || []);
    if (!picked.latestStable) {
      throw new Error('没有找到稳定版 Release');
    }

    const latest = picked.latestStable;
    const snapshot = {
      id: latest.id,
      tag: latest.tag,
      name: latest.name,
      publishedAt: latest.publishedAt,
      htmlUrl: latest.htmlUrl,
      assets: latest.assets.map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        sizeExact: a.sizeExact !== false,
        digest: a.digest || null,
        updatedAt: a.updatedAt || null,
        contentType: a.contentType || '',
        url: a.url,
      })),
    };

    await updateState((st) => {
      const ss = getSourceState(st, source.id);
      const prevTag = ss.release?.tag || null;
      ss.release = snapshot;
      ss.prereleases = picked.prereleases;
      ss.etag = result.etag || null;
      ss.dataSource = result.dataSource || 'github-rest';
      ss.lastCheckedAt = checkedAt;
      ss.lastCheckOkAt = checkedAt;
      ss.checkError = null;
      ss.consecutiveFailures = 0;
      ss.nextRetryAt = null;
      ss.lastChangeAt =
        prevTag === snapshot.tag ? ss.lastChangeAt || checkedAt : checkedAt;
    });

    log.info('采集完成', {
      id: source.id,
      tag: snapshot.tag,
      assets: snapshot.assets.length,
      dataSource: result.dataSource,
    });

    return {
      id: source.id,
      tag: snapshot.tag,
      assets: snapshot.assets.length,
      dataSource: result.dataSource,
      degraded: result.dataSource === 'html-fallback',
    };
  } catch (error) {
    const message = String(error?.message || error);
    await updateState((st) => {
      const ss = getSourceState(st, source.id);
      ss.lastCheckedAt = new Date().toISOString();
      ss.checkError = message.slice(0, 500);
      ss.consecutiveFailures = (ss.consecutiveFailures || 0) + 1;
      ss.nextRetryAt = new Date(Date.now() + retryDelayMs(ss.consecutiveFailures)).toISOString();
    });
    log.error('采集失败（保留上一次成功数据）', { id: source.id, error: message });
    return { id: source.id, error: message };
  }
}

export async function collectAll(sources, options = {}) {
  const log = options.logger || logger;
  const results = [];
  for (const source of sources) {
    results.push(await collectSource(source, { ...options, logger: log }));
  }
  return results;
}

/** 采集并发布站点数据（不触发文件同步） */
export async function collectAndPublish(sources, siteConfig = loadSiteConfig()) {
  const results = await collectAll(sources);
  const state = readState();
  publishSiteData({ sources, siteConfig, state });
  return results;
}
