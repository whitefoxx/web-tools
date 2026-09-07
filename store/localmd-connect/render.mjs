// localmd Connect Chrome Web Store promo-asset generator.
// Pure string templating → SVG (works in Node AND browser). Node writes the SVG
// files + a self-contained promo.html; raster.mjs turns SVG→JPG.
//
// Deliberately a SIBLING of store/webcli/render.mjs, not a shared module: the
// two products must not look alike in a store listing, and the primitives are
// ~100 lines of string templating that never change. Copying them is cheaper
// than refactoring the generator of a SHIPPING asset set (same
// churn-minimization rule the shells follow).
//
// Visual identity: localmd's brand blue (#58A6FF), a blue→blue gradient with no
// purple in it (WebCLI owns blue→purple), and the extension's own mark —
// brackets + bolt — so the store art and the toolbar icon are literally the
// same symbol. Amber appears exactly once, on the confirm story, because that
// is the one thing a user must notice.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------- design tokens ---------- */
const C = {
  bg0: '#081221',
  bg1: '#0E2743',
  panel: 'rgba(255,255,255,0.05)',
  panelStroke: 'rgba(120,175,255,0.16)',
  fg: '#F2F7FF',
  sec: '#A9BFDC',
  muted: '#6E86A6',
  blue: '#58A6FF',
  blueDeep: '#2F6FED',
  amber: '#F5A623',
  amberSoft: '#FFD9A0',
  chipFg: '#BBD6FF',
};

const FONT = "-apple-system,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- primitives ---------- */
function defs() {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg0}"/>
      <stop offset="1" stop-color="${C.bg1}"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.blue}"/>
      <stop offset="1" stop-color="${C.blueDeep}"/>
    </linearGradient>
    <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.blue}" stop-opacity="0.42"/>
      <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowD" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.blueDeep}" stop-opacity="0.4"/>
      <stop offset="1" stop-color="${C.blueDeep}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function background(w, h, glows = []) {
  const g = glows
    .map(([cx, cy, r, id]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`)
    .join('');
  return `<rect width="${w}" height="${h}" fill="url(#bg)"/>${g}`;
}

/** The product mark — the SAME geometry as public/icons/localmd-connect.svg
 * (a 128 box): localmd's brackets with the centre dot replaced by a bolt. Keep
 * these paths in sync with that file; they are the one thing a user matches
 * between the store page and their toolbar. */
function logo(x, y, size) {
  const s = size / 128;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect width="128" height="128" rx="28" fill="url(#brand)"/>
    <g fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M50 36H36v56h14"/>
      <path d="M78 36h14v56H78"/>
    </g>
    <path d="M0 0 L0 16 L3.7 12.4 L6.2 18.5 L8.6 17.5 L6.1 11.5 L11 11.5 Z" transform="translate(38 36) rotate(-22) scale(3.3)" fill="#fff" stroke="#2f6fd0" stroke-width="1.15" stroke-linejoin="round"/>
  </g>`;
}

function text(x, y, str, o = {}) {
  const {
    size = 24,
    weight = 400,
    fill = C.fg,
    anchor = 'start',
    font = FONT,
    spacing = 0,
    opacity = 1,
  } = o;
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}" opacity="${opacity}">${esc(str)}</text>`;
}

function lines(x, y, arr, lh, o = {}) {
  return arr.map((s, i) => text(x, y + i * lh, s, o)).join('');
}

function chip(x, y, label, o = {}) {
  const {
    size = 20,
    padX = 15,
    h = 38,
    fill = 'rgba(88,166,255,0.12)',
    stroke = 'rgba(88,166,255,0.30)',
    fg = C.chipFg,
  } = o;
  const w = Math.round(label.length * size * 0.6 + padX * 2);
  const svg = `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}"/>
    ${text(x + w / 2, y + h / 2 + size * 0.34, label, { size, font: MONO, fill: fg, anchor: 'middle' })}
  </g>`;
  return { svg, width: w };
}

function chipFlow(x, y, maxW, labels, o = {}) {
  const gap = o.gap ?? 12;
  const rowH = (o.h ?? 38) + (o.rowGap ?? 12);
  let cx = x,
    cy = y,
    out = '';
  for (const l of labels) {
    const c = chip(cx, cy, l, o);
    if (cx + c.width > x + maxW && cx > x) {
      cx = x;
      cy += rowH;
      const c2 = chip(cx, cy, l, o);
      out += c2.svg;
      cx += c2.width + gap;
    } else {
      out += c.svg;
      cx += c.width + gap;
    }
  }
  return { svg: out, endY: cy + (o.h ?? 38) };
}

