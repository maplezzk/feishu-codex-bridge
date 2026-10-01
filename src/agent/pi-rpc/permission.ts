import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../types';

/** pi has no built-in project sandbox; the bridge therefore exposes full only. */
export function assertPiPermission(mode: PermissionMode | undefined): asserts mode is 'full' {
  const effective = mode ?? DEFAULT_PERMISSION_MODE;
  if (effective !== 'full') {
    throw new Error(
      `pi 后端只支持「完全访问」权限档；当前权限为「${effective}」，已拒绝启动，绝不自动提升权限。请把项目权限切换为 full。`,
    );
  }
}
