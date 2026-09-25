<script lang="ts">
  import { Tab, type TabData } from './lib/tab.svelte';
  import TabEditor from './lib/TabEditor.svelte';
  import { Player } from './lib/player.svelte';

  const STORAGE_KEY = 'guitar-tab-editor:v1';
  const PREFS_KEY = 'guitar-tab-editor:prefs';

  type Prefs = { volume: number; metal: boolean };

  const DEMO: TabData = {
    title: 'Untitled',
    tempo: 100,
    measures: 4,
    notes: [
      [5, 0, 0], [5, 2, 3], [4, 4, 0], [4, 6, 2],
      [3, 8, 0], [3, 10, 2], [2, 12, 0], [2, 14, 2],
    ].map(([string, pos, fret], i) => ({ id: i + 1, string, pos, fret })),
  };

  const tab = new Tab();
  tab.load(loadSaved() ?? DEMO);
  const player = new Player(tab);
  const prefs = loadPrefs();
  player.volume = prefs.volume;
  player.metal = prefs.metal;

  function loadPrefs(): Prefs {
    const defaults: Prefs = { volume: 0.8, metal: false };
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    } catch {
      return defaults;
    }
  }

  function loadSaved(): TabData | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  $effect(() => {
    const data = JSON.stringify({ volume: player.volume, metal: player.metal } satisfies Prefs);
    try {
      localStorage.setItem(PREFS_KEY, data);
    } catch {
      // ignore
    }
  });

  $effect(() => {
    const data = JSON.stringify(tab.toJSON());
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      // storage unavailable — editing still works, it just won't persist
    }
  });
</script>

<main>
  <header class="toolbar">
    <input class="title" bind:value={tab.title} aria-label="Title" />

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
        <input type="number" min="30" max="300" bind:value={tab.tempo} />
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
