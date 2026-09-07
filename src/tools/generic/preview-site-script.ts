import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import {
  previewSiteScript,
  dryRunSiteScriptJs,
  type DryRunResult,
} from '../../site-scripts/register';
import { parseStringArray } from './create-site-script';

/**
 * localmd Connect: try a candidate site script on a LIVE tab before committing
 * it with create_site_script — the verify step of the authoring loop (a blind
 * create→reload→hope loop is the #1 way these fail).
 */
cli({
  site: 'generic',
  name: 'preview_site_script',
  access: 'read',
  description:
    'Try a candidate site script on an open tab WITHOUT persisting anything (gone on reload): hide_selectors/css are injected transiently and the result reports how many elements the selectors matched (highlight:true outlines matches instead of hiding — good for showing the user what would be affected); dry_run_js runs candidate JS once in the same USER_SCRIPT world persistent scripts use, returning its console output / thrown error / return value. That world runs your code inside a PLAIN function and forbids eval, so no top-level `await` and no `new Function` — a parse failure comes back as ran:false with an explanation, not as a silent success. Use this to verify selectors and JS logic, and to show the user the effect, BEFORE create_site_script.',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'Open tab to preview on' },
    {
      name: 'hide_selectors',
      type: 'string',
      help: 'JSON array of CSS selectors to hide (or outline with highlight:true)',
    },
    { name: 'css', type: 'string', help: 'Raw CSS to inject transiently' },
    {
      name: 'highlight',
      type: 'bool',
      help: 'true = outline elements matched by hide_selectors instead of hiding them',
    },
    {
      name: 'dry_run_js',
      type: 'string',
      help: 'Candidate JS to execute once in the USER_SCRIPT world (needs the "Allow user scripts" toggle)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await assertTabId(kwargs.tab_id);
    const tabId = Number(kwargs.tab_id);
    const hideSelectors = parseStringArray(kwargs.hide_selectors);
    const css = typeof kwargs.css === 'string' && kwargs.css.trim() ? kwargs.css.trim() : undefined;
    const js =
      typeof kwargs.dry_run_js === 'string' && kwargs.dry_run_js.trim()
        ? kwargs.dry_run_js
        : undefined;
    if (!hideSelectors.length && !css && !js) {
      throw new Error('preview_site_script needs at least one of hide_selectors, css, dry_run_js');
    }
    let cssPreview: { matched: number; injected: boolean } | undefined;
    if (hideSelectors.length || css) {
      cssPreview = await previewSiteScript(tabId, hideSelectors, css, kwargs.highlight === true);
    }
    let dryRun: DryRunResult | undefined;
    if (js) {
      dryRun = await dryRunSiteScriptJs(tabId, js);
    }
    return {
      ...(cssPreview ? { css_preview: cssPreview } : {}),
      ...(dryRun ? { dry_run: dryRun } : {}),
    };
  },
});
