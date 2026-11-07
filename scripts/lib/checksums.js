import { fetchText } from './http.js';
import { createLogger } from './log.js';

const log = createLogger('checksums');

/**
 * 尽力获取上游发布的官方校验值。
 * 支持两种形式：
 *   type=sumfile  → 发布中有一个 SHA256SUMS 之类清单文件
 *   type=siblings → 每个资产旁有 <name>.sha256 单文件摘要
 * 拿不到就返回空表，调用方退回“本站计算哈希”，绝不把自算哈希说成官方校验。
 */
export async function fetchOfficialChecksums(source, release) {
  const map = new Map();
  const cfg = source.checksum;
  if (!cfg || !release?.assets?.length) return map;

  try {
    if (cfg.type === 'sumfile') {
      const asset = release.assets.find((a) => a.name === cfg.file);
      if (!asset) return map;
      const { text } = await fetchText(asset.url);
      for (const line of text.split(/\r?\n/)) {
        const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
        if (m) map.set(m[2].trim(), m[1].toLowerCase());
      }
      log.info('已读取官方校验清单', { repo: source.repo, entries: map.size });
      return map;
    }

    if (cfg.type === 'siblings') {
      const sidecars = release.assets.filter((a) => /\.sha256$/i.test(a.name));
      for (const sidecar of sidecars) {
        const targetName = sidecar.name.replace(/\.sha256$/i, '');
        try {
          const { text } = await fetchText(sidecar.url);
          const m = /([0-9a-f]{64})/i.exec(text);
          if (m) map.set(targetName, m[1].toLowerCase());
        } catch (error) {
          log.warn('读取校验文件失败', { file: sidecar.name, error: String(error?.message || error) });
        }
      }
      return map;
    }
  } catch (error) {
    log.warn('获取官方校验值失败，将只记录本站计算的哈希', {
      repo: source.repo,
      error: String(error?.message || error),
    });
  }
  return map;
}
