import { parseTabData, type TabData } from './tab.svelte';

// File System Access API (Chromium). Not in TS's DOM lib yet, so typed minimally here.
type PickerOptions = {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
};
type PickerWindow = Window & {
  showSaveFilePicker?: (opts: PickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (opts: PickerOptions) => Promise<FileSystemFileHandle[]>;
};

const picker = window as PickerWindow;
const TYPES = [{ description: 'Guitar tab', accept: { 'application/json': ['.json'] } }];

/** True when saves can write back to the same file; otherwise every save is a fresh download. */
export const canWriteFiles = typeof picker.showSaveFilePicker === 'function';

export type SavedFile = { name: string; handle: FileSystemFileHandle | null };
export type OpenedFile = SavedFile & { data: TabData };

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export function fileNameFor(title: string) {
  const slug = title.trim().replace(/[^\p{L}\p{N}_\- ]+/gu, '').replace(/\s+/g, '-');
  return `${slug || 'untitled'}.tab.json`;
}

/**
 * Write the tab to `handle`, or ask where to save when there's no handle (or `saveAs`).
 * Returns null if the user cancelled the picker.
 */
export async function saveTabFile(
  data: TabData,
  opts: { handle: FileSystemFileHandle | null; name: string; saveAs?: boolean },
): Promise<SavedFile | null> {
  const json = JSON.stringify(data, null, 2) + '\n';

  if (!picker.showSaveFilePicker) {
    download(json, opts.name);
    return { name: opts.name, handle: null };
  }

  try {
    const handle =
      opts.handle && !opts.saveAs
        ? opts.handle
        : await picker.showSaveFilePicker({ suggestedName: opts.name, types: TYPES });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return { name: handle.name, handle };
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Ask for a tab file and parse it. Returns null if cancelled; throws if the file isn't a valid tab. */
export async function openTabFile(): Promise<OpenedFile | null> {
  let file: File;
  let handle: FileSystemFileHandle | null = null;

  if (picker.showOpenFilePicker) {
    try {
      [handle] = await picker.showOpenFilePicker({ types: TYPES });
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
    file = await handle.getFile();
  } else {
    const picked = await pickWithInput();
    if (!picked) return null;
    file = picked;
  }

  let data: TabData | null = null;
  try {
    data = parseTabData(JSON.parse(await file.text()));
  } catch {
    // not JSON — reported below
  }
  if (!data) throw new Error(`"${file.name}" isn't a tab file this editor can read.`);
  return { name: file.name, handle, data };
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
