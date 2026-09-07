// WebCLI Chrome Web Store promo-asset generator.
// Pure string templating → SVG (works in Node AND browser). Node writes the SVG
// files + a self-contained promo.html; a shell step rasterizes SVG→PNG→JPG.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------- design tokens ---------- */
const C = {
  bg0: '#0B1020',
  bg1: '#1A1236',
  panel: 'rgba(255,255,255,0.045)',
  panelStroke: 'rgba(255,255,255,0.09)',
  fg: '#F5F7FF',
  sec: '#AEB7D4',
  muted: '#727C9C',
  blue: '#4F6BFF',
  purple: '#A44DFF',
  amber: '#F5A623',
  amberSoft: '#FFD9A0',
  chipFg: '#C7D0FF',
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
      <stop offset="1" stop-color="${C.purple}"/>
    </linearGradient>
    <linearGradient id="globe" gradientUnits="userSpaceOnUse" x1="91" y1="83" x2="421" y2="413">
      <stop offset="0" stop-color="${C.blue}"/>
      <stop offset="1" stop-color="${C.purple}"/>
    </linearGradient>
    <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.blue}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowP" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.purple}" stop-opacity="0.4"/>
      <stop offset="1" stop-color="${C.purple}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

// full-canvas opaque background (+ two soft brand glows) — guarantees no alpha
function background(w, h, glows = []) {
  const g = glows
    .map(([cx, cy, r, id]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`)
    .join('');
  return `<rect width="${w}" height="${h}" fill="url(#bg)"/>${g}`;
}

// the product mark, its 512-box top-left placed at (x,y), scaled to `size`
function logo(x, y, size) {
  const s = size / 512;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <g transform="translate(256 256) scale(1.43) translate(-256 -248)">
      <g transform="translate(256 248)" stroke="url(#globe)" stroke-width="28.6" fill="none" stroke-linecap="round">
        <circle cx="0" cy="0" r="165"/>
        <ellipse cx="0" cy="0" rx="72" ry="165" stroke-opacity="0.75"/>
        <line x1="-165" y1="0" x2="165" y2="0" stroke-opacity="0.75"/>
      </g>
      <g transform="translate(303 315) scale(1.62) translate(-329 -341)">
        <path d="M 300 272 L 300 384 L 330 354 L 386 354 Z" fill="${C.amber}"/>
      </g>
    </g>
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

// monospace pill; returns {svg,width}
function chip(x, y, label, o = {}) {
  const {
    size = 20,
    padX = 15,
    h = 38,
    fill = 'rgba(79,107,255,0.13)',
    stroke = 'rgba(124,146,255,0.28)',
    fg = C.chipFg,
  } = o;
  const w = Math.round(label.length * size * 0.6 + padX * 2);
  const svg = `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}"/>
    ${text(x + w / 2, y + h / 2 + size * 0.34, label, { size, font: MONO, fill: fg, anchor: 'middle' })}
  </g>`;
  return { svg, width: w };
}

// flow a row/rows of chips inside [x, x+maxW]; returns {svg, endY}
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

function panel(x, y, w, h, r = 18) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}" stroke="${C.panelStroke}"/>`;
}

function svgDoc(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs()}${inner}</svg>`;
}

// small wordmark lockup (logo + "WebCLI"), top-left corner brand for screenshots
function brandRow(x, y) {
  return `${logo(x, y, 46)}${text(x + 58, y + 33, 'WebCLI', { size: 30, weight: 700, spacing: 0.5 })}`;
}

/* ---------- cards ---------- */
const cards = [];
const W = 1280,
  H = 800;

/** Who can drive WebCLI, as one list — it is rendered twice (the chips and the
 * width calculation that centres them), and two copies drifted once already.
 * "any agent that can curl" is the literal truth and the selling point: the
 * daemon is plain HTTP, and the skill says so ("no MCP setup"). Do NOT write
 * "any MCP client" here — WebCLI has no MCP surface at all since 0.3.0 dropped
 * the web-page relay, which was the only one. (WebMCP in the toolbelt is an
 * unrelated thing: tools a PAGE declares.) */
const AGENT_CHIPS = ['Claude Code', 'Codex', 'any agent that can curl'];

// S1 — HERO
cards.push({
  id: 'screenshot-1-hero',
  w: W,
  h: H,
  label: 'Screenshot 1 · Hero',
  render() {
    let s = background(W, H, [
      [220, 170, 620, 'glowB'],
      [1120, 720, 640, 'glowP'],
    ]);
    s += logo(540, 96, 200);
    s += text(W / 2, 420, 'WebCLI', { size: 96, weight: 800, anchor: 'middle', spacing: 1 });
    s += lines(
      W / 2,
      486,
      [
        'A headless browser-control bridge that hands AI agents',
        'the keys to your real, logged-in Chrome.',
      ],
      42,
      { size: 30, fill: C.sec, anchor: 'middle' },
    );
    const f = chipFlow(0, 580, W, AGENT_CHIPS, {
      size: 22,
      h: 46,
      fill: 'rgba(245,166,35,0.12)',
      stroke: 'rgba(245,166,35,0.35)',
      fg: C.amberSoft,
    });
    // center that flow row: recompute width and shift
    s += `<g transform="translate(${centerFlow(AGENT_CHIPS, 22, 46, 12)} 0)">${f.svg}</g>`;
    s += text(
      W / 2,
      700,
      'No in-browser agent  ·  plain HTTP, no MCP setup  ·  your real Chrome session',
      {
        size: 22,
        fill: C.muted,
        anchor: 'middle',
      },
    );
    return svgDoc(W, H, s);
  },
});

function centerFlow(labels, size, h, gap) {
  const total =
    labels.reduce((a, l) => a + Math.round(l.length * size * 0.6 + 30), 0) +
    gap * (labels.length - 1);
  return Math.round((W - total) / 2);
}

// S2 — HOW IT WORKS
cards.push({
  id: 'screenshot-2-flow',
  w: W,
  h: H,
  label: 'Screenshot 2 · How it works',
  render() {
    let s = background(W, H, [[640, 700, 700, 'glowB']]);
    s += brandRow(72, 60);
    s += text(72, 190, 'Your agent drives your real browser', { size: 46, weight: 700 });
    s += text(
      72,
      236,
      'Locally, through one small daemon on your own machine. Nothing leaves it.',
      {
        size: 26,
        fill: C.sec,
      },
    );

    const nodes = [
      // Node subs are MONO inside a 250px card — anything past ~15 chars spills
      // out over the accent bar (`anything that curls` did). Keep them short;
      // the hero chips carry the longer phrasing.
      { t: 'AI agent', sub: ['Claude Code', 'Codex', 'any CLI agent'], accent: C.amber },
      { t: 'Local daemon', sub: ['localhost :9376', 'plain HTTP'], accent: C.blue },
      { t: 'WebCLI', sub: ['Chrome extension', 'no in-page agent'], accent: C.purple },
      { t: 'Your Chrome', sub: ['real tabs', 'logged-in session'], accent: C.amber },
    ];
    // Card height is DERIVED from the tallest node, not a constant. It used to
    // be a flat 150, which fits two sub lines — and the AI-agent node has had
    // three since the first render, so its last line sat BELOW the card edge in
    // every shipped screenshot (0.2.0 included) until someone looked. A card
    // sized by its content cannot regress that way when a line is added.
    const SUB_TOP = 96,
      SUB_LH = 30,
      SUB_BOTTOM_PAD = 26;
    const maxSubs = Math.max(...nodes.map((n) => n.sub.length));
    const nw = 250,
      nh = SUB_TOP + (maxSubs - 1) * SUB_LH + SUB_BOTTOM_PAD,
      gap = 44,
      y0 = 360;
    const totalW = nodes.length * nw + (nodes.length - 1) * gap;
    let x0 = Math.round((W - totalW) / 2);
    nodes.forEach((n, i) => {
      const x = x0 + i * (nw + gap);
      s += panel(x, y0, nw, nh, 20);
      s += `<rect x="${x}" y="${y0}" width="6" height="${nh}" rx="3" fill="${n.accent}"/>`;
      s += text(x + nw / 2, y0 + 58, n.t, { size: 30, weight: 700, anchor: 'middle' });
      s += lines(x + nw / 2, y0 + SUB_TOP, n.sub, SUB_LH, {
        size: 20,
        fill: C.sec,
        anchor: 'middle',
        font: MONO,
      });
      if (i < nodes.length - 1) {
        const ax = x + nw + gap / 2;
        const ay = y0 + nh / 2;
        s += `<line x1="${ax - gap / 2 + 6}" y1="${ay}" x2="${ax + gap / 2 - 14}" y2="${ay}" stroke="${C.muted}" stroke-width="3"/>`;
        s += `<path d="M ${ax + gap / 2 - 14} ${ay - 8} L ${ax + gap / 2} ${ay} L ${ax + gap / 2 - 14} ${ay + 8} Z" fill="${C.sec}"/>`;
      }
    });
    s += text(
      W / 2,
      640,
      'Bidirectional: the agent calls a tool → WebCLI runs it in Chrome → the result flows back.',
      {
        size: 24,
        fill: C.sec,
        anchor: 'middle',
      },
    );
    s += text(W / 2, 690, 'Bring your own model. WebCLI is the hands, not the brain.', {
      size: 24,
      fill: C.muted,
      anchor: 'middle',
    });
    return svgDoc(W, H, s);
  },
});

// S3 — TOOLBELT
cards.push({
  id: 'screenshot-3-tools',
  w: W,
  h: H,
  label: 'Screenshot 3 · Toolbelt',
  render() {
    let s = background(W, H, [[1080, 120, 560, 'glowP']]);
    s += brandRow(72, 60);
    s += text(72, 186, '35+ browser primitives', { size: 46, weight: 700 });
    s += text(72, 230, 'The low-level building blocks agents actually need — not a black box.', {
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
      // The reconnaissance row is 0.4.0's headline: it is what lets an agent work
      // out an unfamiliar site instead of waiting for someone to add support.
      {
        t: 'Recon & your own JS',
        c: ['find_structured_data', 'get_a11y_tree', 'capture_network', 'eval_js'],
      },
      {
        t: 'Persistent page rules',
        c: ['create_site_script', 'preview_site_script', 'list_site_scripts', 'delete_site_script'],
      },
      { t: 'Tabs', c: ['list_tabs', 'get_active_tab', 'manage_tabs', 'close_tab'] },
      { t: 'Page-declared tools', c: ['list_webmcp_tools', 'call_webmcp_tool'] },
    ];
    // Eight groups now (recon + site scripts joined in 0.4.0), so the rhythm is
    // tighter than it was at six: start higher and advance less. The bottom of
    // the last row must stay clear of the 800px edge — measure, don't eyeball.
    let y = 284;
    for (const g of groups) {
      s += text(72, y + 4, g.t, { size: 22, weight: 700, fill: C.amberSoft });
      const f = chipFlow(320, y - 22, W - 320 - 72, g.c, { size: 19, h: 32, rowGap: 8 });
      s += f.svg;
      y = Math.max(y + 46, f.endY + 26);
    }
    return svgDoc(W, H, s);
  },
});

// S4 — WHY
cards.push({
  id: 'screenshot-4-why',
  w: W,
  h: H,
  label: 'Screenshot 4 · Why WebCLI',
  render() {
    let s = background(W, H, [
      [240, 720, 640, 'glowB'],
      [1080, 120, 560, 'glowP'],
    ]);
    s += brandRow(72, 60);
    s += text(72, 186, 'Why WebCLI', { size: 46, weight: 700 });
    s += text(72, 230, 'A focused provider, not another agent framework.', {
      size: 26,
      fill: C.sec,
    });

    const feats = [
      [
        'Your real Chrome session',
        'Logged-in and human-like — sails past the bot walls that block headless scrapers.',
      ],
      [
        'No in-browser agent',
        'A pure browser-control provider. Bring your own model and orchestration.',
      ],
      [
        'One way in',
        'A daemon bound to 127.0.0.1, driven over plain HTTP. No web page can reach it.',
      ],
      [
        'Tiny & side-by-side',
        'Well under a megabyte, generic tools only. Runs next to the full Web Agent extension.',
      ],
      [
        'Cookie-authed fetch',
        'Raw fetch_url rides your cookies + CORS-free host access for JSON, RSS, sitemaps.',
      ],
      [
        'Auto-reconnect',
        'A 1-minute alarm redial connects within a minute of your daemon starting.',
      ],
    ];
    const cw = 548,
      ch = 132,
      gx = 40,
      gy = 28,
      x0 = 72,
      y0 = 274;
    feats.forEach(([t, d], i) => {
      const cx = x0 + (i % 2) * (cw + gx);
      const cy = y0 + Math.floor(i / 2) * (ch + gy);
      s += panel(cx, cy, cw, ch, 18);
      s += `<circle cx="${cx + 40}" cy="${cy + 40}" r="15" fill="none" stroke="url(#brand)" stroke-width="4"/>`;
      s += `<path d="M ${cx + 33} ${cy + 40} L ${cx + 38} ${cy + 45} L ${cx + 48} ${cy + 34}" fill="none" stroke="${C.amber}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      s += text(cx + 70, cy + 48, t, { size: 26, weight: 700 });
      const dl = wrap(d, 46);
      s += lines(cx + 70, cy + 82, dl, 28, { size: 19, fill: C.sec });
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
    let s = background(W, H, [[640, 720, 720, 'glowP']]);
    s += brandRow(72, 60);
    s += text(72, 190, 'Up and running in three steps', { size: 46, weight: 700 });

    const steps = [
      [
        '1',
        'Install WebCLI',
        'Add it from the Chrome Web Store. It runs headless — only a small status popup.',
      ],
      [
        '2',
        'Start the local daemon',
        'One command spins up the bridge on port 9376. WebCLI auto-connects within a minute.',
      ],
      [
        '3',
        'Point your agent at it',
        'Claude Code, Codex or anything that can curl now drives your Chrome through WebCLI.',
      ],
    ];
    let y = 250;
    steps.forEach(([n, t, d]) => {
      s += `<circle cx="104" cy="${y + 18}" r="26" fill="url(#brand)"/>`;
      s += text(104, y + 27, n, { size: 28, weight: 800, anchor: 'middle' });
      s += text(150, y + 12, t, { size: 30, weight: 700 });
      s += text(150, y + 48, d, { size: 22, fill: C.sec });
      y += 118;
    });

    // terminal block
    const tx = 72,
      ty = 618,
      tw = W - 144,
      th = 120;
    s += `<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="14" fill="#05070F" stroke="rgba(255,255,255,0.10)"/>`;
    s += `<circle cx="${tx + 24}" cy="${ty + 24}" r="6" fill="#ff5f56"/><circle cx="${tx + 44}" cy="${ty + 24}" r="6" fill="#ffbd2e"/><circle cx="${tx + 64}" cy="${ty + 24}" r="6" fill="#27c93f"/>`;
    s += text(tx + 28, ty + 72, '$ npx -y github:whitefoxx/web-tools', {
      size: 24,
      font: MONO,
      fill: '#8CF5A0',
    });
    s += text(
      tx + 28,
      ty + 102,
      '# WebCLI daemon listening on :9376  →  extension connects automatically',
      {
        size: 18,
        font: MONO,
        fill: C.muted,
      },
    );
    return svgDoc(W, H, s);
  },
});

