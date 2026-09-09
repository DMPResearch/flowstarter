/** Types for `static-files.mjs`, which `shoot.mjs` imports as plain Node ESM. */

/** Maps a URL path to the absolute file that serves it. */
export declare function collectServableFiles(
  root: string,
  prefix?: string,
  files?: Map<string, string>,
): Promise<Map<string, string>>;

/** The file a request URL serves, or null when the table has no such entry. */
export declare function lookupServableFile(
  files: Map<string, string>,
  requestUrl: string | undefined,
): string | null;
