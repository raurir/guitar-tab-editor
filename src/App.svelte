<script lang="ts">
  import { Tab, blankTab, MIN_TEMPO, MAX_TEMPO, type TabData } from './lib/tab.svelte';
  import TabEditor from './lib/TabEditor.svelte';
  import { Player } from './lib/player.svelte';
  import { canWriteFiles, fileNameFor, openTabFile, saveTabFile } from './lib/files';

  const PREFS_KEY = 'guitar-tab-editor:prefs';

  type Prefs = { volume: number; metal: boolean };
  type FileState = { name: string | null; saved: string };

  const tab = new Tab();
  tab.load(blankTab());
  const player = new Player(tab);
  const prefs = loadPrefs();
  player.volume = prefs.volume;
  player.metal = prefs.metal;

  const BLANK = contentKey(blankTab());
  let file = $state<FileState>({ name: null, saved: BLANK });
  let fileHandle: FileSystemFileHandle | null = null;

  const content = $derived(contentKey(tab.toJSON()));
  const dirty = $derived(file.saved !== content);

  /** Note ids are renumbered on load, so compare what the tab sounds like, not ids. */
  function contentKey(d: TabData) {
    return JSON.stringify([d.title, d.tempo, d.measures, d.notes.map((n) => [n.string, n.pos, n.fret])]);
  }

  function loadPrefs(): Prefs {
    const defaults: Prefs = { volume: 0.8, metal: false };
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
      return {
        volume: typeof p?.volume === 'number' && Number.isFinite(p.volume) ? p.volume : defaults.volume,
        metal: typeof p?.metal === 'boolean' ? p.metal : defaults.metal,
      };
    } catch {
      return defaults;
    }
  }

  $effect(() => {
    const data = JSON.stringify({ volume: player.volume, metal: player.metal } satisfies Prefs);
    try {
      localStorage.setItem(PREFS_KEY, data);
    } catch {
      // storage unavailable — prefs just won't be remembered
    }
  });

  function confirmDiscard() {
    return !dirty || confirm('You have unsaved changes. Discard them?');
  }

  function newSong() {
    if (!confirmDiscard()) return;
    player.stop();
    tab.load(blankTab());
    file = { name: null, saved: BLANK };
    fileHandle = null;
  }

  async function save(saveAs = false) {
    // Capture now: the user can keep editing while the save dialog is open.
    const data = tab.toJSON();
    try {
      const result = await saveTabFile(data, {
        handle: fileHandle,
        name: file.name ?? fileNameFor(data.title),
        saveAs,
      });
      if (!result) return;
      fileHandle = result.handle;
      file = { name: result.name, saved: contentKey(data) };
    } catch (e) {
      alert(`Couldn't save: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function open() {
    try {
      // Pick first, confirm after: browsers only allow the picker straight after a click.
      const opened = await openTabFile();
      if (!opened || !confirmDiscard()) return;
      player.stop();
      tab.load(opened.data);
      fileHandle = opened.handle;
      file = { name: opened.name, saved: contentKey(opened.data) };
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // A held ⌘S would fire a second save while the first picker is still open.
    if (!(e.metaKey || e.ctrlKey) || e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      save(e.shiftKey);
    } else if (key === 'o') {
      e.preventDefault();
      open();
    }
  }

  // Nothing is autosaved any more, so warn before closing or reloading with unsaved work.
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (dirty) e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeyDown} onbeforeunload={onBeforeUnload} />

<main>
  <header class="toolbar">
    <input class="title" bind:value={tab.title} aria-label="Title" />

    <div class="group">
      <button type="button" onclick={newSong}>New</button>
      <button type="button" onclick={open} title="Open (⌘O)">Open…</button>
      <button type="button" class="save" class:dirty onclick={() => save()}
        title={canWriteFiles ? 'Save (⌘S)' : 'Download a copy (⌘S)'}>Save</button>
      {#if canWriteFiles}
        <button type="button" onclick={() => save(true)} title="Save As (⌘⇧S)">Save As…</button>
      {/if}
      {#if file.name}
        <span class="file-name" title={file.name}>{file.name}</span>
      {/if}
    </div>

    <div class="group">
      <button type="button" class="play" class:active={player.playing} onclick={() => player.toggle()}>
        {player.playing ? '■ Stop' : '▶ Play'}
      </button>
      <button type="button" class:active={player.loop} aria-pressed={player.loop} onclick={() => (player.loop = !player.loop)}>
        Loop
      </button>
      <button
        type="button"
        class="metal"
        class:active={player.metal}
        aria-pressed={player.metal}
        onclick={() => (player.metal = !player.metal)}
      >
        🤘 Metal
      </button>
    </div>

    <div class="group">
      <label class="field">
        <span>Vol</span>
        <input
          type="range"
          class="volume"
          min="0"
          max="1"
          step="0.01"
          bind:value={player.volume}
          aria-label="Volume"
        />
        <span class="count">{Math.round(player.volume * 100)}</span>
      </label>
    </div>

    <div class="group">
      <label class="field">
        <span>BPM</span>
        <input type="number" min={MIN_TEMPO} max={MAX_TEMPO} bind:value={tab.tempo} />
      </label>
    </div>

    <div class="group">
      <span class="field-label">Measures</span>
      <button type="button" onclick={() => tab.removeMeasure()} disabled={tab.measures <= 1} aria-label="Remove measure">−</button>
      <span class="count">{tab.measures}</span>
      <button type="button" onclick={() => tab.addMeasure()} aria-label="Add measure">+</button>
    </div>

    <div class="group">
      <button type="button" onclick={() => tab.undo()} disabled={!tab.canUndo}>Undo</button>
      <button type="button" onclick={() => tab.redo()} disabled={!tab.canRedo}>Redo</button>
      <button type="button" onclick={() => tab.clear()} disabled={tab.notes.length === 0}>Clear</button>
    </div>
  </header>

  <TabEditor {tab} {player} />

  <footer class="help">
    <span><kbd>Space</kbd> play / stop</span>
    <span><kbd>Shift</kbd>+<kbd>Space</kbd> play from selection</span>
    <span><kbd>Click</kbd> add note</span>
    <span><kbd>Drag</kbd> move</span>
    <span><kbd>Alt</kbd>+<kbd>Drag</kbd> copy</span>
    <span><kbd>0–9</kbd> set fret</span>
    <span><kbd>←↑↓→</kbd> nudge</span>
    <span><kbd>Shift</kbd>+<kbd>↑↓</kbd> fret ±1</span>
    <span><kbd>Del</kbd> / right-click remove</span>
    <span><kbd>⌘Z</kbd> undo</span>
    <span><kbd>⌘S</kbd> save</span>
    <span><kbd>⌘O</kbd> open</span>
  </footer>
</main>

<style>
  main {
    max-width: 1600px;
    margin: 0 auto;
    padding: 24px 16px;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 24px;
    padding-bottom: 16px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }

  .title {
    flex: 1 1 240px;
    font-size: 22px;
    font-weight: 600;
    border: 1px solid transparent;
    background: transparent;
    padding: 4px 6px;
    margin-left: -6px;
  }

  .title:hover,
  .title:focus {
    border-color: var(--line);
  }

  .group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .field span,
  .field-label {
    font-size: 12px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .field input {
    width: 64px;
  }

  .field input.volume {
    width: 110px;
    padding: 0;
    border: none;
    accent-color: var(--accent);
  }

  .field .count {
    min-width: 3ch;
    text-transform: none;
    letter-spacing: 0;
  }

  .play {
    min-width: 76px;
  }

  .save {
    min-width: 64px;
  }

  .file-name {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--muted);
  }

  .save.dirty::after {
    content: ' •';
    color: var(--accent);
  }

  button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }

  button.metal.active {
    background: #b3121b;
    border-color: #ff3b3b;
    color: #fff;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    box-shadow: 0 0 12px rgb(255 40 40 / 0.45);
  }

  .count {
    min-width: 2ch;
    text-align: center;
    font-family: var(--font-mono);
  }

  .help {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
    margin-top: 24px;
    font-size: 12px;
    color: var(--muted);
  }

  kbd {
    font: 11px var(--font-mono);
    padding: 1px 5px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--shade);
    color: var(--fg);
  }
</style>
