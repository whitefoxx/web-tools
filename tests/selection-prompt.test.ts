/**
 * Quick-ask prompt templates — the contract the settings page states in words
 * and this file states in tests (docs/localmd-connect.md §14.4p).
 *
 * The rule worth pinning is the one about a template that never mentions the
 * passage: most prompts people write are pure instructions ("summarise this in
 * three bullets"), and a tool that answered those with nothing attached would
 * look broken for the commonest thing anyone types.
 */
import { describe, it, expect } from 'vitest';
import { fillPromptTemplate, hasContentVar } from '../src/selection/prompt';

const Q = '"'.repeat(3);

describe('fillPromptTemplate', () => {
  it('puts the passage where the template says', () => {
    expect(fillPromptTemplate({ template: 'Translate ${content} now', content: 'hello' })).toBe(
      'Translate hello now',
    );
  });

  it('appends the passage in triple quotes when the template never says', () => {
    expect(fillPromptTemplate({ template: 'Summarise this.', content: 'hello' })).toBe(
      `Summarise this.\n\n${Q}hello${Q}`,
    );
  });

  it('accepts ${input} as well, because that is what other tools call it', () => {
    expect(fillPromptTemplate({ template: 'Fix ${input}', content: 'x' })).toBe('Fix x');
    expect(hasContentVar('a ${ input } b')).toBe(true);
    expect(hasContentVar('${lang} only')).toBe(false);
  });

  it('fills the language, everywhere it appears', () => {
    expect(
      fillPromptTemplate({
        template: 'In ${lang}: explain ${content}. Answer in ${lang}.',
        content: 'x',
        lang: '简体中文',
      }),
    ).toBe('In 简体中文: explain x. Answer in 简体中文.');
  });

  it('still reads when no language has been chosen', () => {
    // A phrase rather than a blank: "Explain in ." is a worse prompt than one
    // that simply asks for the language it was already in.
    const out = fillPromptTemplate({ template: 'Explain in ${lang}: ${content}', content: 'x' });
    expect(out).toBe('Explain in the same language as the text: x');
    expect(fillPromptTemplate({ template: 'x ${lang}', content: 'y', lang: '   ' })).toContain(
      'the same language as the text',
    );
  });

  it('handles the substitutions in the right order', () => {
    // ${lang} is filled first, so a passage that happens to contain the text
    // "${lang}" is not treated as a variable. The passage is data.
    expect(
      fillPromptTemplate({ template: 'Echo ${content}', content: 'literally ${lang}', lang: 'X' }),
    ).toBe('Echo literally ${lang}');
  });

  it('leaves a $-sign that is not a variable alone', () => {
    expect(fillPromptTemplate({ template: 'Costs $5 ${content}', content: 'a' })).toBe(
      'Costs $5 a',
    );
  });
});
