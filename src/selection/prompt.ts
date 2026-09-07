/**
 * What a selection quick action actually sends to a model.
 *
 * Shared because the two shells differ only in WHO answers: the full extension
 * posts this to its own configured provider (background/selection-actions.ts),
 * localmd Connect hands it to the app over the relay and lets localmd's model
 * answer (localmd-connect/ask-model.ts). The instruction, the framing of the
 * passage and the length bound are the same question either way, and a second
 * copy of the wording is a second thing to keep in step.
 *
 * Pure: no chrome, no imports. It is read by a service worker in one shell and
 * by a content-script-adjacent module in the other.
 */

/** How much selected text travels. A quick action is a paragraph or two; past
 *  this the answer is a summary of a summary, and slow. */
export const MAX_LLM_CHARS = 6000;

export const SELECTION_SYSTEM_PROMPT =
  'You are a text-selection assistant inside the browser. Give the result itself directly — no pleasantries, no restating the task, no prefixes like "Sure".' +
  ' Answer in the same language as the user by default (for translation actions, output in the requested target language).';

/** The action's instruction + the passage, told where it came from. The title
 *  is what disambiguates a bare passage ("it" in a changelog vs. in a novel). */
export function composeSelectionPrompt(a: {
  prompt: string;
  text: string;
  title?: string;
}): string {
  return `${a.prompt}\n\n[Selected text]${a.title ? ` (from "${a.title}")` : ''}:\n${a.text}`;
}

/** Cut an over-long selection to what travels, marking the cut. */
export function clampSelection(text: string, max: number = MAX_LLM_CHARS): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/* ── prompt templates (localmd Connect's saved prompts) ──────────────────── */

/**
 * Where the passage goes. `${input}` is accepted as well as `${content}`
 * because that is what several other tools call it, and a prompt someone
 * pasted in should work rather than silently send the literal text.
 */
const CONTENT_VAR = /\$\{\s*(?:content|input)\s*\}/g;
const LANG_VAR = /\$\{\s*lang\s*\}/g;

/** What `${lang}` becomes when no output language has been chosen. A phrase
 *  rather than a language, so a template that mentions it still reads. */
const LANG_FALLBACK = 'the same language as the text';

/** The fence a passage gets when the template never says where it goes. Built
 *  rather than written out, because three double quotes inside a template
 *  literal is a thing every formatter and linter has an opinion about. */
const QUOTES = '"'.repeat(3);

export function hasContentVar(template: string): boolean {
  CONTENT_VAR.lastIndex = 0;
  return CONTENT_VAR.test(template);
}

/**
 * A quick-ask template + the passage → the message that is actually sent.
 *
 * The rule for a template that never mentions `${content}` is the one the
 * user-facing help states: the passage is appended at the end in triple quotes.
 * It matters more than it looks — most prompts people write are instructions
 * with no slot in them ("summarise this in three bullets"), and a tool that
 * answered those with nothing attached would look broken for the commonest
 * thing anyone types.
 */
export function fillPromptTemplate(a: {
  template: string;
  content: string;
  lang?: string;
}): string {
  const lang = (a.lang ?? '').trim() || LANG_FALLBACK;
  const withLang = a.template.replace(LANG_VAR, lang);
  const filled = hasContentVar(withLang)
    ? withLang.replace(CONTENT_VAR, a.content)
    : `${withLang.trimEnd()}\n\n${QUOTES}${a.content}${QUOTES}`;
  return filled.trim();
}
