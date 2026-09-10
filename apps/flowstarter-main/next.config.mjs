// ESM-safe __filename replacement
const CONFIG_FILE = new URL('', import.meta.url).pathname;

export default {
  typescript: { ignoreBuildErrors: true },
  // Required for the Hetzner staging Docker image
  // (`deploy/hetzner-staging/Dockerfile`): `next build` emits a minimal
  // `node server.js` tree under `.next/standalone`.
  output: 'standalone',
  // Next.js advertises itself with `X-Powered-By: Next.js` on every response
  // otherwise. It tells an attacker which stack to aim at and buys us nothing.
  poweredByHeader: false,
  // Allow LAN access during dev (IDE browser MCP, mobile testing, etc.)
  // (see the merged allowedDevOrigins below, near turbopack config)
  async headers() {
    return [
      // Authenticated app surface — never cache, must revalidate every hit.
      {
        source: '/:path(dashboard|admin|login|sign-up|forgot-password|reset-password|verify)(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
          { key: 'Accept-CH', value: 'Sec-CH-Prefers-Color-Scheme' },
          { key: 'Critical-CH', value: 'Sec-CH-Prefers-Color-Scheme' },
        ],
      },
      // Auth/session API endpoints — never cache.
      {
        source: '/api/(auth|webhooks)(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
      // Astro template previews — fully static, served straight from /public.
      // Hash-fingerprinted assets in /preview/_astro/ get a long cache; the
      // index.html shells stay short so we can publish content updates fast.
      {
        source: '/preview/:slug/_astro/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/preview/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=300, stale-while-revalidate=60' },
        ],
      },
      // Library showcase imagery is rebuilt only when we recapture thumbs.
      {
        source: '/showcase/:file*',
        headers: [
          { key: 'Cache-Control', value: 'public, s-maxage=86400, stale-while-revalidate=604800' },
        ],
      },
      // Everything else (marketing, legal, static-ish pages) — let Netlify's
      // CDN serve from edge cache so we don't cold-start a function on every
      // visit. Pages still revalidate in the background via SWR.
      {
        source: '/((?!_next/|api/).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=300, stale-while-revalidate=60',
          },
          {
            key: 'Accept-CH',
            value: 'Sec-CH-Prefers-Color-Scheme',
          },
          {
            key: 'Critical-CH',
            value: 'Sec-CH-Prefers-Color-Scheme',
          },
        ],
      },
    ];
  },
  // Astro template previews ship as static directory bundles in
  // /public/preview/{slug}/. Next.js doesn't auto-serve a directory's
  // index.html, so map directory-style URLs onto their actual file. Concrete
  // assets (anything with a file extension like _astro/*.css) are still
  // served straight from /public because afterFiles rewrites only kick in
  // when no static match exists.
  async rewrites() {
    return [
      { source: '/preview/:slug', destination: '/preview/:slug/index.html' },
      {
        source: '/preview/:slug/:rest+',
        destination: '/preview/:slug/:rest+/index.html',
      },
    ];
  },
  transpilePackages: [
    'uploadthing',
    '@uploadthing/react',
    '@uploadthing/shared',
    // TS-source workspace pkgs consumed by the live-demo route — Next must
    // transpile them (their heavy/native bits stay external below).
    '@flowstarter/agentic-codegen',
    '@flowstarter/daytona-utils',
  ],
  images: {
    // With no localPatterns, Next.js serves local images but rejects any query
    // string. We append a ?v=<ASSET_VERSION> cache-bust to /showcase/* thumbnails
    // (see src/utils/asset-version.ts), so allow local images with any query.
    // An omitted `search` permits any query (same as the remotePatterns below);
    // '/**' keeps every existing local image working.
    localPatterns: [{ pathname: '/**' }],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'img.clerk.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'img.clerk.dev',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.clerk.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.clerk.dev',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'assets.flowstarter.dev',
        port: '',
        pathname: '/**',
      },
    ],
  },
  // Optimize compilation speed
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
        allowedDevOrigins: ['192.168.3.119', '127.0.0.1', 'localhost', 'flowstarter.dev', 'www.flowstarter.dev', 'staging.flowstarter.dev', 'editor.flowstarter.dev', 'library.flowstarter.dev', 'workflows.flowstarter.dev'],
  turbopack: {
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js'],
  },
  // Webpack is for production builds only — Turbopack covers dev.
  //
  // This has to stay conditional. Next 16 runs dev on Turbopack by default,
  // but merely *defining* a `webpack` key opts the whole dev server back onto
  // webpack, whose CSS pipeline resolves `@import './animations.css'` in
  // src/styles/globals.css against `<repo>/apps` and 500s every page. Tailwind
  // v4 handles that import correctly on its own; only the webpack fallback
  // gets it wrong. Exporting the key unconditionally is what broke `next dev`.
  ...(process.env.NODE_ENV === 'development'
    ? {}
    : {
        webpack: (config, { isServer }) => {
          // Exclude templates directory from the build
          config.watchOptions = {
            ...config.watchOptions,
            ignored: ['**/templates/**', '**/node_modules/**'],
          };

          // Prevent webpack from trying to resolve template files
          config.resolve.alias = {
            ...config.resolve.alias,
            '@/templates': false,
          };

          // Optimize caching and compilation speed
          config.cache = {
            type: 'filesystem',
            buildDependencies: {
              config: [CONFIG_FILE],
            },
          };

          // Optimize module resolution
          config.resolve.extensionAlias = {
            '.js': ['.js', '.ts', '.tsx'],
            '.jsx': ['.jsx', '.tsx'],
          };

          return config;
        },
      }),
  // Keep heavy native deps as external `require()` calls so they aren't
  // re-bundled per route — keeps Lambda cold starts smaller.
  // Pi loads providers through a computed import() (pi-ai/dist/env-api-keys.js:
  // `import(__rewriteRelativeImportExtension(specifier))`). Turbopack cannot
  // bundle that and fails at runtime with "Cannot find module as expression is
  // too dynamic", which silently killed every live preview under `next dev`.
  // Keeping the Pi packages external lets Node resolve them natively.
  serverExternalPackages: [
    '@daytonaio/sdk',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-tui',
  ],
};
