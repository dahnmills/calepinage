// Le plan survit au rechargement : sans ça, un F5 malheureux efface un relevé d'une heure.
import type { LayoutConfig, Measure, Pack, Plank, PlankBatch, Room } from '../model/types';

const KEY = 'calepinage.project.v1';

export interface Project {
  room: Room;
  packs: Pack[];
  config: LayoutConfig;
  measures: Measure[];
}

/** Ancien format : un stock à plat, sans paquets. On le remonte en un paquet unique. */
interface LegacyProject {
  batches?: PlankBatch[];
}

/** Ligne groupée, telle qu'enregistrée avant que chaque lame devienne individuelle. */
interface LegacyLine {
  id?: string;
  length: number;
  width: number;
  texture: Plank['texture'];
  quantity?: number;
  numbers?: number[] | null;
}
interface LegacyPack {
  id?: string;
  name?: string;
  defaultWidth?: number;
  planks?: Plank[];
  lines?: LegacyLine[];
}

let seq = 0;
const nid = () => `p${Date.now().toString(36)}${seq++}`;

/** Déplie les anciennes lignes groupées en lames individuelles, une par numéro. */
function planksFrom(lines: LegacyLine[]): Plank[] {
  const out: Plank[] = [];
  let next = 1;
  for (const l of lines) {
    const numbers = l.numbers?.length
      ? l.numbers
      : Array.from({ length: Math.max(0, l.quantity ?? 0) }, (_, i) => next + i);
    for (const no of numbers) {
      out.push({ id: nid(), no, length: l.length, width: l.width, texture: l.texture });
    }
    if (numbers.length) next = Math.max(next, ...numbers) + 1;
  }
  return out;
}

function packsFrom(p: Partial<Project> & LegacyProject): Pack[] {
  if (p.packs?.length) {
    return (p.packs as LegacyPack[]).map((pk) => {
      const planks = pk.planks?.length ? pk.planks : planksFrom(pk.lines ?? []);
      return {
        id: pk.id ?? nid(),
        name: pk.name ?? 'Paquet',
        defaultWidth: pk.defaultWidth ?? planks[0]?.width ?? 20,
        planks,
      };
    });
  }
  if (p.batches?.length) {
    // Le stock plat devient un paquet contenant une lame par ligne : les quantités
    // sont conservées telles quelles (un seul « paquet » de tout le stock).
    const planks = planksFrom(p.batches.map((b) => ({
      id: nid(), length: b.length, width: b.width, quantity: b.quantity, texture: b.texture,
    })));
    return [{
      id: nid(),
      name: 'Stock',
      defaultWidth: planks[0]?.width ?? 20,
      planks,
    }];
  }
  return [];
}

/**
 * Remet d'aplomb un projet enregistré par une version antérieure : un champ ajouté depuis
 * ne doit pas donner un `undefined` qui se propage en NaN dans les calculs.
 */
function migrate(p: Partial<Project> & LegacyProject): Project {
  const room = (p.room ?? {}) as Room;
  return {
    room: {
      ...room,
      holes: room.holes ?? [],
      spaceTags: room.spaceTags ?? [],
      partitions: (room.partitions ?? []).map((w) => ({ ...w, align: w.align ?? 'center' })),
      doors: (room.doors ?? []).map((d) => ({
        ...d,
        host: d.host ?? 'wall',
        segIndex: d.segIndex ?? 0,
        swing: d.swing ?? 1,
        throughFloor: d.throughFloor ?? false,
      })),
    },
    packs: packsFrom(p),
    config: (p.config ?? {}) as LayoutConfig,
    measures: p.measures ?? [],
  };
}

export function saveProject(p: Project) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Quota plein ou stockage refusé : on ne casse pas l'app pour une sauvegarde.
  }
}

export function loadProject(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Project> & LegacyProject;
    if (!p.room || !Array.isArray(p.room.points) || !p.config) return null;
    return migrate(p);
  } catch {
    return null;
  }
}

export function clearProject() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* rien à faire */ }
}

/** Export dans un fichier, pour archiver un chantier ou l'envoyer. */
export function exportProject(p: Project) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `calepinage-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Relit un fichier de projet. Rejette tout ce qui n'a pas la forme attendue. */
export function importProject(file: File): Promise<Project> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result)) as Partial<Project> & LegacyProject;
        if (!p.room || !Array.isArray(p.room.points) || !p.config) {
          reject(new Error('Fichier de projet illisible'));
          return;
        }
        resolve(migrate(p));
      } catch {
        reject(new Error('Fichier de projet illisible'));
      }
    };
    reader.onerror = () => reject(new Error('Lecture impossible'));
    reader.readAsText(file);
  });
}
