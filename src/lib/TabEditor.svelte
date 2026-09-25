<script lang="ts">
  import { STEPS_PER_MEASURE, MAX_FRET, type Tab } from './tab.svelte';
  import type { Player } from './player.svelte';

  let { tab, player }: { tab: Tab; player: Player } = $props();

  const CELL_W = 24;
  const LABEL_W = 28;
  const MEASURE_W = CELL_W * STEPS_PER_MEASURE;
  const DRAG_THRESHOLD = 4;
  const DIGIT_WINDOW_MS = 800;

  type Drag = {
    id: number;
    fret: number;
    startX: number;
    startY: number;
    moved: boolean;
    copy: boolean;
    string: number;
    pos: number;
  };

  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const steps = range(STEPS_PER_MEASURE);

  let width = $state(0);
  let selectedId = $state<number | null>(null);
  let brushFret = $state(0); // fret used when clicking an empty cell
  let drag = $state<Drag | null>(null);
  let suppressClick = false;
  let digitEntry = { id: -1, value: 0, at: 0 };

  const selected = $derived(selectedId === null ? undefined : tab.get(selectedId));

  const perRow = $derived(Math.max(1, Math.floor((width - LABEL_W) / MEASURE_W)));
  const rows = $derived.by(() => {
    const out: number[][] = [];
    for (let m = 0; m < tab.measures; m += perRow) {
      out.push(range(Math.min(perRow, tab.measures - m)).map((i) => m + i));
    }
    return out;
  });

  const dropValid = $derived.by(() => {
    if (!drag?.moved) return false;
    const occupant = tab.at(drag.string, drag.pos);
    return drag.copy ? !occupant : !occupant || occupant.id === drag.id;
  });

  function cellFrom(target: EventTarget | null) {
    const el = (target as Element | null)?.closest<HTMLElement>('[data-cell]');
    if (!el) return null;
    return { string: Number(el.dataset.string), pos: Number(el.dataset.pos) };
  }

  function noteIdFrom(target: EventTarget | null) {
    const el = (target as Element | null)?.closest<HTMLElement>('[data-note]');
    return el ? Number(el.dataset.note) : null;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const id = noteIdFrom(e.target);
    if (id === null) return;
    const note = tab.get(id);
    if (!note) return;
    e.preventDefault();
    selectedId = id;
    player.pluck(note.string, note.fret);
    drag = {
      id,
      fret: note.fret,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      copy: e.altKey,
      string: note.string,
      pos: note.pos,
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.copy = e.altKey;
    // Keep the last valid cell when the pointer leaves the grid.
    const cell = cellFrom(document.elementFromPoint(e.clientX, e.clientY));
    if (cell && (cell.string !== drag.string || cell.pos !== drag.pos)) {
      drag.string = cell.string;
      drag.pos = cell.pos;
      player.pluck(cell.string, drag.fret);
    }
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false));
      if (dropValid) {
        if (drag.copy) {
          selectedId = tab.add(drag.string, drag.pos, drag.fret) ?? selectedId;
        } else {
          tab.move(drag.id, drag.string, drag.pos);
        }
      }
    }
    drag = null;
  }

  function onClick(e: MouseEvent) {
    if (suppressClick) return;
    const cell = cellFrom(e.target);
    if (!cell) {
      selectedId = null;
      return;
    }
    const existing = tab.at(cell.string, cell.pos);
    if (existing) {
      selectedId = existing.id;
    } else {
      selectedId = tab.add(cell.string, cell.pos, brushFret);
      player.pluck(cell.string, brushFret);
    }
  }

  function onContextMenu(e: MouseEvent) {
    const id = noteIdFrom(e.target);
    if (id === null) return;
    e.preventDefault();
    tab.remove(id);
    if (selectedId === id) selectedId = null;
  }

  function typeDigit(id: number, digit: number) {
    const now = performance.now();
    const continuing = digitEntry.id === id && now - digitEntry.at < DIGIT_WINDOW_MS;
    const combined = digitEntry.value * 10 + digit;
    const value = continuing && combined <= MAX_FRET ? combined : digit;
    tab.setFret(id, value, !(continuing && combined <= MAX_FRET));
    digitEntry = { id, value, at: now };
    brushFret = value;
    const note = tab.get(id);
    if (note) player.pluck(note.string, note.fret);
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.target as Element).closest('input, textarea, select, [contenteditable]')) return;

    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && (key === 'z' || key === 'y')) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) tab.redo();
      else tab.undo();
      return;
    }

    if (e.key === ' ' && !mod) {
      e.preventDefault();
      // Shift+Space plays from the selected note's measure.
      const from = e.shiftKey && selected ? selected.pos - (selected.pos % STEPS_PER_MEASURE) : 0;
      player.toggle(from);
      return;
    }

    if (e.key === 'Escape') {
      if (drag) drag = null;
      else selectedId = null;
      return;
    }

    const note = selected;
    if (!note || mod) return;

    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      typeDigit(note.id, Number(e.key));
      return;
    }

    switch (e.key) {
      case 'Backspace':
      case 'Delete':
        tab.remove(note.id);
        selectedId = null;
        break;
      case 'ArrowLeft':
        tab.move(note.id, note.string, note.pos - 1);
        break;
      case 'ArrowRight':
        tab.move(note.id, note.string, note.pos + 1);
        break;
      case 'ArrowUp':
        if (e.shiftKey) tab.setFret(note.id, note.fret + 1);
        else tab.move(note.id, note.string - 1, note.pos);
        break;
      case 'ArrowDown':
        if (e.shiftKey) tab.setFret(note.id, note.fret - 1);
        else tab.move(note.id, note.string + 1, note.pos);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (selected) {
      brushFret = selected.fret;
      player.pluck(selected.string, selected.fret);
    }
  }
