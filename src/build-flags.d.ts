/**
 * Build-time flags injected by Vite's `define` (see vite.config.ts).
 *
 * These are STATICALLY REPLACED at build time, not read at runtime — a shipped
 * bundle contains the literal value, so a `if (__WEBCLI_DEV__)` branch is dead
 * code the bundler can drop rather than a switch anyone can flip at runtime.
 *
 * Every flag declared here must be defined in BOTH vite.config.ts (for builds)
 * and vitest.config.ts (for tests) — an undeclared identifier is a ReferenceError
 * the moment a test imports a module that reads it.
 */

/** True only in the `webcli-dev` build (dev-identity WebCLI, see docs/webcli.md §13). */
declare const __WEBCLI_DEV__: boolean;

/** True only in the `localmd-dev` build. Unlike the WebCLI flag this gates a
 * CAPABILITY, not just an identity: the WS daemon bridge — the only way into
 * the extension from outside the browser — is compiled in under this flag and
 * absent from the shipping build. See docs/localmd-connect.md §12. */
declare const __LOCALMD_DEV__: boolean;
