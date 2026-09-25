export const STEPS_PER_MEASURE = 16; // sixteenth-note grid
export const MAX_FRET = 24;
export const MIN_TEMPO = 30;
export const MAX_TEMPO = 300;

/** `string` 0 is the top line (high e), 5 is the bottom line (low E). `pos` is the step index across the whole tab. */
export type Note = { id: number; string: number; pos: number; fret: number };

export type TabData = { title: string; tempo: number; measures: number; notes: Note[] };

type Snapshot = { notes: Note[]; measures: number };

const HISTORY_LIMIT = 200;

// Top to bottom as the tab is drawn.
const TUNING = [
  { name: 'e', midi: 64 },
  { name: 'B', midi: 59 },
  { name: 'G', midi: 55 },
  { name: 'D', midi: 50 },
  { name: 'A', midi: 45 },
  { name: 'E', midi: 40 },
] as const;

const cellKey = (string: number, pos: number) => `${string}:${pos}`;
const clampFret = (fret: number) => Math.max(0, Math.min(MAX_FRET, Math.round(fret)));
export const clampTempo = (tempo: number) => Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, tempo));

export const blankTab = (): TabData => ({ title: 'Untitled', tempo: 100, measures: 4, notes: [] });

/** Validate untrusted JSON (e.g. an opened file) into TabData, dropping bad notes. Null if it isn't a tab at all. */
export function parseTabData(value: unknown): TabData | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.notes)) return null;

  const isInt = (x: unknown): x is number => Number.isInteger(x);
  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const raw of v.notes as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const { string, pos, fret } = raw as Record<string, unknown>;
    if (!isInt(string) || !isInt(pos) || !isInt(fret)) continue;
    if (string < 0 || string >= TUNING.length || pos < 0) continue;
    const key = cellKey(string, pos);
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ id: notes.length + 1, string, pos, fret: clampFret(fret) });
  }

  const lastPos = Math.max(-1, ...notes.map((n) => n.pos));
  const measures = Math.max(
    isInt(v.measures) && v.measures >= 1 ? v.measures : 1,
    Math.ceil((lastPos + 1) / STEPS_PER_MEASURE),
  );
  const tempo = typeof v.tempo === 'number' && Number.isFinite(v.tempo) ? clampTempo(v.tempo) : 100;
  const title = typeof v.title === 'string' && v.title.trim() ? v.title : 'Untitled';
  return { title, tempo, measures, notes };
}

export class Tab {
  title = $state('Untitled');
  measures = $state(4);
  notes = $state<Note[]>([]);
  generation = $state(0);

  readonly tuning = TUNING;

  #tempo = $state(100);
  #past = $state<Snapshot[]>([]);
  #future = $state<Snapshot[]>([]);
  #nextId = 1;
  #byCell = $derived(new Map(this.notes.map((n) => [cellKey(n.string, n.pos), n])));

  // A cleared number input binds null.
  get tempo() {
    return this.#tempo;
  }

  set tempo(v: number) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) this.#tempo = v;
  }

  get steps() {
    return this.measures * STEPS_PER_MEASURE;
  }

  get canUndo() {
    return this.#past.length > 0;
  }

  get canRedo() {
    return this.#future.length > 0;
  }

  at(string: number, pos: number): Note | undefined {
    return this.#byCell.get(cellKey(string, pos));
  }

  get(id: number): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  inBounds(string: number, pos: number) {
    return string >= 0 && string < this.tuning.length && pos >= 0 && pos < this.steps;
  }

  /** Returns the new note's id, or null if the cell is taken. */
  add(string: number, pos: number, fret: number): number | null {
    if (!this.inBounds(string, pos) || this.at(string, pos)) return null;
    this.#commit();
    const id = this.#nextId++;
    this.notes.push({ id, string, pos, fret: clampFret(fret) });
    return id;
  }

  move(id: number, string: number, pos: number): boolean {
    const note = this.get(id);
    if (!note || !this.inBounds(string, pos)) return false;
    if (note.string === string && note.pos === pos) return false;
    if (this.at(string, pos)) return false;
    this.#commit();
    note.string = string;
    note.pos = pos;
    return true;
  }

  /** Pass `record: false` to fold this change into the previous undo step (e.g. typing a second digit). */
  setFret(id: number, fret: number, record = true) {
    const note = this.get(id);
    if (!note) return;
    const next = clampFret(fret);
    if (note.fret === next) return;
    if (record) this.#commit();
    note.fret = next;
  }

  remove(id: number) {
    if (!this.get(id)) return;
    this.#commit();
    this.notes = this.notes.filter((n) => n.id !== id);
  }

  addMeasure() {
    this.#commit();
    this.measures++;
  }

  removeMeasure() {
    if (this.measures <= 1) return;
    this.#commit();
    this.measures--;
    this.notes = this.notes.filter((n) => n.pos < this.steps);
  }

  clear() {
    if (this.notes.length === 0) return;
    this.#commit();
    this.notes = [];
  }

  undo() {
    const prev = this.#past.pop();
    if (!prev) return;
    this.#future.push(this.#snapshot());
    this.#restore(prev);
  }

  redo() {
    const next = this.#future.pop();
    if (!next) return;
    this.#past.push(this.#snapshot());
    this.#restore(next);
  }

  toJSON(): TabData {
    return {
      title: this.title,
      tempo: this.tempo,
      measures: this.measures,
      notes: $state.snapshot(this.notes),
    };
  }

  load(data: TabData) {
    this.title = data.title;
    this.tempo = data.tempo;
    this.measures = Math.max(1, data.measures);
    // Clone so the tab never shares state with whatever it was loaded from.
    this.notes = $state.snapshot(data.notes);
    this.#nextId = Math.max(0, ...data.notes.map((n) => n.id)) + 1;
    this.#past = [];
    this.#future = [];
    this.generation++;
  }

  #snapshot(): Snapshot {
    return { notes: $state.snapshot(this.notes), measures: this.measures };
  }

  #restore(s: Snapshot) {
    this.notes = s.notes;
    this.measures = s.measures;
  }

  #commit() {
    this.#past.push(this.#snapshot());
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
  }
}
