#!/usr/bin/env node
// Lint a `store/*/store-listing.md` as what it actually is: a PASTE SOURCE for
// the Chrome Web Store dashboard.
//
// The dashboard renders every field as PLAIN TEXT in a textarea that wraps by
// itself. Three habits from writing markdown cost something on the way into it,
// and all three were in these files until 2026-09-21:
//
//   `**bold**`      ships literally — the asterisks appear on the live listing
//   `> blockquote`  has to be deleted by hand after every copy
//   hard wrapping   survives the paste as a line break mid-sentence
//
// So the convention this enforces: anything that is not a `#` heading and not
// inside an `<!-- NOTE (not pasted) ... -->` comment is a field value, written
// as ONE line per paragraph / bullet / numbered item, in plain text. Emphasis in
// a field value is an emoji or nothing.
//
//   node scripts/check-store-listing.mjs store/*/store-listing.md
//
// Everything from the `## Assets` heading on is internal bookkeeping and is not
// checked.

import { readFileSync } from 'node:fs';

const BAD = [
  [/\*\*/, 'bold ** (renders literally)'],
  [/^>/, 'blockquote > (has to be deleted after a copy)'],
  [/`/, 'backtick (renders literally)'],
  [/\[[^\]]+\]\([^)]+\)/, 'markdown link (renders literally)'],
  [/^\s*[-*]\s/, 'markdown bullet — use • so it survives the paste'],
];

let problems = 0;

for (const path of process.argv.slice(2)) {
  const lines = readFileSync(path, 'utf8').split('\n');
  let inNote = false;
  let pasteLines = 0;

  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('<!-- NOTE')) {
      inNote = true;
      continue;
    }
    if (inNote) {
      if (line.trim() === '-->') inNote = false;
      continue;
    }
    if (line.startsWith('#')) {
      if (/^assets\b/i.test(line.replace(/^#+\s*/, ''))) break;
      continue;
    }
    if (!line.trim()) continue;

    pasteLines++;
    for (const [pattern, what] of BAD) {
      if (pattern.test(line)) {
        console.log(`${path}:${i + 1}: ${what}\n    ${line.slice(0, 100)}`);
        problems++;
      }
    }
  }
  console.log(`${path}: ${pasteLines} paste lines checked`);
}

if (problems) {
  console.error(`\n${problems} problem(s). These files are pasted into a dashboard, not rendered.`);
  process.exit(1);
}
console.log('store listings are paste-clean');
