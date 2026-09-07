import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

/**
 * handle_dialog — pre-arm an auto-handler for native JS dialogs (alert /
 * confirm / prompt). Native dialogs BLOCK the page's event loop, which
 * deadlocks automation: a page that pops `confirm("delete?")` when the agent
 * clicks a button freezes further executeScript on that tab. This installs a
 * MAIN-world override that auto-accepts or auto-dismisses the NEXT dialogs (and
 * logs them, so the agent can see what it answered), so the click that would
 * have blocked instead sails through.
 *
 * Arm it BEFORE the action that triggers the dialog. It overrides window.alert/
 * confirm/prompt (the JS-initiated dialogs) — it does NOT cover the browser's
 * own beforeunload / file-download / basic-auth chrome (those aren't
 * `window.*`-driven). Content scripts run in the ISOLATED world, so we inject
 * into `world:'MAIN'` to replace the page's real dialog functions.
 *
 * `installDialogHandler` is self-contained (serialized alone) + exported for
 * jsdom unit testing.
 */

/** In-page (MAIN world). Overrides window.alert/confirm/prompt to auto-answer,
 * accumulating a log across re-arms; `disarm` restores the originals. Returns
 * the current state + handled-dialog log. */
export function installDialogHandler(
  action: 'accept' | 'dismiss' | 'disarm',
  promptText: string | null,
): {
  armed: boolean;
  action?: 'accept' | 'dismiss';
  handled: number;
  dialogs: { type: string; message: string }[];
} {
  const w = window as unknown as Record<string, unknown>;
  const KEY = '__webAgentDialogHandler__';
  type Saved = {
    alert: typeof window.alert;
    confirm: typeof window.confirm;
    prompt: typeof window.prompt;
    log: { type: string; message: string }[];
  };
  const existing = w[KEY] as Saved | undefined;

  if (action === 'disarm') {
    if (existing) {
      window.alert = existing.alert;
      window.confirm = existing.confirm;
      window.prompt = existing.prompt;
      delete w[KEY];
    }
    return { armed: false, handled: existing ? existing.log.length : 0, dialogs: existing?.log ?? [] };
  }

  const state: Saved = existing ?? {
    alert: window.alert.bind(window),
    confirm: window.confirm.bind(window),
    prompt: window.prompt.bind(window),
    log: [],
  };
  w[KEY] = state;

  const accept = action !== 'dismiss';
  window.alert = (msg?: unknown): void => {
    state.log.push({ type: 'alert', message: String(msg ?? '') });
  };
  window.confirm = (msg?: unknown): boolean => {
    state.log.push({ type: 'confirm', message: String(msg ?? '') });
    return accept;
  };
  window.prompt = (msg?: unknown, def?: unknown): string | null => {
    state.log.push({ type: 'prompt', message: String(msg ?? '') });
    if (!accept) return null;
    return promptText != null ? promptText : String(def ?? '');
  };

  return {
    armed: true,
    action: accept ? 'accept' : 'dismiss',
    handled: state.log.length,
    dialogs: state.log.slice(-10),
  };
}

cli({
  site: 'generic',
  name: 'handle_dialog',
  access: 'read',
  description:
    'Pre-arm automatic answers for dialogs, so native JS popups (alert/confirm/prompt) do not **block and hang** automation — a confirm() on delete/submit/leave freezes everything after it. **Call this before any action that may trigger a popup**: action:"accept" (default; confirm→true, prompt→returns prompt_text or the default value) | "dismiss" (confirm→false, prompt→null) | "disarm" (restore native popups). Records the dialogs it answered (see the returned dialogs for what was answered). Injects into the MAIN world to override window.alert/confirm/prompt; does not handle the browser\'s built-in beforeunload/download/basic-auth prompts.',
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'Target tab id' },
    {
      name: 'action',
      type: 'string',
      default: 'accept',
      help: 'accept (default, confirm) | dismiss (cancel) | disarm (restore native popups)',
    },
    {
      name: 'prompt_text',
      type: 'string',
      help: 'accept only: text to enter for a prompt() dialog (if omitted, uses the default the page provided)',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const action = ['accept', 'dismiss', 'disarm'].includes(String(kwargs.action))
      ? (String(kwargs.action) as 'accept' | 'dismiss' | 'disarm')
      : 'accept';
    const promptText = typeof kwargs.prompt_text === 'string' ? kwargs.prompt_text : null;
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installDialogHandler,
      args: [action, promptText],
    });
    const r = res[0]?.result;
    if (!r) throw new Error('executeScript returned no result (tab not scriptable?)');
    return { tabId, ...r };
  },
});
