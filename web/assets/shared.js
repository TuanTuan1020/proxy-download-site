/**
 * 前后端共享的纯函数模块。
 * - 浏览器：web/assets/app.js 直接 import
 * - Node：scripts/*.js 通过 import('../web/assets/shared.js') 复用
 * 这里只放无副作用的常量与纯函数，方便单元测试。
 */

export const PLATFORMS = ['windows', 'macos', 'android'];

export const PLATFORM_META = {
  windows: { label: 'Windows', short: 'Win' },
  macos: { label: 'macOS', short: 'Mac' },
  android: { label: 'Android', short: 'And' },
};

/** 各平台支持的架构（顺序即展示顺序，也是“推荐优先级”） */
export const ARCH_ORDER = {
  windows: ['x64', 'arm64', 'x86', 'unknown'],
  macos: ['arm64', 'x64', 'universal', 'unknown'],
  android: ['arm64-v8a', 'armeabi-v7a', 'universal', 'x86_64', 'x86'],
};

export const ARCH_LABELS = {
  windows: {
    x64: 'x64（Intel/AMD 64 位）',
    arm64: 'ARM64',
    x86: 'x86（32 位）',
    unknown: '架构未标注',
  },
  macos: {
    arm64: 'Apple Silicon（M 系列）',
    x64: 'Intel 处理器',
    universal: 'Universal（通用）',
    unknown: '架构未标注',
  },
  android: {
    'arm64-v8a': 'arm64-v8a（64 位主流手机）',
    'armeabi-v7a': 'armeabi-v7a（32 位旧设备）',
    universal: 'Universal（通用）',
    x86_64: 'x86_64（模拟器）',
    x86: 'x86（模拟器）',
  },
};

export const VARIANT_LABELS = {
  installer: '安装版',
  portable: '便携版（免安装）',
  desktop: '需要 .NET 桌面运行时',
  'fixed-webview2': '固定 WebView2 版',
  default: '',
};

export const FORMAT_LABELS = {
  exe: 'EXE',
  msi: 'MSI',
  msix: 'MSIX',
  zip: 'ZIP',
  '7z': '7Z',
  dmg: 'DMG',
  pkg: 'PKG',
  apk: 'APK',
  appimage: 'AppImage',
  deb: 'DEB',
  rpm: 'RPM',
  unknown: '文件',
};

export const FORMAT_HINTS = {
  dmg: 'macOS 磁盘映像，打开后拖入“应用程序”',
  pkg: 'macOS 安装器，双击按向导安装',
  zip: '压缩包，解压后运行',
  '7z': '7z 压缩包，需用 7-Zip 等工具解压',
  exe: 'Windows 可执行文件',
  apk: 'Android 安装包，需允许“安装未知来源应用”',
};

/** 下载服务返回的 Content-Type（按扩展名） */
export const CONTENT_TYPES = {
  apk: 'application/vnd.android.package-archive',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
  msix: 'application/msix',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  dmg: 'application/x-apple-diskimage',
  pkg: 'application/octet-stream',
  appimage: 'application/x-executable',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
  gz: 'application/gzip',
  unknown: 'application/octet-stream',
};

/** 文件头魔数校验：判断下载到的内容确实是安装包而不是 HTML 错误页 */
export const MAGIC_SIGNATURES = {
  apk: ['504b0304', '504b0506'],
  msix: ['504b0304'],
  zip: ['504b0304', '504b0506'],
  '7z': ['377abcaf271c'],
  exe: ['4d5a'],
  msi: ['d0cf11e0a1b11ae1'],
  pkg: ['78617221'],
  appimage: ['7f454c46'],
  deb: ['213c617263683e0a'],
  rpm: ['edabeedb'],
  // dmg 为 UDIF，头部无固定魔数，改用“非 HTML + 体积合理”判断
  dmg: [],
  unknown: [],
};

const DESKTOP_ARCH_ALIASES = {
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  win64: 'x64',
  intel: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  apple: 'arm64',
  silicon: 'arm64',
  x86: 'x86',
  i386: 'x86',
  i686: 'x86',
  ia32: 'x86',
  32: 'x86',
  64: 'x64',
  universal: 'universal',
  'universal2': 'universal',
  unknown: 'unknown',
};

const ANDROID_ARCH_ALIASES = {
  'arm64-v8a': 'arm64-v8a',
  arm64: 'arm64-v8a',
  aarch64: 'arm64-v8a',
  'armeabi-v7a': 'armeabi-v7a',
  armv7: 'armeabi-v7a',
  armv7a: 'armeabi-v7a',
  arm7: 'armeabi-v7a',
  arm: 'armeabi-v7a',
  x86_64: 'x86_64',
  x64: 'x86_64',
  x86: 'x86',
  universal: 'universal',
  unknown: 'unknown',
};

/** 把上游文件名里的架构写法规范化为本站统一取值 */
export function normalizeArch(platform, raw) {
  if (!raw) return 'unknown';
  const key = String(raw).trim().toLowerCase();
  const map = platform === 'android' ? ANDROID_ARCH_ALIASES : DESKTOP_ARCH_ALIASES;
  return map[key] || 'unknown';
}

