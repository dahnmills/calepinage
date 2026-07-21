import { create } from 'zustand';
import type {
  Door, LayoutConfig, LayoutResult, Measure, Pack, Partition, Plank, Point, Room, SpaceTag,
  WallAlign,
} from '../model/types';
import { flattenPacks } from '../model/stock';
import { computeLayout } from '../model/layout';
import { detectSpaces } from '../model/spaces';
import { pointInPolygon, dedupePoints } from '../model/geometry';
import { clearProject, loadProject, saveProject, type Project } from './persist';
import { validatePlan, type Diagnostic } from '../model/validate';

export type Tool = 'draw' | 'edit' | 'view' | 'hole' | 'door' | 'wall' | 'startline' | 'measure' | 'space';

export interface EditorSettings {
  gridStep: number; // cm
  showGrid: boolean;
  snapGrid: boolean;
  snapAngle: boolean;
  angleStep: number; // deg
  /** Épaisseur de cloison courante (cm) pour le tracé. */
  wallThickness: number;
  /** Côté sur lequel porter l'épaisseur de la cloison en cours de tracé. */
  wallAlign: WallAlign;
}

let batchSeq = 1;
const uid = () => `b${batchSeq++}`;

interface State {
  tool: Tool;
  room: Room;
  /** Points en cours de tracé (repère cm), avant fermeture. */
  drawing: Point[];
  editor: EditorSettings;
  selectedVertex: number | null;
  /** Stock saisi en paquets ; le moteur reçoit les lots aplatis (`flattenPacks`). */
  packs: Pack[];
  config: LayoutConfig;
  result: LayoutResult | null;
  diagnostics: Diagnostic[];
  focusedDiagnostic: Diagnostic | null;
  /** Incrémenté à chaque appel de `focusDiagnostic`, même sur le même objet : permet à
   *  CanvasView de recentrer sur un re-clic du même diagnostic (l'identité seule ne bouge pas). */
  focusNonce: number;
  focusDiagnostic: (d: Diagnostic | null) => void;
  /** Cotes posées sur le plan (distances entre murs). */
  measures: Measure[];
  /** Premier point d'une cote en cours (le second suit le curseur). */
  measureStart: Point | null;
  startMeasure: (p: Point) => void;
  finishMeasure: (p: Point) => void;
  cancelMeasure: () => void;
  clearMeasures: () => void;
  removeMeasure: (id: string) => void;
  setPartitionAlign: (index: number, align: WallAlign) => void;
  updatePartition: (index: number, patch: Partial<Omit<Partition, 'id' | 'points'>>) => void;
  /** Nomme / exclut la pièce contenant ce point. */
  tagSpace: (point: Point, patch: Partial<Omit<SpaceTag, 'id' | 'point'>>) => void;
  removeSpaceTag: (id: string) => void;
  /** Échelle : cm par unité de dessin (les points sont déjà en cm). */
  setTool: (t: Tool) => void;
  setEditor: (patch: Partial<EditorSettings>) => void;
  selectVertex: (i: number | null) => void;
  addDrawPoint: (p: Point) => void;
  undoDrawPoint: () => void;
  closeRoom: () => void;
  closeHole: () => void;
  clearHoles: () => void;
  addDoor: (host: 'wall' | 'partition', edgeIndex: number, segIndex: number, center: number) => void;
  updateDoor: (index: number, patch: Partial<Door>) => void;
  clearDoors: () => void;
  closePartition: () => void;
  clearPartitions: () => void;
  removePartition: (index: number) => void;
  movePartitionPoint: (partIndex: number, ptIndex: number, p: Point) => void;
  moveWholePartition: (index: number, dx: number, dy: number) => void;
  setPartitionLength: (index: number, lengthCm: number) => void;
  /** Change la longueur d'UN segment : déplace son extrémité et translate la suite de la polyligne. */
  setPartitionSegmentLength: (index: number, seg: number, lengthCm: number) => void;
  removeDoor: (index: number) => void;
  clearRoom: () => void;
  setRoomPoints: (pts: Point[]) => void;
  moveVertex: (index: number, p: Point) => void;
  insertVertex: (edgeIndex: number, p: Point) => void;
  deleteVertex: (index: number) => void;
  setEdgeLength: (edgeIndex: number, lengthCm: number) => void;
  addPack: () => void;
  /** Remplace tout le stock (import d'un inventaire). */
  setPacks: (packs: Pack[]) => void;
  updatePack: (id: string, patch: Partial<Omit<Pack, 'lines' | 'id'>>) => void;
  removePack: (id: string) => void;
  duplicatePack: (id: string) => void;
  /** Ajoute `count` lames de `length` cm, numérotées à la suite des numéros libres. */
  addPlanks: (packId: string, length: number, count: number) => void;
  updatePlank: (packId: string, plankId: string, patch: Partial<Omit<Plank, 'id'>>) => void;
  removePlank: (packId: string, plankId: string) => void;
  /** Applique une largeur à TOUTES les lames du paquet (elles la partagent presque toujours). */
  setPackWidth: (packId: string, width: number) => void;
  /** Renumérote les lames du paquet de 1 à N, dans leur ordre d'affichage. */
  renumberPack: (packId: string) => void;
  setConfig: (patch: Partial<LayoutConfig>) => void;
  run: () => void;
  /** Historique du plan (murs, cloisons, portes, zones, cotes). */
  past: HistoryEntry[];
  future: HistoryEntry[];
  snapshot: () => void;
  undo: () => void;
  redo: () => void;
  newProject: () => void;
  loadInto: (p: Project) => void;
}

