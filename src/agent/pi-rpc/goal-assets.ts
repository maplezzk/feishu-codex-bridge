import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the vendored bridge Goal extension in a checkout and in the npm
 * package produced by tsup. The source path wins during development so a
 * local Pi RPC process can load the same asset that will be copied to dist.
 */
export function piGoalExtensionPath(): string {
  const developmentPath = fileURLToPath(new URL('../../../vendor/pi-goal/bridge-extension.mjs', import.meta.url));
  if (existsSync(developmentPath)) return developmentPath;

  const packagedPath = fileURLToPath(new URL('./pi-goal/bridge-extension.mjs', import.meta.url));
  if (existsSync(packagedPath)) return packagedPath;

  throw new Error(`Pi Goal bridge extension is missing: checked ${developmentPath} and ${packagedPath}`);
}