// SMALL PROMO TILE 440x280
cards.push({
  id: 'promo-small-440x280',
  w: 440,
  h: 280,
  label: 'Small promo tile · 440×280',
  render() {
    const w = 440,
      h = 280;
    let s = background(w, h, [
      [110, 90, 260, 'glowB'],
      [360, 250, 240, 'glowP'],
    ]);
    s += logo(170, 30, 100);
    s += text(w / 2, 190, 'WebCLI', { size: 46, weight: 800, anchor: 'middle', spacing: 0.5 });
    s += text(w / 2, 226, 'Browser control for AI agents', {
      size: 20,
      fill: C.sec,
      anchor: 'middle',
    });
    s += text(w / 2, 254, 'headless · localhost · plain HTTP', {
      size: 15,
      fill: C.muted,
      anchor: 'middle',
      font: MONO,
    });
    return svgDoc(w, h, s);
  },
});

// MARQUEE PROMO TILE 1400x560
cards.push({
  id: 'promo-marquee-1400x560',
  w: 1400,
  h: 560,
  label: 'Marquee promo tile · 1400×560',
  render() {
    const w = 1400,
      h = 560;
    let s = background(w, h, [
      [300, 280, 620, 'glowB'],
      [1180, 300, 620, 'glowP'],
    ]);
    s += logo(110, 150, 260);
    s += text(430, 250, 'WebCLI', { size: 104, weight: 800, spacing: 1 });
    s += lines(
      432,
      312,
      ['Give Claude Code, Codex and other AI agents', 'control of your real, logged-in Chrome.'],
      50,
      { size: 34, fill: C.sec },
    );
    const f = chipFlow(
      432,
      400,
      w - 432 - 80,
      ['open_url', 'web_search', 'click', 'get_page_text', 'screenshot', 'list_links', '+21 more'],
      {
        size: 20,
        h: 42,
      },
    );
    s += f.svg;
    return svgDoc(w, h, s);
  },
});

