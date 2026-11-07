import path from 'node:path';
import { env, readJson } from './env.js';

export function loadSourcesConfig() {
  const file = path.join(env.configDir, 'sources.json');
  const config = readJson(file, null);
  if (!config || !Array.isArray(config.sources)) {
    throw new Error(`无法读取项目清单：${file}`);
  }
  return config;
}

export function loadSiteConfig() {
  const file = path.join(env.configDir, 'site.json');
  const site = readJson(file, null);
  if (!site) throw new Error(`无法读取站点配置：${file}`);
  if (env.siteName) site.name = env.siteName;
  return site;
}

export function sourceList() {
  return loadSourcesConfig().sources;
}

export function findSource(id) {
  return sourceList().find((s) => s.id === id) || null;
}

/** 配置自检：尽早暴露拼错的正则、重复 id、缺少必填字段 */
export function validateSources(config = loadSourcesConfig()) {
  const errors = [];
  const seen = new Set();
  for (const source of config.sources) {
    const label = source.id || '(缺少 id)';
    for (const field of ['id', 'name', 'summary', 'repo', 'platforms', 'rules', 'license']) {
      if (!source[field]) errors.push(`${label}: 缺少字段 ${field}`);
    }
    if (seen.has(source.id)) errors.push(`${label}: id 重复`);
    seen.add(source.id);
    if (!/^[\w.-]+\/[\w.-]+$/.test(source.repo || '')) errors.push(`${label}: repo 格式应为 owner/name`);
    for (const platform of source.platforms || []) {
      if (!['windows', 'macos', 'android'].includes(platform)) {
        errors.push(`${label}: 不支持的平台 ${platform}`);
      }
    }
    for (const pattern of source.exclude || []) {
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        errors.push(`${label}: exclude 正则无效 ${pattern}（${error.message}）`);
      }
    }
    for (const rule of source.rules || []) {
      try {
        new RegExp(rule.match, 'i');
      } catch (error) {
        errors.push(`${label}: 规则正则无效 ${rule.match}（${error.message}）`);
      }
      if (!['windows', 'macos', 'android'].includes(rule.platform)) {
        errors.push(`${label}: 规则平台无效 ${rule.platform}`);
      }
      if (!rule.format) errors.push(`${label}: 规则缺少 format（${rule.match}）`);
    }
    if (source.mirror?.enabled && source.license?.redistribution === 'official-only') {
      errors.push(`${label}: 许可证标记为 official-only，但 mirror.enabled=true，配置冲突`);
    }
  }
  return errors;
}
