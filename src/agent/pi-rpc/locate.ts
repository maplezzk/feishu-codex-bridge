import { existsSync } from 'node:fs';
import { spawnProcess } from '../../platform/spawn';
import { paths } from '../../config/paths';
import { resolveExternalCliBin } from '../backend-loader';

const MIN_PI_NODE = [22, 19, 0] as const;
let binCache: string | null = null;
let binCacheKey: string | undefined;
const versionCache = new Map<string, string>();

export interface PiProbe {
  ok: boolean;
  version: string | null;
  location?: string;
  hint?: string;
}

/** Locate pi without reading its settings or credentials. */
export function resolvePiBin(opts?: { force?: boolean }): string | null {
  const cacheKey = `${process.env.PI_BIN ?? ''}\u0000${process.env.PATH ?? ''}\u0000${paths.backendsDir}`;
  if (!opts?.force && binCacheKey === cacheKey && binCache && existsSync(binCache)) return binCache;
  binCacheKey = cacheKey;
  binCache = locatePiBin();
  return binCache;
}

function locatePiBin(): string | null {
  return resolveExternalCliBin({ binName: 'pi', envBinKey: 'PI_BIN' });
}

/** Async, non-blocking `pi --version` probe used by doctor and detection. */
export async function piVersionAsync(bin: string, opts?: { force?: boolean }): Promise<string | null> {
  if (!opts?.force) {
    const cached = versionCache.get(bin);
    if (cached !== undefined) return cached;
  }
  const version = await new Promise<string | null>((resolve) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // Version output is tiny; cap it in case a broken wrapper prints a config.
      stdout += chunk.slice(0, 512);
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 5_000);
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? stdout.trim() || null : null));
  });
  if (version !== null) versionCache.set(bin, version);
  return version;
}

/** Probe the installed CLI and report actionable failure without throwing. */
export async function probePi(opts?: { force?: boolean; bin?: string }): Promise<PiProbe> {
  if (!isSupportedNode()) {
    return {
      ok: false,
      version: null,
      hint: `当前 Node.js ${process.versions.node} 不满足 pi 要求的 Node.js >= 22.19.0；bridge 本身仍可运行，但 pi 后端不可用`,
    };
  }
  const bin = opts?.bin ?? resolvePiBin({ force: opts?.force });
  if (!bin) {
    return {
      ok: false,
      version: null,
      hint: '未找到 pi CLI（设置 PI_BIN，或把 pi 安装到 PATH / bridge 私装 backends/.bin）',
    };
  }
  const version = await piVersionAsync(bin, { force: opts?.force });
  if (!version) {
    return { ok: false, version: null, location: bin, hint: '已找到 pi，但 `pi --version` 启动失败；请检查 Node.js 与 pi 安装' };
  }
  return { ok: true, version, location: bin };
}

function isSupportedNode(): boolean {
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map((v) => Number(v));
  const [requiredMajor, requiredMinor, requiredPatch] = MIN_PI_NODE;
  return major > requiredMajor ||
    (major === requiredMajor && (minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch)));
}
