import { parseArgs } from './lib/cli.js';
import { syncAll } from './lib/sync-core.js';
import { publishSiteData } from './lib/publish.js';
import { readState } from './lib/state.js';
import { createStore } from './lib/store.js';
import { hasStorageCredentials } from './lib/env.js';
import { loadSiteConfig, sourceList } from './lib/config.js';

const args = parseArgs();
const only = args.list('source');
const all = sourceList();
const mirrorSources = all.filter((s) => s.mirror?.enabled && (!only.length || only.includes(s.id)));

if (!hasStorageCredentials()) {
  console.error('未配置存储凭据（STORAGE_DRIVER 相关变量），无法同步安装包。');
  console.error('本地演示可直接使用 local 驱动：STORAGE_DRIVER=local');
  process.exit(1);
}
if (!mirrorSources.length) {
  console.error('没有需要同步的项目（可能都未开启 mirror 或 --source 未匹配）');
  process.exit(1);
}

const files = args.list('file');
const results = await syncAll(mirrorSources, {
  store: createStore(),
  sources: all,
  siteConfig: loadSiteConfig(),
  force: args.has('force'),
  onlyFiles: files.length ? files : null,
});

publishSiteData({ sources: all, siteConfig: loadSiteConfig(), state: readState() });

for (const r of results) {
  console.log(
    `\n[${r.id}] 成功 ${r.synced.length} / 跳过 ${r.skipped.length} / 失败 ${r.failed.length}`,
  );
  for (const n of r.notes) console.log(`  · ${n}`);
  for (const s of r.synced) console.log(`  ✓ ${s.file} (${s.verified})`);
  for (const s of r.skipped) console.log(`  - ${s.file}: ${s.reason}`);
  for (const f of r.failed) console.log(`  ✗ ${f.file}: ${f.error}`);
}

const failed = results.reduce((n, r) => n + r.failed.length, 0);
process.exit(failed > 0 ? 2 : 0);
