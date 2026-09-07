import { cli } from '../../runtime/registry.js';
import {
  buildSiteScript,
  putSiteScript,
  listSiteScripts,
  makeSiteScriptId,
  flagFragileSelectors,
} from '../../site-scripts/store';
import { refreshSiteScript, siteScriptsRunnable } from '../../site-scripts/register';

/**
 * localmd Connect: create (or update, by label) a PERSISTENT site script —
 * hide-selectors, raw CSS, and raw JS are ALL allowed here, unlike the full
 * shell's bridge (hide-only). The user-facing confirmation step is DELEGATED to
 * the calling app (localmd) by documented contract — see the description and
 * docs/localmd-connect.md. The extension popup keeps list/disable/delete as the
 * user's fallback control.
 *
 * `llmAccess` is deliberately NOT accepted: this shell has no LLM config, so
 * the page↔LLM bridge does not exist here.
 */

/** Tolerant array arg: JSON array string, an actual array, or one bare string. */
export function parseStringArray(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        /* fall through — treat as one bare value */
      }
    }
    return [s];
  }
  return [];
}

cli({
  site: 'generic',
  name: 'create_site_script',
  access: 'write',
  local: true,
  description:
    'Create (or update, matched by label) a PERSISTENT site script: on every page load matching `matches`, hide `hide_selectors`, inject `css`, and/or run `js` (USER_SCRIPT world) — for ad removal, decluttering, and page enhancement that outlives this session. CONTRACT: before calling this with css/js, the calling app MUST show the user the match patterns and exactly what will be hidden/injected and get explicit confirmation — this tool trusts that the confirm already happened. Verify first: preview_site_script shows hide/css effects and dry-runs js on a live tab. `matches` must be specific host patterns (e.g. https://*.example.com/*) — all-URL patterns are rejected. The user can disable/delete every script from the extension popup.',
  args: [
    {
      name: 'matches',
      type: 'string',
      required: true,
      help: 'JSON array of match patterns, e.g. ["https://*.zhihu.com/*"] (a single pattern string also works)',
    },
    {
      name: 'label',
      type: 'string',
      help: 'Display name, e.g. "zhihu ad removal". Reusing an existing label UPDATES that script.',
    },
    {
      name: 'hide_selectors',
      type: 'string',
      help: 'JSON array of CSS selectors to hide, e.g. [".ad-banner", "#promo"]',
    },
    { name: 'css', type: 'string', help: 'Raw CSS injected as-is on matching pages' },
    {
      name: 'js',
      type: 'string',
      help: 'Raw JS run on matching pages in the USER_SCRIPT world (needs the "Allow user scripts" toggle). High-impact — dry-run via preview_site_script first.',
    },
    {
      name: 'run_at',
      type: 'string',
      help: 'document_start (default) | document_end | document_idle',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const matches = parseStringArray(kwargs.matches);
    const hideSelectors = parseStringArray(kwargs.hide_selectors);
    const css = typeof kwargs.css === 'string' && kwargs.css.trim() ? kwargs.css : undefined;
    const js = typeof kwargs.js === 'string' && kwargs.js.trim() ? kwargs.js : undefined;
    if (!hideSelectors.length && !css && !js) {
      throw new Error('create_site_script needs at least one of hide_selectors, css, js');
    }
    const label = typeof kwargs.label === 'string' ? kwargs.label.trim() : undefined;
    const runAt = typeof kwargs.run_at === 'string' && kwargs.run_at ? kwargs.run_at : undefined;
    const existing = label ? (await listSiteScripts()).find((s) => s.label === label) : undefined;
    // buildSiteScript is the validation chokepoint (match-pattern specificity,
    // selector sanitizing) — its errors propagate verbatim to the caller.
    const s = buildSiteScript(
      {
        ...(label ? { label } : {}),
        matches,
        hideSelectors,
        css,
        js,
        ...(runAt ? { runAt } : {}),
        origin: { type: 'agent', note: 'created via localmd Connect' },
      },
      existing?.id ?? makeSiteScriptId(),
      Date.now(),
    );
    await putSiteScript(s);
    await refreshSiteScript(s.id);
    return {
      id: s.id,
      label: s.label,
      matches: s.matches,
      hidden: s.hideSelectors?.length ?? 0,
      has_css: !!s.css,
      has_js: !!s.js,
      updated: !!existing,
      // false = the "Allow user scripts" toggle is off: the script is SAVED but
      // cannot run until the user enables the toggle (popup shows the warning).
      runnable: siteScriptsRunnable(),
      fragileSelectors: flagFragileSelectors(s.hideSelectors),
    };
  },
});
