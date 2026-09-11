import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({
  getWorkDir: vi.fn(),
  process: { executeCommand: vi.fn() },
  fs: {
    createFolder: vi.fn(),
    uploadFile: vi.fn(),
    listFiles: vi.fn(),
    downloadFile: vi.fn(),
  },
}));
vi.mock('server-only', () => ({}));
vi.mock('@flowstarter/daytona-utils', () => ({
  getClient: () => ({ get: async () => sandbox }),
}));
import { buildSandboxStaticFiles } from '../sandbox-static-build';

beforeEach(() => {
  vi.resetAllMocks();
  sandbox.getWorkDir.mockResolvedValue('/workspace');
  sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0 });
  sandbox.fs.listFiles.mockResolvedValue([
    { name: 'index.html', size: 20, isDir: false },
    { name: 'photo.png', size: 4, isDir: false },
  ]);
  sandbox.fs.downloadFile.mockImplementation(async (path: string) =>
    path.endsWith('.html')
      ? Buffer.from('<html>Preview</html>')
      : Buffer.from([0, 255, 128, 1])
  );
});

describe('sandbox static compilation', () => {
  it('uses the sandbox Astro binary and preserves binary input and output', async () => {
    const bytes = Buffer.from([0, 255, 128, 1]);
    const files = await buildSandboxStaticFiles('sandbox-1', [
      {
        path: 'public/photo.png',
        content: bytes.toString('base64'),
        encoding: 'base64',
      },
    ]);
    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
      bytes,
      '/workspace/public/photo.png'
    );
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
      './node_modules/.bin/astro build',
      '/workspace',
      { ASTRO_TELEMETRY_DISABLED: '1' },
      240
    );
    expect(files).toEqual([
      { path: 'index.html', content: '<html>Preview</html>' },
      {
        path: 'photo.png',
        content: bytes.toString('base64'),
        encoding: 'base64',
      },
    ]);
  });
  it('rejects a failed sandbox build without exporting files', async () => {
    sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 1 });
    await expect(buildSandboxStaticFiles('sandbox-1', [])).rejects.toThrow(
      'compilation failed'
    );
    expect(sandbox.fs.listFiles).not.toHaveBeenCalled();
  });
  it('rejects artifacts containing special files before downloading', async () => {
    sandbox.process.executeCommand
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 1 });
    await expect(buildSandboxStaticFiles('sandbox-1', [])).rejects.toThrow(
      'special files'
    );
    expect(sandbox.fs.downloadFile).not.toHaveBeenCalled();
  });
  it('rejects a source asset escaping its workspace', async () => {
    await expect(
      buildSandboxStaticFiles('sandbox-1', [
        { path: '../secret', content: '', encoding: 'base64' },
      ])
    ).rejects.toThrow('asset path');
    expect(sandbox.fs.uploadFile).not.toHaveBeenCalled();
  });
  it('rejects source-only output without a compiled index', async () => {
    sandbox.fs.listFiles.mockResolvedValue([
      { name: 'page.astro', size: 4, isDir: false },
    ]);
    await expect(buildSandboxStaticFiles('sandbox-1', [])).rejects.toThrow(
      'no index'
    );
  });
  it('rejects oversized output before downloading', async () => {
    sandbox.fs.listFiles.mockResolvedValue([
      { name: 'huge.png', size: 60 * 1024 * 1024, isDir: false },
    ]);
    await expect(buildSandboxStaticFiles('sandbox-1', [])).rejects.toThrow(
      'size limit'
    );
    expect(sandbox.fs.downloadFile).not.toHaveBeenCalled();
  });
});
