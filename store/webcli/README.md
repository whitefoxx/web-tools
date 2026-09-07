# WebCLI — Chrome Web Store assets

Everything for the WebCLI extension's Web Store listing lives here.

## Contents

| Path                | What it is                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| `store-listing.md`  | Store copy — recommended name, summary (≤132 chars), full description.     |
| `images/`           | **Submission-ready** JPEGs (exact store sizes, no alpha). Upload these.    |
| `svg/`              | Source SVGs (single source of truth; the JPEGs are rasterized from these). |
| `render.mjs`        | Generator: data model → SVGs + `promo.html`. Pure Node, no dependencies.   |
| `raster.mjs`        | Rasterizer: `svg/*.svg` → `images/*.jpg` via sharp.                        |
| `promo.html`        | Self-contained gallery — open in a browser to preview + download any card. |

## Image slots (Chrome Web Store spec)

| File                          | Size      | Slot               |
| ----------------------------- | --------- | ------------------ |
| `screenshot-1-hero.jpg`       | 1280×800  | Screenshot         |
| `screenshot-2-flow.jpg`       | 1280×800  | Screenshot         |
| `screenshot-3-tools.jpg`      | 1280×800  | Screenshot         |
| `screenshot-4-why.jpg`        | 1280×800  | Screenshot         |
| `screenshot-5-start.jpg`      | 1280×800  | Screenshot         |
| `promo-small-440x280.jpg`     | 440×280   | Small promo tile   |
| `promo-marquee-1400x560.jpg`  | 1400×560  | Marquee promo tile |

All JPEG, 24-bit, no alpha — matching the store's requirements.

## Regenerate

Edit `render.mjs` (colors, copy, card layout), then:

```bash
node render.mjs                 # → svg/ + promo.html   (no dependencies)
npm i sharp && node raster.mjs  # → images/*.jpg         (needs sharp)
```

`render.mjs` embeds the product logo inline (same globe+cursor mark as
`public/icons/logo.svg`), so the assets stay on-brand without external files.
Client names, ports, etc. in the copy are plain strings in `render.mjs` /
`store-listing.md` — grep and edit there.
