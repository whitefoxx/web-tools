/**
 * The selection bar's quick actions, answered by localmd's model.
 *
 * This shell has no model of its own and never will — it holds no API key, and
 * an extension that asked for one would be asking the user to configure a
 * second copy of something the app already has. What it has instead is a page
 * of localmd on the other end of the relay, so a quick action becomes a
 * question ASKED BACK down the MCP connection: `sampling/createMessage`, the
 * one direction of MCP this integration had never used (docs/localmd-connect.md
 * §14.4b listed it as what in-page quick actions would need).
 *
 * Everything here is pure or dependency-injected, so the wire shapes and the
 * wake-the-app retry are testable without a browser.
 */
import { NO_CLIENT_MESSAGE } from '../core/external-mcp-core';
import { SELECTION_SYSTEM_PROMPT } from '../selection/prompt';

export const SAMPLING_METHOD = 'sampling/createMessage';

/** Output ceiling. A quick action is read in a popover on the page — a model
 *  that wants to write an essay is answering the wrong question. */
export const SAMPLING_MAX_TOKENS = 1200;

/** What the model's answer may occupy in the popover. Generous next to the
 *  token cap above (which the model may ignore); this one is ours. */
const MAX_ANSWER_CHARS = 20_000;

export interface SelectionAsk {
  /**
   * The whole message. The prompt's template and the passage are already
   * combined by the page (`fillPromptTemplate`), which is where the settings
   * live — so nothing here re-frames it. That matters: the help promises that
   * a prompt is sent as written, with the passage appended only when the
   * template never says where it goes, and a second layer of framing would
   * quietly make that untrue.
   */
  prompt: string;
  /** Which prompt this was, for logs and the popover's title. */
  label?: string;
  url?: string;
}

/** The MCP `sampling/createMessage` params for one quick action. */
export function samplingParams(a: SelectionAsk): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: { type: 'text', text: a.prompt } }],
    systemPrompt: SELECTION_SYSTEM_PROMPT,
    maxTokens: SAMPLING_MAX_TOKENS,
    // Not part of the spec's required shape — carried so the app can say what
    // it is spending a completion on, and so a receipt in localmd can point
    // back at the page the passage came from.
    metadata: {
      source: 'localmd-connect/selection',
      ...(a.label ? { action: a.label } : {}),
      ...(a.url ? { url: a.url } : {}),
    },
  };
}

/**
 * The text out of a `sampling/createMessage` result.
 *
 * The spec says `content` is ONE block, but clients built against the
 * array-shaped `tools/call` result send an array often enough that refusing it
 * would be pedantry with a blank popover attached.
 */
export function samplingText(result: unknown): string {
  const r = (result ?? {}) as { content?: unknown };
  const blocks = Array.isArray(r.content) ? r.content : [r.content];
  const out = blocks
    .map((b) => {
      const block = (b ?? {}) as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return out.length > MAX_ANSWER_CHARS ? out.slice(0, MAX_ANSWER_CHARS) + '…' : out;
}

export interface AskModelDeps {
  /** One server→client request over the relay, ALREADY ADDRESSED: which app a
   *  build belongs to is the service worker's to know (LOCALMD_APP_ORIGINS),
   *  not something to re-decide per question. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Make sure a localmd page exists and has connected. Called only when the
   *  first attempt found nobody home. */
  wakeApp(): Promise<void>;
}

export interface WakeDeps {
  /** Find the app's tab, opening one in the background if there is none. */
  ensureTab(): Promise<{ tabId: number | null; opened: boolean }>;
  /** Re-announce the relay into a tab that was already open. */
  nudge(tabId: number): Promise<void>;
  /** Resolves when some page completes the MCP handshake. */
  waitForClient(): Promise<void>;
}

/**
 * Get a localmd listening.
 *
 * The case this exists for is not "no localmd is open" — that one opens a tab
 * and works. It is **a localmd that is open and not connected**, which is the
 * state every extension reload leaves behind: the port dies, the app's row goes
 * to error, the relay heals itself when the service worker re-injects it, and
 * the app never finds out because a client is what starts an MCP conversation.
 * Nothing re-probed a failed row except a focus event, so a localmd in a
 * background tab stayed dead — and this failed with "did not connect in time"
 * against a tab that was open and healthy. Reported from real use, 2026-09-05.
 *
 * The nudge is the protocol's own signal, posted again: a `ready:true` frame
 * into that tab. It costs one injected postMessage, changes nothing on the
 * page, and an app new enough to listen for it reconnects on the spot. An older
 * app ignores it and the wait ends in the message that names the manual fix,
 * which is the one the user found by hand.
 */
export async function wakeApp(deps: WakeDeps): Promise<void> {
  const { tabId, opened } = await deps.ensureTab();
  if (!opened && tabId !== null) {
    await deps.nudge(tabId).catch(() => {
      /* a tab we cannot inject into is one the wait will report on */
    });
  }
  try {
    await deps.waitForClient();
  } catch {
    throw new Error(
      opened
        ? 'localmd opened but did not connect in time'
        : 'localmd is open but not connected to the extension — switch to its tab once, or reload it',
    );
  }
}

export type AskModelResult = { ok: true; result: string } | { ok: false; error: string };

/** True when a request failed only because no localmd page was connected. */
export function isNoClient(e: unknown): boolean {
  return e instanceof Error && e.message === NO_CLIENT_MESSAGE;
}

/**
 * Ask localmd's model, opening the app first if it is not already listening.
 *
 * The retry is the whole reason this is not two lines at the call site: the
 * relay only exists inside a localmd tab, so the common case for someone
 * reading an article is that there is no connection at all. Clips already deal
 * with this by opening the app in the background; a quick action does the same
 * and then asks again, which costs a second on the first action of a session
 * and nothing after it.
 */
export async function askModelViaApp(
  deps: AskModelDeps,
  ask: SelectionAsk,
): Promise<AskModelResult> {
  const params = samplingParams(ask);
  let result: unknown;
  try {
    result = await deps.request(SAMPLING_METHOD, params);
  } catch (e) {
    if (!isNoClient(e)) return { ok: false, error: messageOf(e) };
    try {
      await deps.wakeApp();
      result = await deps.request(SAMPLING_METHOD, params);
    } catch (again) {
      return {
        ok: false,
        error: isNoClient(again)
          ? 'localmd did not answer. Open it in a tab and try again.'
          : messageOf(again),
      };
    }
  }
  const text = samplingText(result);
  return text ? { ok: true, result: text } : { ok: false, error: 'localmd returned no text' };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
