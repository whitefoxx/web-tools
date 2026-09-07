import { cli } from '../../runtime/registry.js';

/**
 * Dev-build-only: reload this extension from the daemon, so a freshly built
 * `dist-localmd-dev/` takes effect without a trip to chrome://extensions.
 * `__LOCALMD_DEV__` is a build-time literal, so the shipping build contains
 * none of this, and the unit tests (which define it false) never see the tool.
 */
if (__LOCALMD_DEV__) {
  cli({
    site: 'generic',
    name: 'dev_reload_extension',
    access: 'read',
    description:
      '[dev build only] Reload this extension so a freshly built dist-localmd-dev takes effect. The daemon connection drops and redials within a few seconds; adapters loaded this session and armed network captures are gone afterwards.',
    args: [],
    func: async () => {
      setTimeout(() => chrome.runtime.reload(), 300);
      return { ok: true, reloading: true, note: 'poll /status until the daemon reports connected again' };
    },
  });
}
