import 'server-only';

/**
 * Local-preview counterpart of daytona-utils' fastEditInSandbox: runs the same
 * sandbox/fast-edit-runner.mjs (Kimi implementer + Haiku critic over
 * OpenRouter) directly against the workspace copy the static build was made
 * from. This exists so the free-edit loop works when there is no Daytona
 * sandbox behind the preview — which, since previews moved onto the platform,
 * is the normal case. The rebuild that makes the edit visible is the
 * publisher's `republish`, not this runner's job.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LocalFastEditResult {
  ok: boolean;
  error?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export async function fastEditLocal(
  localRoot: string,
  instruction: string,
  opts: {
    openRouterKey: string;
    /** Host path to packages/agentic-codegen/sandbox/fast-edit-runner.mjs. */
    runnerPath: string;
    /** Path of the content file inside the workspace. */
    contentRel: string;
    model?: string;
    criticModel?: string;
    timeoutMs?: number;
  }
): Promise<LocalFastEditResult> {
  // The runner reads the instruction from a file (it can contain quotes,
  // newlines, anything) — same contract as the sandbox invocation.
  const scratch = await mkdtemp(join(tmpdir(), 'fs-fastedit-'));
  const instrFile = join(scratch, 'instruction.txt');
  await writeFile(instrFile, instruction, 'utf8');
  try {
    return await new Promise<LocalFastEditResult>((resolveResult) => {
      const child = spawn(process.execPath, [opts.runnerPath], {
        cwd: localRoot,
        env: {
          ...process.env,
          FS_SITE_LABELS: join(localRoot, opts.contentRel),
          FS_INSTRUCTION_FILE: instrFile,
          FS_OPENROUTER_KEY: opts.openRouterKey,
          FS_MODEL: opts.model ?? 'moonshotai/kimi-k2.6',
          FS_CRITIC_MODEL: opts.criticModel ?? 'anthropic/claude-haiku-4.5',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, opts.timeoutMs ?? 180_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolveResult({ ok: false, error: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = stdout
          .split('\n')
          .reverse()
          .find((l) => l.trim().startsWith('{'));
        if (line) {
          try {
            const o = JSON.parse(line) as Record<string, unknown>;
            if (o.type === 'done') {
              resolveResult({
                ok: true,
                costUsd: typeof o.costUsd === 'number' ? o.costUsd : 0,
                tokensIn: typeof o.tokensIn === 'number' ? o.tokensIn : 0,
                tokensOut: typeof o.tokensOut === 'number' ? o.tokensOut : 0,
              });
              return;
            }
            resolveResult({
              ok: false,
              error: String(o.message ?? 'fast edit failed'),
            });
            return;
          } catch {
            /* not the runner's JSON line — fall through */
          }
        }
        resolveResult({
          ok: false,
          error:
            code === 0
              ? 'fast edit: no result'
              : `fast edit exit ${code}${
                  stderr ? `: ${stderr.slice(-300)}` : ''
                }`,
        });
      });
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