/* ---------- naive word-wrap for description bodies ---------- */
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

// self-contained gallery with per-card JPEG download (canvas rasterize the inline SVG)
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
<title>WebCLI — Chrome Web Store promo assets</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#07090f;color:#e8ecf7;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
  header{max-width:1100px;margin:0 auto 24px}
  h1{font-size:26px;margin:0 0 6px}
  header p{color:#8b93ad;margin:0}
  main{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
  .card{background:#0e1220;border:1px solid #1e2436;border-radius:14px;padding:16px}
  .meta{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .meta h2{font-size:16px;margin:0}
  .dim{color:#727c9c;font:13px ui-monospace,Menlo,monospace}
  .meta button{margin-left:auto;background:linear-gradient(90deg,#4F6BFF,#A44DFF);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer}
  .meta button:active{opacity:.8}
  .frame{width:100%;border-radius:10px;overflow:hidden;border:1px solid #1e2436}
  .frame svg{width:100%;height:auto;display:block}
  .bar{position:sticky;top:0;z-index:5;max-width:1100px;margin:0 auto 20px;display:flex;gap:10px}
  .bar button{background:#182036;color:#cdd6f4;border:1px solid #2a3350;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer}
</style></head><body>
<header><h1>WebCLI — Chrome Web Store promo assets</h1>
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
    const x=c.getContext('2d');x.fillStyle='#0B1020';x.fillRect(0,0,w,h);x.drawImage(img,0,0,w,h);
    c.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=id+'.jpg';a.click();},'image/jpeg',0.94);
  };
  img.src=url;
}
</script></body></html>`;

writeFileSync(join(ROOT, 'promo.html'), html);
console.log('wrote', rendered.length, 'SVGs + promo.html');