interface HistoryEntry {
  room: Room;
  measures: Measure[];
}

const HISTORY_MAX = 60;

const emptyRoom: Room = {
  id: 'room1',
  name: 'Pièce',
  points: [], // aucune pièce par défaut : on la dessine
  spaceTags: [],
  holes: [],
  doors: [],
  partitions: [],
};

let doorSeq = 1;
let partSeq = 1;
let measureSeq = 1;
let tagSeq = 1;

const defaultConfig: LayoutConfig = {
  patternId: 'straight',
  orientationDeg: 0,
  offsetMode: '1/2',
  jointGap: 0,
  minCutLength: 20,
  minRipWidth: 5, // Quick-Step : « first and last row at least 5 cm »
  avoidSamePlank: true,
  minJointOffset: 30,
  reuseOffcuts: true,
  cutTolerance: 1,
  mixLengths: true,
  mixPacks: true,
  preferShort: false,
  exteriorWallThickness: 20,
  expansionGap: 0.8,
  optimizeStart: true,
  startLine: null,
  startFlip: false,
  wastePurchasePct: 10,
  seed: 12345,
};

/** Un paquet neuf est vide : c'est l'utilisateur qui y met ses lames. */
function defaultPack(n = 1): Pack {
  return { id: uid(), name: `Paquet ${n}`, defaultWidth: 20, planks: [] };
}

const saved = loadProject();

