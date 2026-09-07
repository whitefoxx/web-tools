import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import webcliManifest from './manifest.webcli.json';
import localmdManifest from './manifest.localmd.json';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';

// web-tools — the OPEN base repo (P4). Builds the two agent-free shells:
//   • WebCLI            (manifest.webcli.json  → dist-webcli/)
//   • localmd Connect   (manifest.localmd.json → dist-localmd/)
// No FULL extension here (that stays in web-agent, which depends on this repo)
// and no adapter-eval sandbox/offscreen/runner — the lean shells don't eval
// adapter source. Ships only localmd's relay + in-page highlighter.

/** Bundle one TS entry to a self-contained IIFE at the bundle root (content
 * scripts / registered scripts load a plain `files:` script, not a module). */
function contentScriptPlugin(name: string, outDir: string, entry: string, out: string): Plugin {
  return {
    name,
    apply: 'build',
    async writeBundle() {
      const r = await esbuild({
        entryPoints: [resolve(__dirname, entry)],
        bundle: true,
        format: 'iife',
        target: 'esnext',
        write: false,
        legalComments: 'none',
      });
      await writeFile(resolve(__dirname, outDir, out), r.outputFiles[0].text, 'utf8');
    },
  };
}

const relayScriptPlugin = (outDir: string, entry: string): Plugin =>
  contentScriptPlugin('web-relay-script', outDir, entry, 'web-relay.js');

const pageToolsPlugin = (outDir: string): Plugin =>
  contentScriptPlugin('localmd-page-tools', outDir, 'src/localmd-connect/page-tools.ts', 'page-tools.js');

const WEBCLI_DEV_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvN+ExPtR3C9n3oqRZKGffHQW9++ycNhUnSxhU05VLOCXgbCkbl9Nrvq1fsCK4agN9ykkSDJGh6TyFi0PEfJcYrA+g4aRcaXwO3RrJqlva+4m1bIJiL2BPAIl2WqjtZ7wmQY9oF0F7Wk1ExOrSDzd/WzjWBzgRbVT55jALR8cYl+0XA9pwoI/ElO3ElRipUxnlLcRyCifYzWP9qh1Bao3ys7fKfOqnKIYBNAUhqTdf++/fcbNzvpUN2OE+fpah7OKGw+q5ljyI2+YGcyah68N1u96sPsi2ZkZNbJSUTZJe/sxpc25pdZvRp9mcmmM2M+Xxnf7pC+t9UNYJbgoA00bHQIDAQAB';
const LOCALMD_DEV_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqWVj89fmPRCTuaQ2fxf4fY6sBqV6GPuC0GDx/RejE+X9e72q/HYJBpSM4zGvpBLv4FlgtoOSqh5FolNMeVhMVeg8rnQOv45R1fMv/FD5f4jyXVRj2IXcVLC88QtFUFGjFDMlffqlb75Ycm1oTLd2fs32oRZY/3SRwOAPAPkFmTEeuqoBT6ikkc0g7VWBmjbgncbX+GKUkRBzmB5lC015wGRaKnhNq+uFH5zRR/Cb6cQD9/J3KMN0tuKWhK4scncWO3g5HVVlAY3d5SsXMZU+IU5qzXkQysa7yyOKEAGrc6Aqcc7TDGb2gPDItoZc7Qj6Xg33d0Qsc42Z8yapNzBNqQIDAQAB';

// Four targets:
//   vite build --mode webcli      → dist-webcli/
//   vite build --mode webcli-dev  → dist-webcli-dev/  (dev id + name + port 9377)
//   vite build --mode localmd     → dist-localmd/
//   vite build --mode localmd-dev → dist-localmd-dev/ (+ WS daemon behind __LOCALMD_DEV__)
export default defineConfig(({ mode }) => {
  const webcliDev = mode === 'webcli-dev';
  const webcli = mode === 'webcli' || webcliDev;
  const localmdDev = mode === 'localmd-dev';
  const localmd = mode === 'localmd' || localmdDev;
  if (!webcli && !localmd) {
    throw new Error(`web-tools builds only the lean shells; use --mode webcli|webcli-dev|localmd|localmd-dev (got "${mode}")`);
  }
  const manifest = localmdDev
    ? {
        ...localmdManifest,
        name: localmdManifest.name.replace(/^localmd Connect/, 'localmd Connect (dev)'),
        key: LOCALMD_DEV_KEY,
        permissions: [...localmdManifest.permissions, 'alarms'],
      }
    : localmd
      ? localmdManifest
      : webcliDev
        ? { ...webcliManifest, name: webcliManifest.name.replace(/^WebCLI/, 'WebCLI (dev)'), key: WEBCLI_DEV_KEY }
        : webcliManifest;
  const outDir = localmdDev
    ? 'dist-localmd-dev'
    : localmd
      ? 'dist-localmd'
      : webcliDev
        ? 'dist-webcli-dev'
        : 'dist-webcli';
  return {
    plugins: [
      preact(),
      // @ts-expect-error -- crxjs manifest typing is looser than our JSON
      crx({ manifest }),
      // WebCLI ships no extra artifacts; localmd ships its relay + highlighter.
      ...(localmd
        ? [relayScriptPlugin(outDir, 'src/localmd-connect/web-relay.ts'), pageToolsPlugin(outDir)]
        : []),
    ],
    define: {
      __WEBCLI_DEV__: JSON.stringify(webcliDev),
      __LOCALMD_DEV__: JSON.stringify(localmdDev),
    },
    build: { target: 'esnext', minify: false, outDir },
    server: { port: 5173, strictPort: true },
  };
});
