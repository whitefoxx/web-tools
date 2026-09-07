import { cli } from '../../runtime/registry.js';
import { getSiteScript } from '../../site-scripts/store';

/**
 * Read back the FULL source of one persistent site script. `list_site_scripts`
 * only summarises (has_css / has_js booleans); this returns the actual match
 * patterns, hidden selectors, CSS and JS — so the agent (and, through the popup
 * that shows the same, the user) can review exactly what runs on their pages
 * before trusting or deleting a rule. Persistent injected code must be
 * inspectable.
 */
cli({
  site: 'generic',
  name: 'get_site_script',
  access: 'read',
  local: true,
  description:
    'Show the FULL source of ONE persistent site script by id (ids come from list_site_scripts): its match patterns, hidden selectors, injected CSS and JS, and whether it can call the LLM. Use this to review what a saved rule actually runs before keeping or deleting it — list_site_scripts only summarises.',
  args: [{ name: 'id', type: 'string', required: true, help: 'Site-script id, e.g. sitescript_…' }],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const id = String(kwargs.id ?? '').trim();
    if (!id) throw new Error('get_site_script needs id');
    const s = await getSiteScript(id);
    if (!s) throw new Error(`no site script with id ${id} — list_site_scripts shows the ids`);
    return {
      id: s.id,
      label: s.label,
      matches: s.matches,
      hide_selectors: s.hideSelectors ?? [],
      css: s.css ?? null,
      js: s.js ?? null,
      llm_access: !!s.llmAccess,
      run_at: s.runAt,
      enabled: s.enabled,
      origin: s.origin,
    };
  },
});
