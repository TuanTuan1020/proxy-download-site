import { parseArgs } from './lib/cli.js';
import { collectAll } from './lib/collect-core.js';
import { publishSiteData } from './lib/publish.js';
import { readState } from './lib/state.js';
import { loadSiteConfig, sourceList } from './lib/config.js';

const args = parseArgs();
const only = args.list('source');
const all = sourceList();
const sources = only.length ? all.filter((s) => only.includes(s.id)) : all;

if (!sources.length) {
  console.error(`没有匹配的项目：${only.join(', ') || '(空)'}`);
  process.exit(1);
}

const results = await collectAll(sources, { force: args.has('force') });
const state = readState();
publishSiteData({ sources: all, siteConfig: loadSiteConfig(), state });

console.log(
  JSON.stringify(
    results.map((r) => ({
      id: r.id,
      tag: r.tag,
      assets: r.assets,
      notModified: r.notModified || false,
      degraded: r.degraded || false,
      error: r.error || null,
    })),
    null,
    2,
  ),
);
