import { cli } from '../../runtime/registry.js';
import { listSiteScripts } from '../../site-scripts/store';
import { siteScriptsRunnable } from '../../site-scripts/register';

/** localmd Connect: list every persistent site script (see create_site_script). */
cli({
  site: 'generic',
  name: 'list_site_scripts',
  access: 'read',
  local: true,
  description:
    'List all persistent site scripts (created via create_site_script or the extension), with id/label/matches/what they inject (has_css/has_js)/enabled — a SUMMARY. Use get_site_script(id) for one script\'s full source (selectors/css/js). `runnable: false` means the "Allow user scripts" toggle is off — scripts are stored but none run until the user enables it at chrome://extensions.',
  columns: ['id', 'label', 'matches', 'hidden', 'has_css', 'has_js', 'run_at', 'enabled'],
  func: async () => {
    const rows = await listSiteScripts();
    return {
      runnable: siteScriptsRunnable(),
      scripts: rows.map((s) => ({
        id: s.id,
        label: s.label,
        matches: s.matches,
        hidden: s.hideSelectors?.length ?? 0,
        has_css: !!s.css,
        has_js: !!s.js,
        run_at: s.runAt,
        enabled: s.enabled,
      })),
    };
  },
});
