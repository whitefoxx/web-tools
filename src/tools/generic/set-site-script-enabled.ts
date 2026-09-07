import { cli } from '../../runtime/registry.js';
import { setSiteScriptEnabled, getSiteScript } from '../../site-scripts/store';
import { refreshSiteScript } from '../../site-scripts/register';

/** localmd Connect: enable/disable one site script without deleting it. */
cli({
  site: 'generic',
  name: 'set_site_script_enabled',
  access: 'write',
  local: true,
  description:
    'Enable or disable a persistent site script by id (from list_site_scripts). Disabling unregisters it (takes effect on the next page load of matching tabs); the script itself is kept and can be re-enabled.',
  args: [
    { name: 'id', type: 'string', required: true, help: 'Site-script id, e.g. sitescript_…' },
    { name: 'enabled', type: 'bool', required: true, help: 'true to enable, false to disable' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const id = String(kwargs.id ?? '').trim();
    if (!id) throw new Error('set_site_script_enabled needs id');
    const s = await getSiteScript(id);
    if (!s) throw new Error(`no site script with id ${id} — list_site_scripts shows the ids`);
    const enabled = kwargs.enabled === true || kwargs.enabled === 'true';
    await setSiteScriptEnabled(id, enabled);
    await refreshSiteScript(id);
    return { id, label: s.label, enabled };
  },
});