export const useStore = create<State>((set, get) => ({
  tool: 'draw',
  room: saved?.room ?? emptyRoom,
  drawing: [],
  editor: { gridStep: 10, showGrid: true, snapGrid: true, snapAngle: true, angleStep: 15, wallThickness: 7, wallAlign: 'left' },
  selectedVertex: null,
  measures: saved?.measures ?? [],
  measureStart: null,
  packs: saved?.packs ?? [defaultPack()],
  config: { ...defaultConfig, ...(saved?.config ?? {}) },
  result: null,
  diagnostics: [],
  focusedDiagnostic: null,
  focusNonce: 0,
  past: [],
  future: [],

  /** Fige l'état du plan avant une modification, pour pouvoir y revenir (Cmd+Z). */
  snapshot: () => {
    const { room, measures, past } = get();
    set({
      past: [...past.slice(-HISTORY_MAX + 1), { room, measures }],
      future: [],
    });
  },
  undo: () => {
    const { past, future, room, measures } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({
      room: prev.room, measures: prev.measures,
      past: past.slice(0, -1),
      future: [{ room, measures }, ...future].slice(0, HISTORY_MAX),
      result: null, diagnostics: [], focusedDiagnostic: null, selectedVertex: null, drawing: [],
    });
  },
  redo: () => {
    const { past, future, room, measures } = get();
    const next = future[0];
    if (!next) return;
    set({
      room: next.room, measures: next.measures,
      past: [...past, { room, measures }].slice(-HISTORY_MAX),
      future: future.slice(1),
      result: null, diagnostics: [], focusedDiagnostic: null, selectedVertex: null, drawing: [],
    });
  },
  newProject: () => {
    clearProject();
    set({
      room: emptyRoom, measures: [], measureStart: null, drawing: [], result: null, diagnostics: [], focusedDiagnostic: null,
      past: [], future: [], selectedVertex: null, tool: 'draw',
      config: { ...defaultConfig },
    });
  },
  loadInto: (p) => set({
    // Un plan enregistré peut contenir des sommets doublés : on nettoie à l'ouverture.
    room: { ...p.room, points: dedupePoints(p.room.points) },
    packs: p.packs, config: { ...defaultConfig, ...p.config },
    measures: p.measures, drawing: [], result: null, diagnostics: [], focusedDiagnostic: null, past: [], future: [],
    selectedVertex: null, tool: 'edit',
  }),

  setTool: (t) =>
    set({
      tool: t,
      drawing: t === 'draw' || t === 'hole' || t === 'wall' ? [] : get().drawing,
      selectedVertex: null,
      measureStart: null,
    }),
  addDoor: (host, edgeIndex, segIndex, center) => {
    const room = get().room;
    const door: Door = {
      id: `d${doorSeq++}`, host, edgeIndex, segIndex, center,
      width: 83, hinge: 'l', swing: 1, throughFloor: false,
    };
    set({ room: { ...room, doors: [...room.doors, door] }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  updateDoor: (index, patch) =>
    set({
      room: { ...get().room, doors: get().room.doors.map((d, i) => (i === index ? { ...d, ...patch } : d)) },
      result: null, diagnostics: [], focusedDiagnostic: null,
    }),
  clearDoors: () => {
    get().snapshot();
    set({ room: { ...get().room, doors: [] }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  closePartition: () => {
    const pts = dedupePoints(get().drawing);
    if (pts.length >= 2) {
      get().snapshot();
      const room = get().room;
      const { wallThickness, wallAlign } = get().editor;
      const part: Partition = { id: `w${partSeq++}`, points: pts, thickness: wallThickness, align: wallAlign };
      // On reste sur l'outil : on enchaîne les cloisons d'un logement sans y revenir.
      set({ room: { ...room, partitions: [...room.partitions, part] }, drawing: [], result: null, diagnostics: [], focusedDiagnostic: null });
    }
  },
  setPartitionAlign: (index, align) => get().updatePartition(index, { align }),
  updatePartition: (index, patch) => {
    get().snapshot();
    set({
      room: {
        ...get().room,
        partitions: get().room.partitions.map((w, i) => (i === index ? { ...w, ...patch } : w)),
      },
      result: null, diagnostics: [], focusedDiagnostic: null,
    });
  },

  /**
   * Une étiquette de pièce est ancrée par un point : c'est le seul repère qui survive au
   * redécoupage des cloisons. Poser une étiquette là où il y en a déjà une la met à jour.
   */
  tagSpace: (point, patch) => {
    get().snapshot();
    const room = get().room;
    const spaces = detectSpaces(room, get().config.exteriorWallThickness ?? 0);
    const space = spaces.find((sp) => pointInPolygon(point, sp.outer));
    if (!space) return;
    const tags = room.spaceTags ?? [];
    const existing = tags.find((t) => pointInPolygon(t.point, space.outer));
    const next = existing
      // On réancre sur le point cliqué : il est forcément dans la pièce, contrairement à
      // un point recalculé qui peut sortir d'une pièce concave et étiqueter la voisine.
      ? tags.map((t) => (t.id === existing.id ? { ...t, point, ...patch } : t))
      : [...tags, {
        id: `s${tagSeq++}`,
        point,
        name: space.name,
        excluded: false,
        ...patch,
      }];
    set({ room: { ...room, spaceTags: next }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  removeSpaceTag: (id) => {
    get().snapshot();
    set({
      room: { ...get().room, spaceTags: (get().room.spaceTags ?? []).filter((t) => t.id !== id) },
      result: null, diagnostics: [], focusedDiagnostic: null,
    });
  },

  startMeasure: (p) => set({ measureStart: p }),
  finishMeasure: (p) => {
    const a = get().measureStart;
    if (!a) return;
    set({ measures: [...get().measures, { id: `m${measureSeq++}`, a, b: p }], measureStart: null });
  },
  cancelMeasure: () => set({ measureStart: null }),
  clearMeasures: () => {
    get().snapshot();
    set({ measures: [], measureStart: null });
  },
  removeMeasure: (id) => {
    get().snapshot();
    set({ measures: get().measures.filter((m) => m.id !== id) });
  },
  clearPartitions: () => {
    get().snapshot();
    set({ room: { ...get().room, partitions: [] }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  removePartition: (index) => {
    get().snapshot();
    set({
      room: { ...get().room, partitions: get().room.partitions.filter((_, i) => i !== index) },
      result: null, diagnostics: [], focusedDiagnostic: null,
    });
  },
  movePartitionPoint: (partIndex, ptIndex, p) => {
    const parts = get().room.partitions.map((w, i) =>
      i === partIndex ? { ...w, points: w.points.map((q, k) => (k === ptIndex ? p : q)) } : w,
    );
    set({ room: { ...get().room, partitions: parts }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  moveWholePartition: (index, dx, dy) => {
    const parts = get().room.partitions.map((w, i) =>
      i === index ? { ...w, points: w.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) } : w,
    );
    set({ room: { ...get().room, partitions: parts }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  setPartitionSegmentLength: (index, seg, lengthCm) => {
    get().snapshot();
    const parts = get().room.partitions.map((w, i) => {
      if (i !== index || seg < 0 || seg + 1 >= w.points.length) return w;
      const pts = [...w.points];
      const a = pts[seg], b = pts[seg + 1];
      const cur = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / cur, uy = (b.y - a.y) / cur;
      const nb = { x: a.x + ux * lengthCm, y: a.y + uy * lengthCm };
      // On translate l'extrémité ET toute la suite de la polyligne, pour ne changer QUE la
      // longueur de ce segment sans déformer les suivants.
      const dx = nb.x - b.x, dy = nb.y - b.y;
      for (let k = seg + 1; k < pts.length; k++) pts[k] = { x: pts[k].x + dx, y: pts[k].y + dy };
      return { ...w, points: pts };
    });
    set({ room: { ...get().room, partitions: parts }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  setPartitionLength: (index, lengthCm) => {
    get().snapshot();
    const parts = get().room.partitions.map((w, i) => {
      if (i !== index || w.points.length < 2) return w;
      // Une seule cote possible pour une cloison à deux points : on déplace l'extrémité
      // le long de sa direction. (Pour une polyligne, on n'ajuste que le dernier segment.)
      const pts = [...w.points];
      const j = pts.length - 1;
      const a = pts[j - 1], b = pts[j];
      const cur = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const k = lengthCm / cur;
      pts[j] = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      return { ...w, points: pts };
    });
    set({ room: { ...get().room, partitions: parts }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  removeDoor: (index) => {
    get().snapshot();
    set({
      room: { ...get().room, doors: get().room.doors.filter((_, i) => i !== index) },
      result: null, diagnostics: [], focusedDiagnostic: null,
    });
  },
  setEditor: (patch) => set({ editor: { ...get().editor, ...patch } }),
  selectVertex: (i) => set({ selectedVertex: i }),
  addDrawPoint: (p) => set({ drawing: [...get().drawing, p] }),
  undoDrawPoint: () => set({ drawing: get().drawing.slice(0, -1) }),
  closeRoom: () => {
    const pts = dedupePoints(get().drawing);
    if (pts.length >= 3) {
      get().snapshot();
      set({ room: { ...get().room, points: pts }, drawing: [], tool: 'edit', result: null, diagnostics: [], focusedDiagnostic: null });
    }
  },
  closeHole: () => {
    const pts = get().drawing;
    if (pts.length >= 3) {
      get().snapshot();
      const room = get().room;
      set({ room: { ...room, holes: [...room.holes, pts] }, drawing: [], result: null, diagnostics: [], focusedDiagnostic: null });
    }
  },
  clearHoles: () => {
    get().snapshot();
    set({ room: { ...get().room, holes: [] }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  clearRoom: () => set({ drawing: [], result: null, diagnostics: [], focusedDiagnostic: null }),
  setRoomPoints: (pts) =>
    set({
      room: { ...get().room, points: pts, holes: [], doors: [], partitions: [], spaceTags: [] },
      result: null, diagnostics: [], focusedDiagnostic: null, selectedVertex: null,
    }),

  moveVertex: (index, p) => {
    const pts = get().room.points.map((q, i) => (i === index ? p : q));
    set({ room: { ...get().room, points: pts }, result: null, diagnostics: [], focusedDiagnostic: null });
  },
  insertVertex: (edgeIndex, p) => {
    const pts = [...get().room.points];
    pts.splice(edgeIndex + 1, 0, p);
    set({ room: { ...get().room, points: pts }, result: null, diagnostics: [], focusedDiagnostic: null, selectedVertex: edgeIndex + 1 });
  },
  deleteVertex: (index) => {
    const pts = get().room.points;
    if (pts.length <= 3) return; // garde un polygone valide
    set({
      room: { ...get().room, points: pts.filter((_, i) => i !== index) },
      result: null, diagnostics: [], focusedDiagnostic: null,
      selectedVertex: null,
    });
  },
  /** Fixe la longueur d'une arête en déplaçant son extrémité le long de sa direction. */
  setEdgeLength: (edgeIndex, lengthCm) => {
    const pts = [...get().room.points];
    const n = pts.length;
    const a = pts[edgeIndex];
    const b = pts[(edgeIndex + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const cur = Math.hypot(dx, dy) || 1;
    const k = lengthCm / cur;
    pts[(edgeIndex + 1) % n] = { x: a.x + dx * k, y: a.y + dy * k };
    set({ room: { ...get().room, points: pts }, result: null, diagnostics: [], focusedDiagnostic: null });
  },

  addPack: () => set({ packs: [...get().packs, defaultPack(get().packs.length + 1)] }),
  setPacks: (packs) => set({ packs, result: null, diagnostics: [], focusedDiagnostic: null }),
  updatePack: (id, patch) =>
    set({ packs: get().packs.map((p) => (p.id === id ? { ...p, ...patch } : p)) }),
  removePack: (id) => set({ packs: get().packs.filter((p) => p.id !== id) }),
  duplicatePack: (id) => {
    const src = get().packs.find((p) => p.id === id);
    if (!src) return;
    set({
      packs: [...get().packs, {
        ...src,
        id: uid(),
        name: `${src.name} (copie)`,
        planks: src.planks.map((p) => ({ ...p, id: uid() })),
      }],
    });
  },
  addPlanks: (packId, length, count) =>
    set({
      packs: get().packs.map((pack) => {
        if (pack.id !== packId) return pack;
        const taken = new Set(pack.planks.map((p) => p.no));
        const last = pack.planks[pack.planks.length - 1];
        const planks: Plank[] = [];
        let no = 1;
        for (let i = 0; i < Math.max(1, count); i++) {
          while (taken.has(no)) no++; // jamais deux lames sous le même numéro
          taken.add(no);
          planks.push({
            id: uid(),
            no,
            length: length > 0 ? length : (last?.length ?? 120),
            width: pack.defaultWidth,
            texture: last?.texture ?? 'chene-clair',
          });
        }
        return { ...pack, planks: [...pack.planks, ...planks] };
      }),
    }),
  updatePlank: (packId, plankId, patch) =>
    set({
      packs: get().packs.map((pack) => (pack.id === packId
        ? { ...pack, planks: pack.planks.map((p) => (p.id === plankId ? { ...p, ...patch } : p)) }
        : pack)),
    }),
  removePlank: (packId, plankId) =>
    set({
      packs: get().packs.map((pack) => (pack.id === packId
        ? { ...pack, planks: pack.planks.filter((p) => p.id !== plankId) }
        : pack)),
    }),
  setPackWidth: (packId, width) =>
    set({
      packs: get().packs.map((pack) => (pack.id === packId
        ? { ...pack, defaultWidth: width, planks: pack.planks.map((p) => ({ ...p, width })) }
        : pack)),
    }),
  renumberPack: (packId) =>
    set({
      packs: get().packs.map((pack) => (pack.id === packId
        ? { ...pack, planks: pack.planks.map((p, i) => ({ ...p, no: i + 1 })) }
        : pack)),
    }),

  setConfig: (patch) => set({ config: { ...get().config, ...patch } }),

  run: () => {
    const { room, packs, config } = get();
    const result = computeLayout(room, flattenPacks(packs), config);
    set({ result, diagnostics: validatePlan(room, result, config), focusedDiagnostic: null });
  },
  focusDiagnostic: (d) => set((s) => ({ focusedDiagnostic: d, focusNonce: s.focusNonce + 1 })),
}));

// Sauvegarde continue : le plan doit survivre à un rechargement de la page.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (s.room === prev.room && s.packs === prev.packs && s.config === prev.config
    && s.measures === prev.measures) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { room, packs, config, measures } = useStore.getState();
    saveProject({ room, packs, config, measures });
  }, 400);
});