export function archLabel(platform, arch) {
  return ARCH_LABELS[platform]?.[arch] || arch || '未知架构';
}

export function variantLabel(variant) {
  return VARIANT_LABELS[variant] || '';
}

export function formatLabel(format) {
  return FORMAT_LABELS[format] || format || '文件';
}

export function contentTypeForFilename(filename) {
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  return CONTENT_TYPES[ext] || CONTENT_TYPES.unknown;
}

export function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

/** 人类可读字节数 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 预发布版本判断（仅用于展示分组，绝不据此伪造版本） */
export function looksPrerelease(tag) {
  return /(?:^|[-_.])(alpha|beta|rc|pre|preview|canary|nightly|dev|snapshot|test)(?:[-_.0-9]|$)/i.test(
    String(tag || ''),
  );
}

/**
 * 系统自动识别。
 * 只返回能确定的结论；架构无法确定时 arch 为 null，由用户手动选择。
 * @param {{ua?:string, uaPlatform?:string, hasTouch?:boolean}} env
 * @returns {{platform:string|null, arch:string|null, confidence:'high'|'medium'|'none', reason:string, unsupported?:string}}
 */
export function detectPlatform(env = {}) {
  const ua = env.ua || '';
  const uaPlatform = String(env.uaPlatform || '').toLowerCase();

  if (/iphone|ipad|ipod/i.test(ua) || (uaPlatform === 'ios')) {
    return {
      platform: null,
      arch: null,
      confidence: 'none',
      reason: '检测到 iOS 设备；本站不收录 iOS 客户端。',
      unsupported: 'ios',
    };
  }

  if (/android/i.test(ua) || uaPlatform === 'android') {
    let arch = null;
    if (/arm64-v8a|aarch64|arm64/i.test(ua)) arch = 'arm64-v8a';
    else if (/armeabi-v7a|armv7/i.test(ua)) arch = 'armeabi-v7a';
    else if (/x86_64/i.test(ua)) arch = 'x86_64';
    return {
      platform: 'android',
      arch,
      confidence: arch ? 'medium' : 'none',
      reason: arch
        ? '根据浏览器信息推断为 Android 设备'
        : '已识别为 Android，但浏览器不会暴露 CPU 架构，请手动选择',
    };
  }

  if (/windows|win32|win64/i.test(ua) || uaPlatform === 'windows') {
    let arch = null;
    if (/arm64|aarch64/i.test(ua)) arch = 'arm64';
    else if (/win64|x64|wow64|amd64/i.test(ua)) arch = 'x64';
    return {
      platform: 'windows',
      arch,
      confidence: arch ? 'medium' : 'none',
      reason: arch
        ? '根据浏览器信息推断为 Windows（' + arch + '）'
        : '已识别为 Windows，但无法确定 CPU 架构，请手动选择',
    };
  }

  if (/mac os x|macintosh/i.test(ua) || uaPlatform === 'macos') {
    return {
      platform: 'macos',
      arch: null,
      confidence: 'none',
      reason: '已识别为 macOS，但浏览器无法可靠区分 Apple Silicon 与 Intel，请手动选择',
    };
  }

  return {
    platform: null,
    arch: null,
    confidence: 'none',
    reason: '无法可靠识别当前系统，请手动选择',
  };
}

/** 是否为源码包/签名/元数据等绝不应作为安装包的文件 */
export function isNonInstallableName(name) {
  const n = String(name || '');
  return (
    /^source\s*code/i.test(n) ||
    /\.(sig|asc|sha256|sha512|blockmap|txt|json|xml|md5|sha1)$/i.test(n) ||
    /\.dSYMs\.zip$/i.test(n) ||
    /\.app\.tar\.gz$/i.test(n) ||
    /-src\.(zip|tar\.gz)$/i.test(n) ||
    /\.ipa$/i.test(n)
  );
}

/**
 * 选择“主推荐”安装包：优先匹配当前架构，其次按变体优先级。
 * @param {Array<object>} options
 * @param {{arch?:string|null}} preference
 */
export function pickPrimary(options = [], preference = {}) {
  if (!options.length) return null;
  const archRank = (o) => {
    if (preference.arch && o.arch === preference.arch) return 0;
    if (o.arch === 'unknown') return 3;
    return 1;
  };
  const variantRank = (o) => {
    if (o.platform === 'windows') {
      return { installer: 0, portable: 1, desktop: 2, 'fixed-webview2': 1 }[o.variant] ?? 4;
    }
    if (o.platform === 'macos') {
      return { dmg: 0, pkg: 1, zip: 2 }[o.format] ?? 3;
    }
    return { 'arm64-v8a': 0, universal: 1, 'armeabi-v7a': 2 }[o.arch] ?? 3;
  };
  return [...options].sort((a, b) => archRank(a) - archRank(b) || variantRank(a) - variantRank(b))[0];
}

/** 站点数据是否过期 */
export function isStale(generatedAt, staleAfterMinutes, now = Date.now()) {
  if (!generatedAt) return true;
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > Number(staleAfterMinutes || 30) * 60 * 1000;
}
