/**
 * `import x from './foo.Dockerfile' with { type: 'file' }` resolves to a
 * path string at runtime: the real file in a checkout, a `/$bunfs/root/...`
 * path inside a `bun build --compile` binary. TypeScript has no built-in
 * knowledge of these extensions, so declare them.
 */
declare module '*.Dockerfile' {
  const path: string;
  export default path;
}

declare module '*.Caddyfile' {
  const path: string;
  export default path;
}
