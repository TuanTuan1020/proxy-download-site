import { withLock } from './lock.js';
import { sourceList, loadSiteConfig, validateSources } from './config.js';
import { collectAll } from './collect-core.js';
import { syncAll } from './sync-core.js';
import { readState, updateState } from './state.js';
import { publishSiteData } from './publish.js';
import { createStore } from './store.js';
import { createLogger } from './log.js';
import { env, hasStorageCredentials } from './env.js';

const logger = createLogger('update');

/**
 * 一次完整更新：采集 → 同步 → 发布。
 * 使用文件锁避免定时任务与手动触发并发重复同步/上传。
 */
export async function runUpdate(options = {}) {
  const { reason = 'manual', only = null, force = false } = options;
  return withLock('update', { ttlMs: 20 * 60 * 1000 }, async () => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    const configErrors = validateSources();
    if (configErrors.length) {
      const message = `项目清单配置有误：${configErrors.join('；')}`;
      logger.error(message);
      throw new Error(message);
    }

    const allSources = sourceList();
    const sources = only?.length ? allSources.filter((s) => only.includes(s.id)) : allSources;
    if (!sources.length) throw new Error('没有匹配到任何项目，请检查 --source 参数');

    const siteConfig = loadSiteConfig();
    const log = createLogger('update');
    log.info('开始更新', { reason, projects: sources.length, force });

    const collectResults = await collectAll(sources, { logger: log, force });

    let syncResults = [];
    if (hasStorageCredentials()) {
      const store = createStore();
      const mirrorSources = sources.filter((s) => s.mirror?.enabled);
      if (mirrorSources.length) {
        syncResults = await syncAll(mirrorSources, {
          logger: log,
          store,
          sources: allSources,
          siteConfig,
          force,
        });
      }
    } else {
      log.warn('未配置存储凭据，跳过安装包同步，仅发布元数据', {
        driver: env.storageDriver,
      });
    }

    const state = readState();
    const { data } = publishSiteData({ sources: allSources, siteConfig, state });

    const summary = {
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      projects: sources.length,
      collect: {
        ok: collectResults.filter((r) => !r.error).length,
        failed: collectResults.filter((r) => r.error).length,
        notModified: collectResults.filter((r) => r.notModified).length,
        degraded: collectResults.filter((r) => r.degraded).length,
      },
      sync: {
        files: syncResults.reduce((n, r) => n + r.synced.length, 0),
        skipped: syncResults.reduce((n, r) => n + r.skipped.length, 0),
        failed: syncResults.reduce((n, r) => n + r.failed.length, 0),
      },
      storage: hasStorageCredentials() ? env.storageDriver : 'unconfigured',
      warnings: data.warnings,
    };

    await updateState((st) => {
      st.runs.push({ ...summary, triggeredBy: reason });
    });

    log.info('更新完成', summary);
    return summary;
  });
}
