import { normalizeArch, isNonInstallableName } from '../../web/assets/shared.js';

/** 预编译项目配置里的 exclude / rules 正则 */
export function compileSource(source) {
  return {
    excludes: (source.exclude || []).map((pattern) => new RegExp(pattern, 'i')),
    rules: (source.rules || []).map((rule) => ({
      ...rule,
      re: new RegExp(rule.match, 'i'),
    })),
  };
}

export function roleOf(asset) {
  return [asset.platform, asset.arch, asset.format, asset.variant].join('|');
}

/**
 * 按项目配置把资产名映射到 {platform, arch, format, variant}。
 * 匹配不到时返回 null（前端只显示原始名称，不做推荐）。
 */
export function classifyAsset(source, compiled, asset) {
  const name = String(asset.name || '');
  if (!name) return null;
  if (isNonInstallableName(name)) return null;
  if (compiled.excludes.some((re) => re.test(name))) return null;

  for (const rule of compiled.rules) {
    const match = rule.re.exec(name);
    if (!match) continue;
    let rawArch = rule.arch || 'unknown';
    if (rawArch.startsWith('$')) {
      const group = rawArch.slice(1);
      rawArch = match.groups?.[group] || 'unknown';
    }
    const arch = normalizeArch(rule.platform, rawArch);
    return {
      ...asset,
      platform: rule.platform,
      arch,
      rawArch,
      format: rule.format,
      variant: rule.variant || 'default',
      role: roleOf({ platform: rule.platform, arch, format: rule.format, variant: rule.variant || 'default' }),
    };
  }
  return null;
}

/** 分类整个 Release 的资产；同时报告被忽略的文件，便于排查 */
export function classifyRelease(source, release) {
  const compiled = compileSource(source);
  const matched = [];
  const ignored = [];
  for (const asset of release?.assets || []) {
    const classified = classifyAsset(source, compiled, asset);
    if (classified) matched.push(classified);
    else ignored.push(asset.name);
  }
  return { matched, ignored };
}

/** 只保留项目声明支持的平台 */
export function filterByPlatform(source, assets) {
  const platforms = new Set(source.platforms || []);
  return assets.filter((a) => platforms.has(a.platform));
}
