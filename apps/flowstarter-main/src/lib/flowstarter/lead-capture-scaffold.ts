/**
 * Lead capture on the funnel preview path.
 *
 * The paid build wires the contact form through the build worker, which reads
 * the workspace's own token. A funnel preview has no workspace, so there is no
 * token and no tenant a lead could belong to, and the honest thing to put on
 * the page is a form that says so when somebody tries it.
 *
 * That is what a preview token is: a value of a shape a real token provably
 * cannot have (see `PREVIEW_TOKEN_PREFIX` in `lead-capture.ts`), pointing at
 * the same endpoint, which refuses it with a sentence the injected script
 * shows. The alternative was a preview whose contact form silently did nothing
 * when clicked, which is how a visitor learns not to trust the rest of it.
 */
import { publicAppOrigin } from '@flowstarter/platform-config';
import { injectLeadCapture, type FileMap } from '@flowstarter/agentic-codegen';
import { leadCaptureEndpoint, previewLeadCaptureToken } from './lead-capture';

function mapScaffoldFiles<T extends { path: string; content: string }>(
  files: readonly T[],
  transform: (map: FileMap) => FileMap
): T[] {
  const map: FileMap = {};
  for (const file of files) {
    map[file.path] = file.content;
  }
  const next = transform(map);
  let changed = false;
  const out = files.map((file) => {
    const content = next[file.path];
    if (content === undefined || content === file.content) return file;
    changed = true;
    return { ...file, content };
  });
  return changed ? out : (files as T[]);
}

/**
 * The endpoint a preview's form posts to, which the endpoint then refuses.
 *
 * `publicAppOrigin()`, not `siteRootDomain()`: the form posts to the app, not
 * to the zone the preview itself is hosted under, and those two only agree in
 * production. See the comment on `leadCaptureEndpoint()`.
 */
export function previewLeadCaptureEndpoint(previewId: string): string {
  return leadCaptureEndpoint(
    publicAppOrigin(),
    previewLeadCaptureToken(previewId)
  );
}

/**
 * Funnel/preview: the capture script, pointed at a preview token.
 *
 * Deliberately the same injector the paid build uses, so a preview and the
 * site it becomes cannot end up with two different contact forms, and so the
 * paid build's unconditional run replaces this block in place rather than
 * finding something it does not recognise.
 */
export function injectLeadCapturePreviewIntoScaffoldFiles<
  T extends { path: string; content: string }
>(files: readonly T[], previewId: string): T[] {
  if (!previewId?.trim()) return files as T[];
  return mapScaffoldFiles(files, (map) =>
    injectLeadCapture(map, previewLeadCaptureEndpoint(previewId))
  );
}
