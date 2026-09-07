// Rasterize the promo SVGs → submission-ready JPEGs (no alpha, exact store sizes).
// Paths resolve relative to this file, so it runs from anywhere.
//
// The JPEGs in images/ are already checked in; regenerate only after editing
// render.mjs. Requires sharp (dev-only): `npm i sharp` in a scratch dir, or run
//   NODE_PATH=/path/to/node_modules node raster.mjs
//
//   node render.mjs    # writes svg/ + promo.html (pure Node, no deps)
//   node raster.mjs    # writes images/*.jpg from svg/ (needs sharp)
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
    .flatten({ background: '#0B1020' }) // opaque bg → no alpha, per store rules
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(join(OUT, base + '.jpg'));
  console.log(base, w + 'x' + h);
}
