import path from 'node:path';
import { env, writeJsonAtomic, hasStorageCredentials, storageIdentity } from './env.js';
import { classifyRelease, filterByPlatform } from './classify.js';
import { ARCH_ORDER, archLabel, formatLabel, variantLabel } from '../../web/assets/shared.js';

const VARIANT_RANK = { installer: 0, portable: 1, 'fixed-webview2': 2, desktop: 3, default: 1 };
const MAC_FORMAT_RANK = { dmg: 0, pkg: 1, zip: 2, '7z': 3 };

export const VERIFY_LABELS = {
  'official-checksums': '已与官方校验值核对',
  'github-digest': '与 GitHub 资产摘要一致',
  'self-only': '本站计算的哈希（未获得官方校验值）',
};

function downloadBase() {
  if (env.storageDriver === 's3' && env.s3PublicBaseUrl) return env.s3PublicBaseUrl;
  return env.publicDownloadBase;
}

function hrefFor(key) {
  if (!key) return null;
  return `${downloadBase()}/${String(key).replace(/^\/+/, '')}`;
}

const CURRENT_STORAGE = () => storageIdentity();

/**
 * 记录是否属于当前存储配置。
 * 严格匹配 storageId：不同存储（本地目录 ↔ 对象存储 ↔ 换桶）的记录一律不算可用，
 * 避免出现“状态说已同步、链接却 404”的情况。旧记录可用 scripts/migrate-state.js 迁移。
 */
function usableRecord(record) {
  if (!record || !record.key) return false;
  return record.storageId === CURRENT_STORAGE();
}

function findFallback(versions, role, excludeTag) {
  const tags = Object.keys(versions || {})
    .filter((tag) => tag !== excludeTag)
    .sort((a, b) => Date.parse(versions[b]?.syncedAt || 0) - Date.parse(versions[a]?.syncedAt || 0));
  for (const tag of tags) {
    const files = versions[tag]?.files || {};
    for (const record of Object.values(files)) {
      if (record.role === role && usableRecord(record)) return { version: tag, record };
    }
  }
  return null;
}

function optionSortKey(option, platform) {
  const archIndex = ARCH_ORDER[platform]?.indexOf(option.arch);
  const archRank = archIndex === undefined || archIndex < 0 ? 99 : archIndex;
  const variantRank = VARIANT_RANK[option.variant] ?? 4;
  const formatRank = platform === 'macos' ? MAC_FORMAT_RANK[option.format] ?? 5 : 0;
  const statusRank = option.status === 'ready' ? 0 : option.status === 'stale' ? 1 : 2;
  return [archRank, variantRank + formatRank, statusRank];
}

function compareOptions(a, b) {
  const ka = a.__sort;
  const kb = b.__sort;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return a.filename.localeCompare(b.filename);
}

