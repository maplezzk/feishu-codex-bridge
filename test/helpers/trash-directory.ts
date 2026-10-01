import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';

/** Keep cleanup recoverable. CI images without trash retain a renamed temp
 * directory until the disposable runner is reclaimed. Other failures surface. */
export function trashTestDirectory(cwd: string): void {
  try {
    execFileSync('trash', [cwd]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    renameSync(cwd, `${cwd}.trash`);
  }
}