/** Width of a chip row, so a caller can centre it. Must use the SAME formula as
 * chip() — this pair drifted in the webcli generator and put a truncated label
 * into a shipped screenshot. */
function chipRowWidth(labels, size = 20, padX = 15, gap = 12) {
  return labels.reduce((sum, l) => sum + Math.round(l.length * size * 0.6 + padX * 2) + gap, -gap);
}

function panel(x, y, w, h, r = 18) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}" stroke="${C.panelStroke}"/>`;
}

function svgDoc(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs()}${inner}</svg>`;
}

function brandRow(x, y) {
  return `${logo(x, y, 46)}${text(x + 62, y + 33, 'localmd Connect', { size: 30, weight: 700, spacing: 0.3 })}`;
}

/* ---------- cards ---------- */
const cards = [];
const W = 1280,
  H = 800;

/** What the product is, in three nouns — generic tools FIRST, because they are
 * what works everywhere; capture is what the user does with them every day.
 * Rendered twice (chips + centring), so it lives in one place — see
 * chipRowWidth. (Site adapters were the middle noun until 0.2.0 removed them.) */
const VALUE_CHIPS = ['50+ browser tools', 'one-key capture', 'your logged-in Chrome'];

// S1 — HERO
cards.push({
  id: 'screenshot-1-hero',
  w: W,
  h: H,
  label: 'Screenshot 1 · Hero',
  render() {
    let s = background(W, H, [
      [220, 170, 620, 'glowB'],
      [1120, 720, 640, 'glowD'],
    ]);
    s += logo(W / 2 - 64, 96, 128);
    s += text(W / 2, 330, 'localmd Connect', {
      size: 76,
      weight: 800,
      anchor: 'middle',
      spacing: 0.5,
    });
    s += lines(
      W / 2,
      404,
      [
        'Browser superpowers for localmd.app —',
        'your AI knowledge base that lives in the browser.',
      ],
      42,
      { size: 30, fill: C.sec, anchor: 'middle' },
    );
    const f = chipFlow(0, 500, W, VALUE_CHIPS, {
      size: 22,
      h: 46,
      fill: 'rgba(88,166,255,0.12)',
      stroke: 'rgba(88,166,255,0.32)',
      fg: C.chipFg,
    });
    s += `<g transform="translate(${(W - chipRowWidth(VALUE_CHIPS, 22, 15, 12)) / 2} 0)">${f.svg}</g>`;
    // Said plainly and early: this is a companion and does nothing alone. The
    // second line used to disclose a paid tier; localmd.app is free and open
    // source as of 2026-09-07, so it now says that instead.
    s += text(W / 2, 640, 'A companion extension for localmd.app — it does nothing on its own.', {
      size: 24,
      fill: C.muted,
      anchor: 'middle',
    });
    s += text(W / 2, 690, 'localmd.app is free and open source.', {
      size: 22,
      fill: C.muted,
      anchor: 'middle',
    });
    return svgDoc(W, H, s);
  },
});

// S2 — TOOLBELT
// The breadth shot, and deliberately the FIRST thing after the hero: the generic
// primitives are what make the agent able to do anything at all on any site, and
// the rows this shell adds — capture, highlights, recon — are what it adds on
// top. Site scripts live here as one row rather than owning a screenshot.
cards.push({
  id: 'screenshot-2-tools',
  w: W,
  h: H,
  label: 'Screenshot 2 · Toolbelt',
  render() {
    let s = background(W, H, [[1080, 120, 560, 'glowB']]);
    s += brandRow(72, 60);
    s += text(72, 186, '50+ tools your agent can call', { size: 46, weight: 700 });
    s += text(72, 230, 'The low-level building blocks, plus what only this extension adds.', {
      size: 26,
      fill: C.sec,
    });

    const groups = [
      {
        t: 'Navigate & read',
        c: ['open_url', 'get_page_text', 'fetch_url', 'screenshot', 'scroll_page'],
      },
      { t: 'Search & crawl', c: ['web_search', 'list_links'] },
      {
        t: 'Interact',
        c: [
          'click',
          'type_into',
          'fill_form',
          'press_key',
          'select_option',
          'hover',
          'drag_and_drop',
          'file_upload',
          'handle_dialog',
        ],
      },
      {
        t: 'Perceive the DOM',
        c: [
          'get_interactives',
          'get_html',
          'query_dom',
          'get_dom_outline',
          'wait_for_selector',
          'find_in_page',
          'find_in_dom',
        ],
      },
      { t: 'Tabs', c: ['list_tabs', 'get_active_tab', 'manage_tabs', 'close_tab'] },
      { t: 'Page-declared tools', c: ['list_webmcp_tools', 'call_webmcp_tool'] },
      {
        t: 'Recon & your own JS',
        c: ['find_structured_data', 'get_a11y_tree', 'capture_network', 'eval_js'],
      },
      { t: 'Capture', c: ['clip_page', 'list_inbox', 'ack_inbox'], hi: true },
      { t: 'Highlights', c: ['get_highlights', 'delete_highlights'], hi: true },
      {
        t: "The browser's own data",
        c: ['search_bookmarks', 'search_history', 'list_reading_list', 'list_recently_closed'],
      },
      {
        t: 'Site scripts',
        c: [
          'create_site_script',
          'preview_site_script',
          'list_site_scripts',
          'set_site_script_enabled',
          'delete_site_script',
        ],
        hi: true,
      },
    ];
    // Eleven groups now (0.2.0 traded two adapter chips for recon, capture,
    // highlights and browser data), so the rhythm is tighter than it was at
    // eight. The last row must clear the 800px edge — measure it, do not eyeball.
    let y = 272;
    for (const g of groups) {
      s += text(72, y + 2, g.t, { size: 20, weight: 700, fill: g.hi ? C.blue : C.amberSoft });
      const f = chipFlow(320, y - 20, W - 320 - 72, g.c, {
        size: 17,
        h: 29,
        rowGap: 7,
        ...(g.hi
          ? { fill: 'rgba(88,166,255,0.2)', stroke: 'rgba(88,166,255,0.5)', fg: '#DCEBFF' }
          : {}),
      });
      s += f.svg;
      y = Math.max(y + 40, f.endY + 22);
    }
    return svgDoc(W, H, s);
  },
});

// S3 — CAPTURE
// Replaces the adapter story (removed in 0.2.0). This is what a user does with
// the extension every day: read something, press one key, and it is in the
// knowledge base. Categories and gestures only — never a list of site names
// (the 0.1.0 rejection was exactly that, and screenshots count as metadata).
cards.push({
  id: 'screenshot-3-capture',
  w: W,
  h: H,
  label: 'Screenshot 3 · Capture',
  render() {
    let s = background(W, H, [[980, 120, 620, 'glowB']]);
    s += brandRow(72, 60);
    s += text(72, 190, 'One key, and it is in your notes', { size: 46, weight: 700 });
    s += text(72, 236, 'Capture what you are reading — the agent writes it up for you.', {
      size: 26,
      fill: C.sec,
    });

    const kinds = [
      'The whole page',
      'Just your selection',
      'A region you drag',
      'A PDF, as the file',
      'Every tab in the window',
    ];
    const cf = chipFlow(72, 296, W - 144, kinds, { size: 20, h: 40 });
    s += cf.svg;

    // The gestures, as the user performs them. Mono label column at +250: the
    // longest key line is 14 chars at size 26 (~219px), so a smaller offset
    // would weld it to the description — the same trap the adapter card noted.
    const y0 = cf.endY + 64;
    const ARG = { size: 22, font: MONO, fill: C.sec };
    s += panel(72, y0, W - 144, 190);
    s += text(104, y0 + 52, 'Alt+Shift+S', { size: 26, font: MONO, fill: C.blue });
    s += text(104 + 250, y0 + 52, 'clip this page into today\u2019s note', ARG);
    s += text(104, y0 + 104, 'Alt+Shift+A', { size: 26, font: MONO, fill: C.blue });
    s += text(104 + 250, y0 + 104, 'drag a rectangle, annotate it, send it', ARG);
    s += text(104, y0 + 152, 'Highlight as you read — your marks are still there next visit.', {
      size: 21,
      fill: C.muted,
    });
    s += text(
      W / 2,
      y0 + 268,
      'Works on the sites that need you signed in — it is your own browser session.',
      {
        size: 24,
        fill: C.sec,
        anchor: 'middle',
      },
    );
    return svgDoc(W, H, s);
  },
});

// S4 — HOW IT WORKS
cards.push({
  id: 'screenshot-4-how',
  w: W,
  h: H,
  label: 'Screenshot 4 · How it works',
  render() {
    let s = background(W, H, [[640, 700, 700, 'glowB']]);
    s += brandRow(72, 60);
    s += text(72, 190, 'No daemon. No config. No keys.', { size: 46, weight: 700 });
    s += text(72, 236, 'localmd.app talks to the extension directly, inside your browser.', {
      size: 26,
      fill: C.sec,
    });

    // Node subs are MONO in a 300px card: keep them under ~18 chars or they
    // spill over the accent bar (the webcli set shipped that bug once).
    const nodes = [
      { t: 'localmd.app', sub: ['your KB agent', 'in this browser'] },
      { t: 'localmd Connect', sub: ['this extension', 'tools + capture'] },
      { t: 'Your Chrome', sub: ['real tabs', 'logged-in'] },
    ];
    // Height derived from the tallest node, never a constant: the webcli set
    // shipped a card whose third sub line hung below the edge because 150 was
    // typed once and a line was added later. Two subs fit inside 168 today —
    // this keeps that true if a third ever appears.
    const SUB_TOP = 104,
      SUB_LH = 30,
      SUB_BOTTOM_PAD = 34;
    const maxSubs = Math.max(...nodes.map((n) => n.sub.length));
    const nw = 300,
      nh = SUB_TOP + (maxSubs - 1) * SUB_LH + SUB_BOTTOM_PAD,
      gap = 76,
      y0 = 360;
    const total = nodes.length * nw + (nodes.length - 1) * gap;
    let x = (W - total) / 2;
    nodes.forEach((n, i) => {
      s += panel(x, y0, nw, nh);
      s += `<rect x="${x}" y="${y0}" width="6" height="${nh}" rx="3" fill="url(#brand)"/>`;
      s += text(x + nw / 2, y0 + 62, n.t, { size: 28, weight: 700, anchor: 'middle' });
      s += lines(x + nw / 2, y0 + SUB_TOP, n.sub, SUB_LH, {
        size: 20,
        font: MONO,
        fill: C.sec,
        anchor: 'middle',
      });
      if (i < nodes.length - 1) {
        const ax = x + nw + gap / 2;
        s += `<path d="M ${ax - 16} ${y0 + nh / 2} L ${ax + 16} ${y0 + nh / 2}" stroke="${C.muted}" stroke-width="3"/>`;
        s += `<path d="M ${ax + 8} ${y0 + nh / 2 - 8} L ${ax + 18} ${y0 + nh / 2} L ${ax + 8} ${y0 + nh / 2 + 8}" fill="${C.muted}"/>`;
      }
      x += nw + gap;
    });

    s += text(
      W / 2,
      634,
      'One site can reach it — localmd.app. That list is built in, not a setting.',
      {
        size: 24,
        fill: C.sec,
        anchor: 'middle',
      },
    );
    s += text(W / 2, 682, 'Nothing is sent anywhere else. The browser is the whole system.', {
      size: 22,
      fill: C.muted,
      anchor: 'middle',
    });
    return svgDoc(W, H, s);
  },
});

// S5 — GET STARTED
cards.push({
  id: 'screenshot-5-start',
  w: W,
  h: H,
  label: 'Screenshot 5 · Get started',
  render() {
    let s = background(W, H, [[640, 720, 720, 'glowD']]);
    s += brandRow(72, 60);
    s += text(72, 190, 'Three steps, then forget it exists', { size: 46, weight: 700 });

    const steps = [
      [
        '1',
        'Install it',
        'Add it from the Chrome Web Store. There is no window to keep open — only a small toolbar popup.',
      ],
      [
        '2',
        'Allow user scripts',
        "Turn the switch on in the extension's details page. Site scripts need it; nothing else does.",
      ],
      [
        '3',
        'Open localmd.app',
        'Nothing to configure. The Tools panel says Connected, and your agent has the tools.',
      ],
    ];
    let y = 268;
    steps.forEach(([n, t, d]) => {
      s += `<circle cx="104" cy="${y + 18}" r="26" fill="url(#brand)"/>`;
      s += text(104, y + 27, n, { size: 28, weight: 800, anchor: 'middle' });
      s += text(150, y + 12, t, { size: 30, weight: 700 });
      s += lines(150, y + 48, wrap(d, 76), 32, { size: 22, fill: C.sec });
      y += 148;
    });
    s += text(72, 730, 'Need the knowledge base itself? It lives at localmd.app — free to start.', {
      size: 22,
      fill: C.muted,
    });
    return svgDoc(W, H, s);
  },
});

// PROMO — marquee 1400×560
cards.push({
  id: 'promo-marquee-1400x560',
  w: 1400,
  h: 560,
  label: 'Promo · Marquee 1400×560',
  render() {
    const w = 1400,
      h = 560;
    let s = background(w, h, [
      [240, 120, 460, 'glowB'],
      [1180, 470, 460, 'glowD'],
    ]);
    s += logo(112, 196, 168);
    s += text(330, 250, 'localmd Connect', { size: 66, weight: 800, spacing: 0.5 });
    // The subline says what this IS and who it is for; the chips below already
    // enumerate the capabilities, so repeating "one-key capture" here spends the
    // one readable line in a marquee on something the reader is about to see.
    s += text(
      330,
      312,
      'Browser superpowers for localmd.app — your in-browser AI knowledge base.',
      {
        size: 28,
        fill: C.sec,
      },
    );
    const chips = ['50+ browser tools', 'one-key capture', 'your real Chrome'];
    s += chipFlow(330, 358, w - 400, chips, { size: 21, h: 44 }).svg;
    return svgDoc(w, h, s);
  },
});

// PROMO — small tile 440×280
cards.push({
  id: 'promo-small-440x280',
  w: 440,
  h: 280,
  label: 'Promo · Small tile 440×280',
  render() {
    const w = 440,
      h = 280;
    let s = background(w, h, [
      [110, 90, 260, 'glowB'],
      [360, 250, 240, 'glowD'],
    ]);
    s += logo(w / 2 - 44, 34, 88);
    s += text(w / 2, 176, 'localmd Connect', {
      size: 34,
      weight: 800,
      anchor: 'middle',
      spacing: 0.3,
    });
    s += text(w / 2, 212, 'Browser superpowers for localmd.app', {
      size: 17,
      fill: C.sec,
      anchor: 'middle',
    });
    s += text(w / 2, 244, 'browser tools · capture', {
      size: 14,
      fill: C.muted,
      anchor: 'middle',
      font: MONO,
    });
    return svgDoc(w, h, s);
  },
});

function wrap(str, max) {
  const words = str.split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) {
      out.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

/* ---------- emit ---------- */
mkdirSync(join(ROOT, 'svg'), { recursive: true });
const rendered = cards.map((c) => ({ ...c, svg: c.render() }));
for (const c of rendered) {
  writeFileSync(join(ROOT, 'svg', `${c.id}.svg`), c.svg);
}

const sections = rendered
  .map(
    (c) => `
    <section class="card">
      <div class="meta"><h2>${c.label}</h2><span class="dim">${c.w}×${c.h}</span>
        <button onclick="dl('${c.id}',${c.w},${c.h})">Download JPG</button></div>
      <div class="frame" id="card-${c.id}" style="aspect-ratio:${c.w}/${c.h}">${c.svg}</div>
    </section>`,
  )
  .join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>localmd Connect — Chrome Web Store promo assets</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#060c15;color:#e8f0fb;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
  header{max-width:1100px;margin:0 auto 24px}
  h1{font-size:26px;margin:0 0 6px}
  header p{color:#7f93ad;margin:0}
  main{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
  .card{background:#0b1626;border:1px solid #1b2b40;border-radius:14px;padding:16px}
  .meta{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .meta h2{font-size:16px;margin:0}
  .dim{color:#6e86a6;font:13px ui-monospace,Menlo,monospace}
  .meta button{margin-left:auto;background:linear-gradient(90deg,#58A6FF,#2F6FED);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer}
  .meta button:active{opacity:.8}
  .frame{width:100%;border-radius:10px;overflow:hidden;border:1px solid #1b2b40}
  .frame svg{width:100%;height:auto;display:block}
  .bar{position:sticky;top:0;z-index:5;max-width:1100px;margin:0 auto 20px;display:flex;gap:10px}
  .bar button{background:#132234;color:#cfe0f5;border:1px solid #24384f;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer}
</style></head><body>
<header><h1>localmd Connect — Chrome Web Store promo assets</h1>
<p>Rendered client-side from inline SVG. Click <b>Download JPG</b> for a store-ready file (JPEG, no alpha) at the exact required size.</p></header>
<div class="bar"><button onclick="cards.forEach(c=>dl(c.id,c.w,c.h))">Download all</button></div>
<main>${sections}</main>
<script>
const cards=${JSON.stringify(rendered.map((c) => ({ id: c.id, w: c.w, h: c.h })))};
function dl(id,w,h){
  const svgEl=document.querySelector('#card-'+id+' svg');
  const xml=new XMLSerializer().serializeToString(svgEl);
  const url='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));
  const img=new Image();
  img.onload=()=>{
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d');x.fillStyle='#081221';x.fillRect(0,0,w,h);x.drawImage(img,0,0,w,h);
    c.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=id+'.jpg';a.click();},'image/jpeg',0.94);
  };
  img.src=url;
}
</script></body></html>`;

writeFileSync(join(ROOT, 'promo.html'), html);
console.log('wrote', rendered.length, 'SVGs + promo.html');
