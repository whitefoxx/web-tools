// Rasterize the promo SVGs → submission-ready JPEGs (no alpha, exact store sizes).
// Paths resolve relative to this file, so it runs from anywhere.
//
// The JPEGs in images/ are already checked in; regenerate only after editing
// render.mjs:
//
//   node store/localmd-connect/render.mjs    # svg/ + promo.html (pure Node, no deps)
//   node store/localmd-connect/raster.mjs    # images/*.jpg  (needs sharp)
//
// sharp is NOT a dependency of this repo, and ESM ignores NODE_PATH, so symlink
// it in from a checkout that has one and remove it after (run from the REPO
// ROOT — that is where node_modules lives):
//
//   ln -sfn ~/code/ai-image/node_modules/sharp node_modules/sharp
//   node store/localmd-connect/raster.mjs
//   rm node_modules/sharp
import sharp from 'sharp';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SVG = join(ROOT, 'svg');
const OUT = join(ROOT, 'images');
mkdirSync(OUT, { recursive: true });

for (const f of readdirSync(SVG).filter((n) => n.endsWith('.svg'))) {
  const svg = readFileSync(join(SVG, f));
  const m = svg.toString().match(/width="(\d+)"\s+height="(\d+)"/);
  const w = +m[1],
    h = +m[2];
  const base = f.replace(/\.svg$/, '');
  await sharp(svg, { density: 96 })
    .resize(w, h)
    .flatten({ background: '#081221' }) // opaque bg → no alpha, per store rules
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(join(OUT, base + '.jpg'));
  console.log(base, w + 'x' + h);
}