function buildOption(source, asset, sourceState, latestTag, storageReady) {
  const versions = sourceState.versions || {};
  const mirrorEnabled = Boolean(source.mirror?.enabled);
  const exactRaw = versions[latestTag]?.files?.[asset.name] || null;
  const exact = usableRecord(exactRaw) ? exactRaw : null;
  const fallback = mirrorEnabled && !exact ? findFallback(versions, asset.role, latestTag) : null;

  const base = {
    arch: asset.arch,
    rawArch: asset.rawArch,
    archLabel: archLabel(asset.platform, asset.arch),
    format: asset.format,
    formatLabel: formatLabel(asset.format),
    variant: asset.variant,
    variantLabel: variantLabel(asset.variant),
    officialUrl: asset.url,
    officialSize: asset.size || 0,
    officialSizeExact: asset.sizeExact !== false,
    officialDigest: asset.digest || null,
  };

  if (exact) {
    return {
      ...base,
      status: 'ready',
      version: latestTag,
      filename: exact.filename,
      size: exact.size,
      sha256: exact.sha256,
      verified: exact.verified,
      verifiedLabel: VERIFY_LABELS[exact.verified] || VERIFY_LABELS['self-only'],
      href: hrefFor(exact.key),
      syncedAt: exact.syncedAt || null,
      note: '',
    };
  }

  if (fallback) {
    return {
      ...base,
      status: 'stale',
      version: fallback.version,
      filename: fallback.record.filename,
      size: fallback.record.size,
      sha256: fallback.record.sha256,
      verified: fallback.record.verified,
      verifiedLabel: VERIFY_LABELS[fallback.record.verified] || VERIFY_LABELS['self-only'],
      href: hrefFor(fallback.record.key),
      syncedAt: fallback.record.syncedAt || null,
      note: `官方最新版为 ${latestTag}，该版本本站尚未同步完成；当前可下载的是已校验的 ${fallback.version}。`,
    };
  }

  if (!mirrorEnabled) {
    return {
      ...base,
      status: 'official-only',
      version: latestTag,
      filename: asset.name,
      size: asset.size || 0,
      sha256: null,
      verified: null,
      verifiedLabel: '',
      href: null,
      syncedAt: null,
      note: source.mirror?.note || '该项目未授权本站镜像分发，仅提供官方下载入口。',
    };
  }

  return {
    ...base,
    status: 'unavailable',
    version: latestTag,
    filename: asset.name,
    size: asset.size || 0,
    sha256: null,
    verified: null,
    verifiedLabel: '',
    href: null,
    syncedAt: null,
    note: storageReady
      ? '本站安装包正在同步，尚未校验完成；可先使用官方下载。'
      : '本站尚未配置安装包存储，暂不提供镜像下载；请使用官方下载。',
  };
}

function summarizeItem(source, downloads, sourceState, storageReady) {
  const options = Object.values(downloads).flatMap((p) => p.options);
  const scoped = options.length;
  const ready = options.filter((o) => o.status === 'ready').length;
  const stale = options.filter((o) => o.status === 'stale').length;

  let syncState = 'pending';
  let syncMessage = '尚未开始检查官方发布';

  if (!source.mirror?.enabled) {
    syncState = 'official-only';
    syncMessage = '按许可证/发布条款，本站仅提供官方下载入口';
  } else if (!storageReady) {
    syncState = 'pending';
    syncMessage = '未配置安装包存储，仅提供官方下载入口';
  } else if (!sourceState.release) {
    if (sourceState.checkError) {
      syncState = 'failed';
      syncMessage = `采集失败：${sourceState.checkError}`;
    } else {
      syncState = 'pending';
      syncMessage = '尚未获取到官方发布信息';
    }
  } else if (scoped > 0 && ready === scoped) {
    syncState = 'ok';
    syncMessage = `本站已同步 ${sourceState.release.tag}`;
  } else if (ready > 0) {
    syncState = 'partial';
    syncMessage = `部分安装包已同步（${ready}/${scoped}）`;
  } else if (stale > 0) {
    syncState = 'stale';
    syncMessage = sourceState.release.tag + ' 尚未同步完成，当前可下载已校验的旧版本';
  } else if (sourceState.syncError) {
    syncState = 'failed';
    syncMessage = `同步失败：${sourceState.syncError}`;
  } else {
    syncState = 'syncing';
    syncMessage = `${sourceState.release.tag} 正在同步`;
  }

  return { syncState, syncMessage, counts: { total: scoped, ready, stale } };
}

