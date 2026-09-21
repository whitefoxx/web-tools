/**
 * The icon set, inline — shared by every shell's popup, settings page and
 * in-page toolbar.
 *
 * It lived in `localmd-connect/` until WebCLI grew a settings page of its own
 * and needed the same glyphs. A shell reaching into another shell's folder for
 * a UI primitive is the wrong shape twice over: it couples two products that
 * ship separately, and it hides a shared thing inside one product's namespace.
 *
 * Inline because the extension pages run under a CSP that forbids fetching
 * anything, and because an icon set is a dependency with a version, a license
 * and a build step for six glyphs. Same stroke geometry throughout (24px grid,
 * 1.75 stroke, round caps) so they read as one family rather than six pictures.
 */

const svg = (paths: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
  `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** A page with a corner folded — saving what is on screen. */
export const ICON_CLIP = svg(
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
);
/** A viewport with a crop mark — a rectangle drawn by hand. */
export const ICON_REGION = svg(
  '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
);
/** A tall page with an arrow down it — the whole thing, scrolled. */
export const ICON_FULLPAGE = svg(
  '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 8v8"/><path d="m9 13 3 3 3-3"/>',
);
/** A speech bubble — start a conversation about this. */
export const ICON_ASK = svg('<path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.5A8 8 0 1 1 21 12z"/>');
/** A gear. */
export const ICON_SETTINGS = svg(
  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  15,
);
/** A tick in a circle — this page is already in the folder. */
export const ICON_IN_KB = svg(
  '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  14,
);
/** A highlighter pen. */
export const ICON_MARK = svg(
  '<path d="m9 11-6 6v3h3l6-6"/><path d="M14 6 18 2l4 4-4 4"/><path d="m12 8 4 4"/>',
  14,
);

/** A folder — which knowledge base this is about. */
export const ICON_FOLDER = svg(
  '<path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  14,
);
/** A chevron — there are other folders behind this one. */
export const ICON_CARET = svg('<path d="m6 9 6 6 6-6"/>', 14);
/** An arrow leaving a frame — go to localmd itself. */
export const ICON_OPEN_APP = svg(
  '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  15,
);

/** A bookmark with a line — a passage kept, which is what an annotation is. */
export const ICON_QUOTE = svg(
  '<path d="M7 4h10a2 2 0 0 1 2 2v14l-7-4-7 4V6a2 2 0 0 1 2-2z"/><path d="M9.5 9h5"/>',
);
/** Stacked layers — the browser's own data. */
export const ICON_DATA = svg(
  '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5"/>',
);
/** Angle brackets — code that runs on a page. */
export const ICON_CODE = svg('<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/>');
/** A plug — a ready-made tool for one site. */
export const ICON_PLUG = svg(
  '<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 17v4"/>',
);
/**
 * A four-point star — ask the model about this.
 *
 * One shape, not a wand plus two little crosses: at 16px those crosses were
 * four hairlines meeting at a point, which reads as two plus signs beside a
 * diagonal rather than as a sparkle. A single closed star has one silhouette
 * and survives the size.
 */
export const ICON_SPARK = svg(
  '<path d="M12 3.2 13.85 10.15 20.8 12 13.85 13.85 12 20.8 10.15 13.85 3.2 12 10.15 10.15Z"/>',
);
/** A pencil — write something about this passage. */
export const ICON_PENCIL = svg(
  '<path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m14 6 4 4"/>',
);
/** A drawing pin, seen from the side — keep this where I put it. */
export const ICON_PIN = svg(
  '<path d="M9 3h6"/><path d="M10 3v6l-3 3.5V15h10v-2.5L14 9V3"/><path d="M12 15v6"/>',
);
/** A bin. */
export const ICON_TRASH = svg(
  '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/>',
);
/** A circular arrow — do that again. */
export const ICON_REFRESH = svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/>', 13);
/** A plus. */
export const ICON_PLUS = svg('<path d="M12 5v14"/><path d="M5 12h14"/>', 15);
/** A terminal prompt. */
export const ICON_TERMINAL = svg(
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
);
/** A chevron that points right, and is rotated when a row opens. */
export const ICON_CHEVRON = svg('<path d="m9 6 6 6-6 6"/>', 14);
/**
 * GitHub's Octocat mark — the one icon here that is NOT part of the family
 * above: it is a brand mark, so it is filled rather than stroked, and its
 * geometry is theirs, not our 24px/1.75 grid. Drawn as a single path so it
 * stays legible at 15px next to a line of text.
 */
export const ICON_GITHUB = (size = 16): string =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">` +
  '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
