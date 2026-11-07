import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/cli.js';
import { env } from './lib/env.js';
import { readState } from './lib/state.js';
import { formatBytes } from '../web/assets/shared.js';

const args = parseArgs();
const apply = args.has('apply');

function referencedKeys() {
  const state = readState();
  const keys = new Set();
  for (const sourceState of Object.values(state.sources || {})) {
    for (const version of Object.values(sourceState.versions || {})) {
      for (const record of Object.values(version.files || {})) {
        if (record?.key) keys.add(record.key);
      }
    }
  }
  return keys;
}

function walk(dir, base, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push({ full, key: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

const referenced = referencedKeys();

if (env.storageDriver !== 'local') {
  console.log(
    `当前存储驱动为 ${env.storageDriver}，本脚本只支持本地目录的清理预览。\n` +
      `对象存储请使用桶生命周期规则或 S3 控制台的“列出未引用对象”能力，并保持默认只预览。`,
  );
  process.exit(0);
}

const base = path.resolve(env.localStorageDir);
const files = walk(base, base);
const orphans = files.filter((f) => !referenced.has(f.key));
const totalBytes = orphans.reduce((n, f) => {
  try {
    return n + fs.statSync(f.full).size;
  } catch {
    return n;
  }
}, 0);

console.log(`存储目录：${base}`);
console.log(`已登记文件：${referenced.size}`);
console.log(`磁盘文件：${files.length}`);
console.log(`未被引用的文件：${orphans.length}（合计 ${formatBytes(totalBytes)}）`);
console.log(`保留策略：最近 ${env.retentionKeepVersions} 个成功同步的稳定版本\n`);

for (const orphan of orphans) {
  const size = fs.statSync(orphan.full).size;
  console.log(`  ${apply ? '删除' : '待清理'}  ${orphan.key}  (${formatBytes(size)})`);
}

if (!orphans.length) {
  console.log('没有需要清理的文件。');
  process.exit(0);
}

if (!apply) {
  console.log('\n当前为预览模式，未删除任何文件。确认无误后加 --apply 执行删除。');
  process.exit(0);
}

if (!args.has('yes')) {
  console.log('\n危险操作：请同时加 --yes 才真正删除。');
  process.exit(1);
}

for (const orphan of orphans) {
  fs.rmSync(orphan.full, { force: true });
  const dir = path.dirname(orphan.full);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
console.log(`\n已删除 ${orphans.length} 个未被引用的文件。`);
