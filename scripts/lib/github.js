import { env } from './env.js';
import { fetchJson, fetchText, resolveFinalUrl } from './http.js';
import { createLogger } from './log.js';
import { looksPrerelease } from '../../web/assets/shared.js';

const log = createLogger('github');

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function normalizeApiRelease(json) {
  return {
    id: json.id ?? null,
    tag: json.tag_name,
    name: json.name || json.tag_name,
    publishedAt: json.published_at || json.created_at || null,
    draft: Boolean(json.draft),
    prerelease: Boolean(json.prerelease),
    htmlUrl: json.html_url || null,
    body: json.body ? String(json.body).slice(0, 6000) : '',
    assets: (json.assets || []).map((a) => ({
      id: a.id ?? null,
      name: a.name,
      size: Number(a.size) || 0,
      sizeExact: true,
      contentType: a.content_type || '',
      updatedAt: a.updated_at || null,
      // GitHub 会在 API 中返回 sha256 资产摘要
      digest: (a.digest || '').replace(/^sha256:/, '').toLowerCase() || null,
      url: a.browser_download_url,
      downloadCount: a.download_count ?? null,
    })),
  };
}

/** 解析 releases.atom（HTML 回退用） */
export function parseAtom(xml) {
  const entries = [];
  const blocks = String(xml).split('<entry>').slice(1);
  for (const block of blocks) {
    const title = /<title>([^<]*)<\/title>/.exec(block)?.[1] || '';
    const updated = /<updated>([^<]*)<\/updated>/.exec(block)?.[1] || null;
    const link = /<link[^>]+href="([^"]+)"/.exec(block)?.[1] || null;
    const tag = /\/releases\/tag\/(?:[^"/]+\/)*([^"/]+)$/.exec(link || '')?.[1];
    entries.push({
      tag: decodeURIComponent(tag || title.trim()),
      updatedAt: updated,
      htmlUrl: link,
    });
  }
  return entries;
}

/**
 * 解析 expanded_assets 片段：资产名、sha256 摘要、大小。
 * 这里的 size 是 GitHub 展示值（1 位小数、1024 进制），只能当近似值用。
 */
export function parseExpandedAssets(html, repo) {
  const text = String(html);
  const assets = [];
  const positions = [];
  let cursor = -1;
  while ((cursor = text.indexOf('/releases/download/', cursor + 1)) !== -1) {
    positions.push(cursor);
  }
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : Math.min(text.length, start + 4000);
    const block = text.slice(start, end);
    const quoteAt = text.indexOf('"', start);
    if (quoteAt === -1) continue;
    const segment = text.slice(start, quoteAt); // /releases/download/<tag>/<file>
    const rest = segment.slice('/releases/download/'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) continue;
    const tag = rest.slice(0, slash);
    let name;
    try {
      name = decodeURIComponent(rest.slice(slash + 1));
    } catch {
      name = rest.slice(slash + 1);
    }
    const digest = /sha256:([0-9a-f]{64})/i.exec(block)?.[1]?.toLowerCase() || null;
    const sizeMatch = /text-right[^>]*>\s*([\d.]+)\s*(B|KB|MB|GB)\s*</.exec(block);
    const size = sizeMatch
      ? Math.round(Number(sizeMatch[1]) * (SIZE_UNITS[sizeMatch[2]] || 1))
      : 0;
    assets.push({
      id: null,
      name,
      size,
      sizeExact: false,
      contentType: '',
      updatedAt: null,
      digest,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
      downloadCount: null,
    });
  }
  return assets;
}

async function fetchReleasesHtml(repo) {
  const atom = await fetchText(`https://github.com/${repo}/releases.atom`);
  const entries = parseAtom(atom.text);
  if (!entries.length) throw new Error('Atom 中没有找到任何 Release');

  const latest = await resolveFinalUrl(`https://github.com/${repo}/releases/latest`);
  const stableTag = decodeURIComponent(
    latest.finalUrl.split('/releases/tag/')[1]?.split('/')[0] || '',
  );
  if (!stableTag) throw new Error('无法解析最新稳定版标签');

  const stableIdx = entries.findIndex((e) => e.tag === stableTag);
  const stableEntry = stableIdx >= 0 ? entries[stableIdx] : entries[0];

  const assetsHtml = await fetchText(
    `https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(stableTag)}`,
  );
  const assets = parseExpandedAssets(assetsHtml.text, repo);

  const releases = [
    {
      id: null,
      tag: stableTag,
      name: stableTag,
      publishedAt: stableEntry?.updatedAt || null,
      draft: false,
      prerelease: false,
      htmlUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(stableTag)}`,
      body: '',
      assets,
    },
  ];

  // 比最新稳定版更新、但不是 latest 的条目 → 预发布版（仅元数据，不做镜像）
  if (stableIdx > 0) {
    for (const entry of entries.slice(0, stableIdx)) {
      if (entry.tag === stableTag) continue;
      releases.push({
        id: null,
        tag: entry.tag,
        name: entry.tag,
        publishedAt: entry.updatedAt,
        draft: false,
        prerelease: true,
        htmlUrl: entry.htmlUrl,
        body: '',
        assets: [],
      });
    }
  }
  return releases;
}

/**
 * 采集一个项目的 Release 列表。
 * 优先 REST API（支持 ETag 条件请求）；限流/失败时可退回 github.com 页面。
 */
export async function fetchReleases(source, previous = {}) {
  const apiUrl = `${env.githubApiBase}/repos/${source.repo}/releases?per_page=${env.releasesPageSize}`;
  try {
    const res = await fetchJson(apiUrl, { etag: previous.etag || undefined, token: env.githubToken });
    if (res.notModified) {
      return { notModified: true, etag: previous.etag || null, releases: null, rate: res.rate };
    }
    const releases = (res.data || [])
      .map(normalizeApiRelease)
      .filter((r) => !r.draft)
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
    return {
      notModified: false,
      etag: res.etag || null,
      releases,
      rate: res.rate,
      dataSource: 'github-rest',
    };
  } catch (error) {
    const status = error?.status;
    if (status === 404) throw new Error(`仓库不存在或不可访问：${source.repo}`);
    if (!env.allowHtmlFallback) throw error;

    log.warn('REST 采集失败，切换到网页回退', {
      repo: source.repo,
      error: String(error?.message || error),
    });
    const releases = await fetchReleasesHtml(source.repo);
    return {
      notModified: false,
      etag: null,
      releases,
      dataSource: 'html-fallback',
      degradedReason: String(error?.message || error).slice(0, 300),
      rate: null,
    };
  }
}

export function pickReleases(releases) {
  const stable = releases.filter((r) => !r.prerelease);
  const prerelease = releases.filter((r) => r.prerelease);
  const latestStable = stable[0] || null;
  return {
    latestStable,
    recentStable: stable.slice(0, 5),
    prereleases: prerelease.slice(0, 3).map((r) => ({
      tag: r.tag,
      name: r.name,
      publishedAt: r.publishedAt,
      htmlUrl: r.htmlUrl,
      heuristic: r.assets.length === 0,
    })),
    looksPrereleaseTag: latestStable ? looksPrerelease(latestStable.tag) : false,
  };
}
