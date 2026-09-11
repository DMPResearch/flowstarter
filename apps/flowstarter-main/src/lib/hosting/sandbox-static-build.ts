import 'server-only';
import { posix } from 'node:path';
import type { ArchiveFile } from './site-archive';

/** Build tenant Astro code inside its existing sandbox, without app credentials. */
export async function buildSandboxStaticFiles(
  sandboxId: string,
  sourceFiles: readonly ArchiveFile[]
): Promise<ArchiveFile[]> {
  const { getClient } = await import('@flowstarter/daytona-utils');
  const sandbox = await getClient().get(sandboxId);
  const workDir = await sandbox.getWorkDir();
  if (!workDir || !posix.isAbsolute(workDir)) {
    throw new Error('Preview sandbox has no absolute workspace path');
  }

  // The preview bootstrap uploads text. Restore binary assets before compiling.
  for (const file of sourceFiles) {
    if (file.encoding !== 'base64') continue;
    const parts = file.path.split('/');
    if (
      parts.some((part) => !part || part === '.' || part === '..') ||
      file.path.includes('\\') ||
      parts.some((part) => part.startsWith('.'))
    ) {
      throw new Error('Invalid binary asset path');
    }
    const target = posix.join(workDir, file.path);
    await sandbox.fs.createFolder(posix.dirname(target), '755');
    await sandbox.fs.uploadFile(Buffer.from(file.content, 'base64'), target);
  }

  // Fixed command; never run the generated package.json build script on the app host.
  const build = await sandbox.process.executeCommand(
    './node_modules/.bin/astro build',
    workDir,
    { ASTRO_TELEMETRY_DISABLED: '1' },
    240
  );
  if (build.exitCode !== 0)
    throw new Error('Static preview compilation failed in sandbox');
  const check = await sandbox.process.executeCommand(
    'test -f dist/index.html && test -z "$(find dist ! -type f ! -type d -print -quit)"',
    workDir,
    undefined,
    15
  );
  if (check.exitCode !== 0)
    throw new Error('Static preview has no index or contains special files');

  const files: ArchiveFile[] = [];
  let size = 0;
  let entries = 0;
  async function walk(
    directory: string,
    prefix: string,
    depth: number
  ): Promise<void> {
    if (depth > 20)
      throw new Error('Static preview exceeds directory depth limit');
    for (const entry of await sandbox.fs.listFiles(directory)) {
      if (++entries > 5000)
        throw new Error('Static preview has too many entries');
      if (
        !entry.name ||
        entry.name === '.' ||
        entry.name === '..' ||
        /[/\\]/.test(entry.name)
      ) {
        throw new Error('Invalid static preview filename');
      }
      const path = prefix + entry.name;
      const absolute = posix.join(directory, entry.name);
      if (entry.isDir) {
        await walk(absolute, path + '/', depth + 1);
        continue;
      }
      if (
        entry.size > 50 * 1024 * 1024 ||
        size + entry.size > 100 * 1024 * 1024
      ) {
        throw new Error('Static preview exceeds asset size limit');
      }
      const bytes = await sandbox.fs.downloadFile(absolute);
      size += bytes.length;
      if (size > 100 * 1024 * 1024)
        throw new Error('Static preview exceeds asset size limit');
      files.push(
        /\.html?$/i.test(path)
          ? { path, content: bytes.toString('utf8') }
          : { path, content: bytes.toString('base64'), encoding: 'base64' }
      );
    }
  }
  await walk(posix.join(workDir, 'dist'), '', 0);
  if (!files.some((file) => file.path === 'index.html'))
    throw new Error('Static preview has no index');
  return files;
}
