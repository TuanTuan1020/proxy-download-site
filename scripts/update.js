import { parseArgs } from './lib/cli.js';
import { runUpdate } from './lib/update-core.js';

const args = parseArgs();
const only = args.list('source');

if (args.has('help')) {
  console.log(`用法：
  node scripts/update.js                     采集 + 同步 + 发布（全部项目）
  node scripts/update.js --source=flclash    只更新指定项目（逗号分隔）
  node scripts/update.js --force             忽略“已同步且未变化”的判断，强制重新同步
`);
  process.exit(0);
}

try {
  const summary = await runUpdate({
    reason: args.get('reason', 'cli'),
    only: only.length ? only : null,
    force: args.has('force'),
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`更新失败：${error?.message || error}`);
  process.exit(1);
}
