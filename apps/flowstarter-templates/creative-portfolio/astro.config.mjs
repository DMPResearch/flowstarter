import { defineConfig } from 'astro/config';

/**
 * Two settings, both of them security rules rather than taste.
 *
 * `assetsInlineLimit: 0` stops Astro folding a small bundled `<script>` back
 * into the page as an inline block. A generated site's HTML is written from a
 * brief a stranger supplied, so "which inline scripts are legitimate" has to
 * have a short and stable answer: with this set, the template's own
 * JavaScript is always a file under `_astro/`, the compiled page carries only
 * the platform's managed inline blocks, and both the `GENERATED_HTML_UNSAFE`
 * gate and the served site's `script-src` can say exactly that. It also stops
 * assets being emitted as `data:` URLs, which the same gate refuses.
 *
 * `inlineStylesheets: 'never'` is the same rule for CSS: a stylesheet is a
 * file, so the site's `style-src` does not have to allow inline blocks it
 * cannot name.
 */
export default defineConfig({
  build: {
    inlineStylesheets: 'never',
  },
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
});
