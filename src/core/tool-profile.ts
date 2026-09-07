/**
 * Tool-set profiles — how much catalog an external agent has to carry.
 *
 * Borrowed from chrome-devtools-mcp's `--slim` / per-category flags
 * (docs/devtools-mcp-comparison.md §2④). Their 40-tool server presents as ~20
 * because everything expensive is behind a flag. Our catalog is smaller but the
 * cost structure is worse in one way: an external agent re-sends every tool
 * description on EVERY request of its loop, so the catalog is a per-call tax,
 * not a one-time one.
 *
 * Two deliberate design calls:
 *
 *  1. **Hidden ≠ disabled.** A profile filters what `tools/list` and the WS
 *     catalog ADVERTISE; every registered tool stays callable. An agent working
 *     from a cached catalog, a skill that names a tool, or a user who read the
 *     docs must not hit "tool not found" because of a display setting. Making
 *     `core` a hard allowlist would turn a token optimization into a
 *     capability cliff.
 *  2. **`full` is the default.** Shrinking someone's toolset silently is the
 *     kind of change that gets diagnosed as a bug three tools later.
 */

export type ToolProfile = 'core' | 'full';

/**
 * The loop an agent actually drives: get to a page, read it, find the controls,
 * act, confirm, clean up. Everything else — DOM/HTML introspection, tab
 * choreography, dialogs, uploads, drag, hover, key presses, link harvesting —
 * is reachable by name when a task needs it, but does not need to ride along in
 * every request for the majority of tasks that never touch it.
 */
export const CORE_TOOLS: readonly string[] = [
  'open_url',
  'get_page_text',
  'fetch_url',
  'web_search',
  'get_interactives',
  'click',
  'type_into',
  'fill_form',
  'scroll_page',
  'wait_for_selector',
  'screenshot',
  'list_tabs',
  'close_tab',
];

const CORE_SET = new Set(CORE_TOOLS);

/** Accepts either a bare tool name or a `site__name` id. */
export function isInProfile(toolId: string, profile: ToolProfile): boolean {
  if (profile === 'full') return true;
  const i = toolId.indexOf('__');
  return CORE_SET.has(i >= 0 ? toolId.slice(i + 2) : toolId);
}

/** Normalize whatever is in storage into a profile, tolerating junk. */
export function coerceProfile(raw: unknown): ToolProfile {
  return raw === 'core' ? 'core' : 'full';
}

export const TOOL_PROFILE_KEY = 'toolProfile';

/** Read the configured profile from `chrome.storage.local`. Never throws — a
 * storage failure must not take the catalog down with it. */
export async function loadToolProfile(): Promise<ToolProfile> {
  try {
    const got = await chrome.storage.local.get([TOOL_PROFILE_KEY]);
    return coerceProfile(got[TOOL_PROFILE_KEY]);
  } catch {
    return 'full';
  }
}
