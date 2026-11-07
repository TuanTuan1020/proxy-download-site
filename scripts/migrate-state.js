#!/usr/bin/env node
/**
 * 一次性迁移：给旧版 state.json 里的同步记录补上 storageId。
 * 仅在"确认这些文件确实存在于当前存储"时使用（本地演示目录就是这样）。
 * 用法：node scripts/migrate-state.js [--apply]
 */
import { env, storageIdentity } from './lib/env.js';
import { readState, writeState } from './lib/state.js';

const apply = process.argv.includes('--apply');
const id = storageIdentity();
const state = readState();
let touched = 0;

for (const [sourceId, sourceState] of Object.entries(state.sources || {})) {
  for (const [tag, version] of Object.entries(sourceState.versions || {})) {
    for (const [name, record] of Object.entries(version.files || {})) {
      if (record.storageId) continue;
      touched += 1;
      console.log(`  ${sourceId} ${tag} ${name} → ${id}`);
      if (apply) record.storageId = id;
    }
  }
}

if (!touched) {
  console.log('没有需要迁移的记录。');
} else if (apply) {
  writeState(state);
  console.log(`\n已为 ${touched} 条记录写入 storageId: ${id}`);
} else {
  console.log(`\n预览模式：共 ${touched} 条待迁移，加 --apply 执行。`);
}
