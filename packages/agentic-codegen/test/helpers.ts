/**
 * Shared test fixtures + a fake LLM seam. Not a `*.test.ts` file, so vitest
 * doesn't collect it. The fake lets the whole orchestrator run with zero
 * network — feed it scripted responses and inspect the recorded calls.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GenerateFn,
  GenerateInput,
  GenerateOutput,
  Role,
} from '../src/llm';

/**
 * A temporary directory deep enough to be a worktree root on any platform.
 *
 * `assertNotBroadRoot` in `src/flowstarter/worktree.ts` refuses any root with
 * fewer than three path segments, on purpose: the manager removes its roots,
 * and a stray removal at a shallow path is unrecoverable. That guard is
 * correct and must not be relaxed to suit a test.
 *
 * What it interacts badly with is `os.tmpdir()`, which is not the same depth
 * everywhere. On macOS it is `/var/folders/<hash>/<hash>/T`, five segments
 * before `mkdtemp` adds a sixth. On Linux it is `/tmp`, so
 * `mkdtemp(join(tmpdir(), 'x-'))` yields `/tmp/x-abc123` -- two segments, and
 * every test that hands it to the manager throws "Refusing to use a broad
 * filesystem path as the worktree root" before doing anything.
 *
 * A developer cannot reproduce that on a Mac even by forcing `TMPDIR=/tmp`,
 * and it is worth knowing why: the manager calls `realpath` on the root
 * before the guard runs, and on macOS `/tmp` is a symlink to `/private/tmp`.
 * The symlink silently contributes the third segment. Same code, same
 * `TMPDIR`, opposite result.
 *
 * So this suite passed on developers' machines and failed the first time CI
 * ran it on Linux, which was the first time CI ran it at all: until the
 * coverage work, the quality gate only ran the flowstarter-main tests.
 *
 * Nest a fixed parent under tmpdir rather than depending on the platform's
 * depth. The returned path is still the one to clean up; the shared parent is
 * empty and harmless.
 */
export async function deepTempDir(prefix: string): Promise<string> {
  const parent = join(tmpdir(), 'flowstarter-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `${prefix}-`));
}

/** A small content file shaped like a real template's site-labels.md. */
export const FIXTURE = `---
siteMeta:
  title: "Template Co"
  description: "A placeholder business used by the template."
header:
  logo: "Template Co"
  navLinks:
    - label: "Home"
      href: "/"
    - label: "Contact"
      href: "/contact"
hero:
  label: "A tagline here"
  title: "A headline that sells the template"
  text: |
    A couple of sentences about the placeholder business, long enough that the
    length-ratio structural checks in these tests have something to chew on.
  actions:
    - label: "Get in touch"
      href: "/contact"
cta:
  heading: "A closing call to action"
  buttonLabel: "Reach out"
  buttonHref: "/contact"
services:
  sectionTitle: "What we do"
  items:
    - title: "First service"
      description: "A description of the first service offering."
    - title: "Second service"
      description: "A description of the second service offering."
about:
  sectionTitle: "About"
  paragraph: "A paragraph about the placeholder business and its people."
testimonials:
  - quote: "A perfectly nice quote."
    author: "A Person"
footer:
  text: "Placeholder footer text"
---
# Body
Some trailing markdown body content that must be preserved verbatim.
`;

export const FIXTURE_KEYS = [
  'siteMeta',
  'header',
  'hero',
  'cta',
  'services',
  'about',
  'testimonials',
  'footer',
];

type HandlerReturn = string | { text?: string; ok?: boolean; error?: string };
type Handler = (input: GenerateInput) => HandlerReturn;

export interface MockHandlers {
  /** brain call whose system marks it as the planner. */
  plan?: Handler;
  /** brain call whose system marks it as the critic. */
  critique?: Handler;
  /** implementer (Kimi) calls — waves, revisions, and edits. */
  implementer?: Handler;
  /** fast role — the edit-loop snappy critic. */
  fast?: Handler;
}

const MODEL_BY_ROLE: Record<Role, string> = {
  brain: 'anthropic/claude-sonnet-4',
  implementer: 'moonshotai/kimi-k2.6',
  fast: 'anthropic/claude-haiku-4.5',
};

/** Build an injectable GenerateFn plus a record of every call it received. */
export function makeGenerate(h: MockHandlers): {
  fn: GenerateFn;
  calls: GenerateInput[];
} {
  const calls: GenerateInput[] = [];
  const fn: GenerateFn = async (input) => {
    calls.push(input);
    let handler: Handler | undefined;
    if (input.role === 'brain') {
      handler = input.system.includes('planner') ? h.plan : h.critique;
    } else if (input.role === 'implementer') {
      handler = h.implementer;
    } else {
      handler = h.fast;
    }
    const raw: HandlerReturn = handler ? handler(input) : '';
    const norm = typeof raw === 'string' ? { text: raw } : raw;
    const ok = norm.ok ?? (!!norm.text && !norm.error);
    const out: GenerateOutput = {
      ok,
      text: norm.text ?? '',
      error: norm.error,
      costUsd: 0.001,
      model: MODEL_BY_ROLE[input.role],
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    return out;
  };
  return { fn, calls };
}

/** How many planner / critic / implementer / fast calls were made. */
export function counts(calls: GenerateInput[]) {
  return {
    plan: calls.filter(
      (c) => c.role === 'brain' && c.system.includes('planner'),
    ).length,
    critique: calls.filter(
      (c) => c.role === 'brain' && !c.system.includes('planner'),
    ).length,
    implementer: calls.filter((c) => c.role === 'implementer').length,
    fast: calls.filter((c) => c.role === 'fast').length,
  };
}

/**
 * Realistic implementer: pull the blocks out of a wave prompt and "personalize"
 * them by appending `!` to every quoted value. Preserves keys + structure and
 * grows length, so it passes the structural gate and counts as a real change.
 */
export function personalizeWave(input: GenerateInput): string {
  const m = input.prompt.match(
    /## Blocks to rewrite[^\n]*\n([\s\S]*?)\n\nNow output/,
  );
  const blocks = m?.[1] ?? '';
  return blocks.replace(/: "([^"]*)"/g, ': "$1!"');
}

/** Implementer for the edit path: personalize the whole "Current file:" body. */
export function personalizeEdit(input: GenerateInput): string {
  const m = input.prompt.match(
    /Current file:\n([\s\S]*?)\n\nOutput the complete/,
  );
  const file = m?.[1] ?? '';
  // edit output is the whole file content (frontmatter stripped of fences).
  const fm = file.match(/^---\s*\n([\s\S]*?)\n---/);
  const yaml = fm?.[1] ?? file;
  return yaml.replace(/: "([^"]*)"/g, ': "$1!"');
}