export function buildSiteData({ sources, siteConfig, state, now = new Date() }) {
  const items = [];
  const dataSources = new Set();
  const warnings = [];
  const storageReady = hasStorageCredentials();

  if (!storageReady) {
    warnings.push(
      '本站尚未配置安装包存储（S3_* 或本地目录），因此不提供镜像下载，仅展示官方 GitHub 入口。',
    );
  } else if (env.storageDriver === 's3' && !env.s3PublicBaseUrl && !env.publicDownloadBase.startsWith('http')) {
    warnings.push('对象存储未配置公开访问前缀（S3_PUBLIC_BASE_URL），下载链接将走本站路由并依赖服务端签发。');
  }

  for (const source of sources) {
    const sourceState = state.sources?.[source.id] || {};
    if (sourceState.dataSource) dataSources.add(sourceState.dataSource);
    const release = sourceState.release || null;
    const { matched, ignored } = release
      ? classifyRelease(source, release)
      : { matched: [], ignored: [] };
    const scoped = release ? filterByPlatform(source, matched) : [];

    const downloads = {};
    for (const platform of source.platforms) {
      const options = scoped
        .filter((asset) => asset.platform === platform)
        .map((asset) => {
          const option = buildOption(source, asset, sourceState, release?.tag || '', storageReady);
          return { ...option, __sort: optionSortKey(option, platform) };
        })
        .sort(compareOptions)
        .map(({ __sort, ...rest }) => rest);
      downloads[platform] = { options };
    }

    const summary = summarizeItem(source, downloads, sourceState, storageReady);
    if (release && scoped.length === 0) {
      warnings.push(`${source.name}: 最新版本 ${release.tag} 中没有匹配到任何安装包，请检查匹配规则。`);
    }

    items.push({
      id: source.id,
      name: source.name,
      nameZh: source.nameZh || source.name,
      summary: source.summary,
      repo: source.repo,
      repoUrl: `https://github.com/${source.repo}`,
      homepage: source.homepage || `https://github.com/${source.repo}`,
      kindLabel: source.kindLabel || '图形客户端',
      platforms: source.platforms,
      status: source.status || 'active',
      statusNote: source.statusNote || '',
      license: source.license,
      mirrorEnabled: Boolean(source.mirror?.enabled),
      mirrorNote: source.mirror?.note || '',
      caveats: source.caveats || [],
      latest: release
        ? {
            tag: release.tag,
            name: release.name || release.tag,
            publishedAt: release.publishedAt,
            htmlUrl: release.htmlUrl,
            isPrereleaseTag: false,
          }
        : null,
      prereleases: (sourceState.prereleases || []).filter((p) => p.tag !== release?.tag),
      checkedAt: sourceState.lastCheckedAt || null,
      checkOkAt: sourceState.lastCheckOkAt || null,
      syncedAt: sourceState.lastSyncedAt || null,
      checkError: sourceState.checkError || null,
      syncError: sourceState.syncError || null,
      dataSource: sourceState.dataSource || null,
      dataSourceNote:
        sourceState.dataSource === 'html-fallback'
          ? '元数据来自 github.com 网页回退（API 限流），大小为近似值'
          : '',
      nextRetryAt: sourceState.nextRetryAt || null,
      ignoredFiles: ignored.length,
      downloads,
      ...summary,
    });
  }

  const generatedAt = now.toISOString();
  const payload = {
    schemaVersion: 1,
    generatedAt,
    dataSource:
      dataSources.size === 0 ? 'none' : dataSources.size > 1 ? 'mixed' : [...dataSources][0],
    site: {
      name: siteConfig.name,
      tagline: siteConfig.tagline,
      checkIntervalMinutes: env.checkIntervalMinutes,
      staleAfterMinutes: env.staleAfterMinutes,
      retentionKeepVersions: env.retentionKeepVersions,
      downloadMode: env.storageDriver,
      downloadBase,
      scope: siteConfig.scope || null,
      faq: siteConfig.faq || [],
    },
    totals: {
      items: items.length,
      mirrored: items.filter((i) => i.mirrorEnabled).length,
      withDownloads: items.filter((i) => i.counts.ready > 0).length,
    },
    warnings,
    items,
  };

  return payload;
}

export function publishSiteData({ sources, siteConfig, state, now }) {
  const data = buildSiteData({ sources, siteConfig, state, now });
  const file = path.join(env.webDir, 'data', 'site.json');
  writeJsonAtomic(file, data);
  return { data, file };
}
