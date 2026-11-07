/** 极简参数解析：--key=value / --key value / --flag */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [key, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      args.values.set(key, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.values.set(key, next);
      i += 1;
    } else {
      args.flags.add(key);
    }
  }
  return {
    has: (key) => args.flags.has(key) || args.values.has(key),
    get: (key, fallback = null) => (args.values.has(key) ? args.values.get(key) : fallback),
    list: (key) =>
      args.values
        .get(key)
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) || [],
    positional: args._,
  };
}
