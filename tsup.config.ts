import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

// @anthropic-ai/claude-agent-sdk 是「按需下载」后端依赖（不在 dependencies，故 tsup
// 默认会把它打进 dist）——显式外置：dist 只保留运行时 import，真正加载走 loadBackendDep
// （桥/全局/用户私装目录三路探测），未装则 Web 出「下载」按钮。
const external = ['@anthropic-ai/claude-agent-sdk'];

// tsup runs the two output configs independently. Copy the vendored Pi Goal
// runtime only after both configs finish so the first config's clean step cannot
// race with an asset copy into dist. The counter also lets watch mode copy once
// per pair of successful rebuilds.
let successfulBuilds = 0;
const copyPiGoalAssets = async () => {
  successfulBuilds += 1;
  if (successfulBuilds < 2) return;
  successfulBuilds = 0;
  const source = resolve('vendor/pi-goal');
  const destination = resolve('dist/pi-goal');
  cpSync(source, destination, { recursive: true, force: true });
};

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    external,
    onSuccess: copyPiGoalAssets,
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
    external,
    onSuccess: copyPiGoalAssets,
  },
]);
