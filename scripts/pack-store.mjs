// Package a built shell into a Chrome Web Store upload zip.
//
//   node scripts/pack-store.mjs webcli      → /tmp/webcli-<version>.zip
//   node scripts/pack-store.mjs localmd     → /tmp/localmd-connect-<version>.zip
//
// Exists because zipping `dist-*/` directly produces a package the dashboard
// REJECTS: "key field is not allowed in manifest." Our manifests carry `key` on
// purpose — it pins the id of an UNPACKED load, which is what makes a dev build
// addressable and reproducible — but the store assigns identity from the CRX
// signature and refuses a manifest that tries to declare one.
//
// So the strip happens here, on a staged COPY, never in `dist-*/` itself: the
// build output has to stay loadable unpacked at its stable id, and a step that
// mutates it would silently take that away. Doing it in a script rather than in
// the release checklist is the point — this bit a release more than once while
// it was a line of prose someone had to remember.
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Shell name → its build output and the zip's base name. */
const SHELLS = {
  webcli: { dist: 'dist-webcli', base: 'webcli' },
  localmd: { dist: 'dist-localmd', base: 'localmd-connect' },
};

const which = process.argv[2];
const shell = SHELLS[which];
if (!shell) {
  console.error(`usage: node scripts/pack-store.mjs <${Object.keys(SHELLS).join('|')}>`);
  process.exit(1);
}

const distDir = join(ROOT, shell.dist);
if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error(`${shell.dist}/manifest.json not found — build it first.`);
  process.exit(1);
}

// Stage a copy so the strip can never touch the loadable build output.
const stage = mkdtempSync(join(tmpdir(), `pack-${shell.base}-`));
cpSync(distDir, stage, { recursive: true });

const manifestPath = join(stage, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hadKey = 'key' in manifest;
delete manifest.key;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

// Explicitly /tmp, NOT os.tmpdir(): on macOS that resolves to
// /var/folders/…/T/, so the script wrote there while every doc (and every
// instruction anyone had been given) said /tmp — leaving a stale hand-made zip
// of the SAME NAME sitting in /tmp to be uploaded by mistake. It was, and the
// store rejected it for the very `key` this script exists to strip. Same name
// in two places is the trap; one predictable place is the fix.
const zipPath = `/tmp/${shell.base}-${manifest.version}.zip`;
rmSync(zipPath, { force: true });
// Zip the CONTENTS, not the folder — the store wants manifest.json at the root.
execFileSync('zip', ['-qr', zipPath, '.', '-x', '.*', '__MACOSX/*'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });

// Verify what we actually produced rather than what we intended to.
const listed = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
const rootManifest = /\smanifest\.json$/m.test(listed);
const packedKey =
  'key' in
  JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }));

console.log(`${manifest.name} ${manifest.version}`);
console.log(`  → ${zipPath}`);
console.log(
  `  manifest.json at zip root: ${rootManifest ? 'yes' : 'NO — the store will reject this'}`,
);
console.log(
  `  key stripped: ${hadKey ? (packedKey ? 'NO — still present!' : 'yes') : 'n/a (build had none)'}`,
);
if (!rootManifest || packedKey) process.exit(1);
