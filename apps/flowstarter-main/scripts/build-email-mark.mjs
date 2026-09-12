/**
 * Regenerates the email wordmark PNG from its SVG source.
 *
 * The email layout cannot use the SVG directly: Gmail strips `<svg>` and
 * Outlook has never rendered it. So the mark ships as a PNG at three times its
 * 34px display size, which is what a retina client asks for, and this script
 * is the only thing allowed to write it.
 *
 *   node scripts/build-email-mark.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { statSync } from 'node:fs';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'public', 'email', 'flowstarter-mark.svg');
const out = path.join(here, '..', 'public', 'email', 'flowstarter-mark.png');

await sharp(src, { density: 600 })
  .resize(102, 102)
  .png({ compressionLevel: 9 })
  .toFile(out);

console.log(`wrote ${out} (${statSync(out).size} bytes)`);