</script>

<svelte:window
  onkeydown={onKeyDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={() => (drag = null)}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="editor"
  class:dragging={drag?.moved}
  class:copying={drag?.moved && drag.copy}
  style:--cell-w="{CELL_W}px"
  style:--label-w="{LABEL_W}px"
  bind:clientWidth={width}
  onpointerdown={onPointerDown}
  onclick={onClick}
  oncontextmenu={onContextMenu}
>
  {#each rows as row, r (r)}
    <div class="system">
      <div class="labels">
        {#each tab.tuning as t}
          <span>{t.name}</span>
        {/each}
      </div>

      {#each row as m (m)}
        <div class="measure">
          <span class="measure-number">{m + 1}</span>
          <div class="strings">
            {#each tab.tuning as _, s}
              <div class="string">
                {#each steps as step}
                  {@const pos = m * STEPS_PER_MEASURE + step}
                  {@const note = tab.at(s, pos)}
                  <div
                    class="cell"
                    class:shade={Math.floor(step / 4) % 2 === 1}
                    class:empty={!note}
                    class:playhead={player.step === pos}
                    data-cell
                    data-string={s}
                    data-pos={pos}
                    data-ghost={brushFret}
                  >
                    {#if note}
                      <button
                        type="button"
                        class="note"
                        class:selected={note.id === selectedId}
                        class:sounding={player.step === pos}
                        class:lifted={drag?.moved && !drag.copy && drag.id === note.id}
                        data-note={note.id}
                        tabindex="-1"
                      >
                        {note.fret}
                      </button>
                    {/if}
                    {#if drag?.moved && drag.string === s && drag.pos === pos}
                      <span class="note ghost" class:invalid={!dropValid}>{drag.fret}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/each}
</div>

<p class="status">
  {#if selected}
    <span>{tab.tuning[selected.string].name} string · measure {Math.floor(selected.pos / STEPS_PER_MEASURE) + 1}, step {(selected.pos % STEPS_PER_MEASURE) + 1} · fret {selected.fret}</span>
  {:else}
    <span>Nothing selected</span>
  {/if}
  <span class="muted">Click places fret {brushFret}</span>
</p>

<style>
  .editor {
    user-select: none;
    padding: 8px 0 16px;
  }

  .editor.dragging,
  .editor.dragging .note,
  .editor.dragging .cell {
    cursor: grabbing;
  }

  .editor.copying,
  .editor.copying .note,
  .editor.copying .cell {
    cursor: copy;
  }

  .system {
    display: flex;
    margin-bottom: 20px;
  }

  .labels {
    display: flex;
    flex-direction: column;
    width: var(--label-w);
    padding-top: 18px;
    flex-shrink: 0;
  }

  .labels span {
    height: var(--row-h);
    display: flex;
    align-items: center;
    font: 600 12px/1 var(--font-mono);
    color: var(--muted);
  }

  .measure {
    display: flex;
    flex-direction: column;
  }

  .measure-number {
    height: 18px;
    font-size: 11px;
    color: var(--muted);
    padding-left: 4px;
  }

  .strings {
    border-left: 2px solid var(--bar);
    border-right: 2px solid var(--bar);
  }

  .measure + .measure .strings {
    border-left: none;
  }

  .string {
    display: flex;
  }

  .cell {
    position: relative;
    width: var(--cell-w);
    height: var(--row-h);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .cell.shade {
    background: var(--shade);
  }

  .cell.playhead {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .cell::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: var(--line);
  }

  .cell.empty:hover::after {
    content: attr(data-ghost);
    position: relative;
    font: 500 13px/1 var(--font-mono);
    color: var(--accent);
    opacity: 0.45;
  }

  .editor.dragging .cell.empty:hover::after {
    content: none;
  }

  .note {
    position: relative;
    z-index: 1;
    min-width: 18px;
    height: 18px;
    padding: 0 3px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    font: 600 13px/16px var(--font-mono);
    text-align: center;
    cursor: grab;
    touch-action: none;
    transition: background-color 80ms, opacity 80ms;
  }

  .note:hover {
    border-color: var(--accent);
  }

  .note.selected {
    background: var(--accent);
    color: var(--accent-fg);
  }

  .note.sounding:not(.selected) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .note.lifted {
    opacity: 0.25;
  }

  .note.ghost {
    position: absolute;
    z-index: 2;
    pointer-events: none;
    border: 1px dashed var(--accent);
    background: var(--bg);
    color: var(--accent);
  }

  .note.ghost.invalid {
    border-color: var(--danger);
    color: var(--danger);
  }

  .status {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin: 0;
    font-size: 13px;
  }

  .muted {
    color: var(--muted);
  }
</style>
