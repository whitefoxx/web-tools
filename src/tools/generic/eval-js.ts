import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import { createPageShim } from '../../runtime/page';
import { detectWriteIntent } from './_eval-write-guard';

/**
 * `eval_js` — run a JavaScript snippet in a tab's page and return its JSON
 * result. Tab-addressed, over a per-call PageShim → CDP `Runtime.evaluate` in
 * the MAIN world: `awaitPromise`, page CSP not applied, the user's login state
 * intact.
 *
 * This is a SHARED-BASE primitive (docs/architecture.md §A.2) — registered by
 * `_generic.ts`, so WebCLI and localmd Connect both get it. It is the escape
 * hatch that lets an agent build any extraction/automation itself and keep it
 * as data (a skill) instead of shipping a per-site tool: a request that must
 * leave from the page's own origin with a header derived from page state, a
 * value that lives only in a page global or a player API, a payload reduced to
 * rows before it reaches the model. YouTube's transcript (docs/localmd-connect.md
 * §15.4) is the reference case.
 *
 * The full shell does NOT get this variant: `_all.ts` imports `_generic` and
 * then `explore/_all`, whose session-bound `explore/eval-js.ts` re-registers
 * `eval_js` last (registry is last-write-wins on site/name), so the full shell
 * keeps its explore-session eval_js. The two share the static write guard.
 *
 * Attach/detach is per call: the shim tolerates an attachment another client
 * already holds on the tab and then does not detach it. Chrome shows its "is
 * being debugged" bar on the tab for the duration.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

cli({
  site: 'generic',
  name: 'eval_js',
  access: 'read',
  description:
    "Run a JavaScript snippet in a tab's page and return its result. It runs in the page's MAIN world over the debugger (same-origin, the user's cookies, page globals and the page's own JS APIs available, page CSP not applied) — so use it for what the other tools cannot do: read a framework's state object, call the page's own API, make a same-origin request that needs a header taken from a cookie, or turn a large payload into rows INSIDE the page instead of hauling it through the conversation. Write `return …;` (the snippet is wrapped in an async function, so `await` works) or a single expression / async arrow; the value must be JSON-serializable. Return the rows you need, never a whole payload — max_chars truncates the rest. A snippet that obviously performs a write (method:POST/PUT/DELETE/PATCH, XMLHttpRequest.open with a write verb, form submit, sendBeacon) is refused unless allow_write:true — get your user's explicit confirmation before passing that. Chrome shows its \"is being debugged\" bar on the tab while the call runs.",
  args: [
    { name: 'tab_id', type: 'int', required: true, help: 'The tab whose page runs the snippet' },
    {
      name: 'code',
      type: 'string',
      required: true,
      help: 'JS snippet: `return …;` statements (async, so `await` is fine), an async arrow, or a single expression. Must return a JSON-serializable value',
    },
    {
      name: 'max_chars',
      type: 'int',
      default: 8000,
      help: 'Max characters of the serialized result to return (default 8000, cap 200000)',
    },
    {
      name: 'timeout_ms',
      type: 'int',
      default: DEFAULT_TIMEOUT_MS,
      help: 'Give up after this long (ms, default 60000, cap 180000) — the snippet is abandoned and the debugger released',
    },
    {
      name: 'allow_write',
      type: 'bool',
      help: 'Default false: an obvious write request in the snippet is refused. Pass true ONLY after your user confirmed that write — this is a channel with their login, and nothing else confirms it',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    await assertTabId(kwargs.tab_id);
    const tabId = Number(kwargs.tab_id);
    const code = typeof kwargs.code === 'string' ? kwargs.code : '';
    if (!code.trim()) return { ok: false, error: 'code must not be empty' };

    const writeSignal = detectWriteIntent(code);
    if (writeSignal && !kwargs.allow_write) {
      return {
        ok: false,
        error:
          `Blocked: this code looks like it initiates a write request (${writeSignal}). ` +
          'eval_js runs with your user\'s login and nothing confirms a write it makes. If the user has explicitly asked for and confirmed this write, call again with allow_write:true; otherwise observe the request\'s shape (endpoint, method, where the token comes from) and report it instead of sending it.',
      };
    }

    const maxChars = Math.max(200, Math.min(Number(kwargs.max_chars ?? 8000) || 8000, 200_000));
    const timeoutMs = Math.max(
      1000,
      Math.min(Number(kwargs.timeout_ms ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    const page = await createPageShim(tabId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        page.evaluate<unknown>(code),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`eval_js timed out after ${timeoutMs}ms (snippet abandoned)`)),
            timeoutMs,
          );
        }),
      ]);
      let serialized: string;
      if (result === undefined) serialized = 'undefined';
      else if (typeof result === 'string') serialized = result;
      else {
        try {
          serialized = JSON.stringify(result, null, 2);
        } catch {
          serialized = String(result);
        }
      }
      const truncated = serialized.length > maxChars;
      return {
        ok: true,
        tabId,
        resultType: Array.isArray(result) ? `array(${result.length})` : typeof result,
        truncated,
        result: truncated ? serialized.slice(0, maxChars) + '\n…[truncated]' : serialized,
      };
    } catch (e) {
      // Evaluation errors are the normal iteration signal — return them so the
      // agent can fix the snippet, instead of throwing.
      return { ok: false, tabId, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        // Releases the attachment when this call made it; a no-op when an
        // adapter run already held it (the shim tracks ownership).
        await page.detach();
      } catch {
        /* ignore */
      }
    }
  },
});
