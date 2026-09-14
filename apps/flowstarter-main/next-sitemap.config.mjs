/**
 * next-sitemap's own config format, not a Next.js one: it runs as a plain
 * Node CLI in `postbuild`, after `next build`, outside any bundler.
 *
 * `siteUrl` used to be `process.env.NEXT_PUBLIC_SITE_URL || 'https://flowstarter.net'`
 * — a second, narrower copy of the same "where is the app publicly served"
 * question `@flowstarter/platform-config`'s `publicAppOrigin()` already
 * answers for every other caller in the app. This file is `.mjs` rather than
 * `.cjs`, and `postbuild` runs it through `tsx` rather than the bare
 * `next-sitemap` CLI, for exactly one reason: it is the only caller of that
 * rule that is not bundled by Next, so it is the only one that needs a
 * runtime capable of resolving a workspace package whose `exports` point
 * straight at TypeScript source.
 */
import { publicAppOrigin } from '@flowstarter/platform-config';

/** @type {import('next-sitemap').IConfig} */
export default {
  siteUrl: publicAppOrigin(),
  generateRobotsTxt: true,
  exclude: ['/dashboard/*', '/api/*', '/sign-up', '/login'],
  robotsTxtOptions: {
    policies: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard', '/api', '/sign-up', '/login'],
      },
    ],
  },
};
