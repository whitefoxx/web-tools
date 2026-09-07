import { cli } from '../../runtime/registry.js';
import { deleteSiteScript, getSiteScript } from '../../site-scripts/store';
import { unregisterSiteScriptById } from '../../site-scripts/register';

/** localmd Connect: permanently delete one site script. */
cli({
  site: 'generic',
  name: 'delete_site_script',
  access: 'write',
  local: true,
  description:
    'Permanently delete a persistent site script by id (from list_site_scripts): unregisters it and removes the stored record. To keep it but stop it running, use set_site_script_enabled instead.',
  args: [{ name: 'id', type: 'string', required: true, help: 'Site-script id, e.g. sitescript_…' }],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const id = String(kwargs.id ?? '').trim();
    if (!id) throw new Error('delete_site_script needs id');
    const s = await getSiteScript(id);
    await unregisterSiteScriptById(id);
    await deleteSiteScript(id);
    return { deleted: id, label: s?.label ?? null };
  },
});
