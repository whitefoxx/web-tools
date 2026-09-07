import { cli } from '../../runtime/registry.js';
import { loadKbFolders, parseFolderList, saveKbFolders } from '../../localmd-connect/kb-folders';

/**
 * localmd Connect only — the mirror of which knowledge base is open.
 *
 * One tool, and it only ever goes one way: localmd tells the extension. The
 * extension cannot open a folder (the directory handle belongs to the page that
 * was granted it), so it does not get to decide which one is current; when the
 * user picks another in the popup it broadcasts
 * `notifications/localmd/open-kb {name}` and waits to be told what happened.
 */
cli({
  site: 'generic',
  name: 'sync_kb_folders',
  access: 'write',
  local: true,
  description:
    'Tell the extension which knowledge base folders exist and which one is open, so its popup can name the folder a capture will go to and offer the others. `folders` = JSON array of folder names, most recently opened first; `current` = the open one (omit or pass an empty string for none). Call it on connect and whenever the open folder or the recents list changes. The extension NEVER changes this on its own — when the user picks another folder in the popup it sends the `notifications/localmd/open-kb {name}` notification and waits for your next sync to say what actually happened.',
  args: [
    { name: 'folders', type: 'string', required: true, help: 'JSON array of folder names' },
    { name: 'current', type: 'string', help: 'The folder that is open right now' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const folders = parseFolderList(kwargs.folders);
    const current = typeof kwargs.current === 'string' ? kwargs.current : null;
    const saved = await saveKbFolders(folders, current);
    return { folders: saved.folders.length, current: saved.current };
  },
});

cli({
  site: 'generic',
  name: 'get_kb_folders',
  access: 'read',
  local: true,
  description:
    'What the extension currently believes about the knowledge base: `{folders, current, at}` as last set by sync_kb_folders. Mostly useful to check whether a sync landed — localmd is the source of truth for this, not the browser.',
  args: [],
  func: async () => loadKbFolders(),
});
