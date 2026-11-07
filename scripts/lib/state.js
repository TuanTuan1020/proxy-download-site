import fs from 'node:fs';
import path from 'node:path';
import { env, writeJsonAtomic, readJson } from './env.js';

const STATE_FILE = path.join(env.stateDir, 'state.json');

const EMPTY_STATE = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  sources: {},
  runs: [],
};

export function readState() {
  const state = readJson(STATE_FILE, null);
  if (!state || typeof state !== 'object') return structuredClone(EMPTY_STATE);
  if (!state.sources) state.sources = {};
  if (!Array.isArray(state.runs)) state.runs = [];
  return state;
}

export function writeState(state) {
  state.updatedAt = new Date().toISOString();
  // 只保留最近 30 次运行记录
  if (state.runs.length > 30) state.runs = state.runs.slice(-30);
  writeJsonAtomic(STATE_FILE, state);
}

/**
 * 单进程内的串行化写入：避免并发任务互相覆盖。
 * （跨进程的互斥由 scripts/lib/lock.js 的文件锁负责）
 */
let queue = Promise.resolve();

export function updateState(mutator) {
  const run = queue.then(async () => {
    const state = readState();
    const result = await mutator(state);
    writeState(state);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export function getSourceState(state, id) {
  if (!state.sources[id]) {
    state.sources[id] = {
      etag: null,
      lastCheckedAt: null,
      lastCheckOkAt: null,
      checkError: null,
      syncError: null,
      dataSource: null,
      release: null,
      prereleases: [],
      versions: {},
      lastSyncedAt: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
    };
  }
  const s = state.sources[id];
  if (!s.versions) s.versions = {};
  return s;
}

export function pruneVersions(sourceState, keep) {
  const tags = Object.keys(sourceState.versions || {});
  if (tags.length <= keep) return [];
  const sorted = tags.sort(
    (a, b) => Date.parse(sourceState.versions[b]?.syncedAt || 0) - Date.parse(sourceState.versions[a]?.syncedAt || 0),
  );
  const removed = [];
  for (const tag of sorted.slice(keep)) {
    for (const record of Object.values(sourceState.versions[tag]?.files || {})) {
      removed.push(record.key);
    }
    delete sourceState.versions[tag];
  }
  return removed;
}

export function stateFilePath() {
  return STATE_FILE;
}

export function ensureStateDir() {
  fs.mkdirSync(env.stateDir, { recursive: true });
}
