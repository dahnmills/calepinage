// Le stock est une liste de lames, une par une : chacune a son numéro, celui qu'on inscrit
// au crayon dessus. Le moteur, lui, raisonne par lots de lames identiques — ce module
// regroupe les lames pour lui, et lui transmet leurs numéros.
import type { Pack, Plank, PlankBatch } from './types';

/** Un lot = les lames d'un paquet qui partagent dimensions et aspect. */
export const batchId = (packId: string, p: Plank) =>
  `${packId}:${p.length}x${p.width}:${p.texture}`;

export const packIdOf = (batchId: string) => batchId.split(':')[0];

/** Lots vus par le moteur, chacun portant les numéros des lames qu'il contient. */
export function flattenPacks(packs: Pack[]): PlankBatch[] {
  const byId = new Map<string, PlankBatch>();
  for (const pack of packs) {
    for (const p of pack.planks) {
      if (p.length <= 0 || p.width <= 0) continue;
      const id = batchId(pack.id, p);
      const b = byId.get(id);
      if (b) {
        b.quantity++;
        b.numbers.push(p.no);
      } else {
        byId.set(id, {
          id,
          length: p.length,
          width: p.width,
          quantity: 1,
          texture: p.texture,
          numbers: [p.no],
        });
      }
    }
  }
  // Les numéros croissants : la lame servie en premier est la première du paquet.
  for (const b of byId.values()) b.numbers.sort((a, c) => a - c);
  return [...byId.values()];
}

export const planksIn = (pack: Pack) => pack.planks.length;

export const areaOf = (pack: Pack) =>
  pack.planks.reduce((s, p) => s + (p.length * p.width) / 10000, 0);

/** Numéros portés par plusieurs lames du paquet : la codification deviendrait ambiguë. */
export function duplicateNumbers(pack: Pack): number[] {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const p of pack.planks) {
    if (seen.has(p.no)) dupes.add(p.no);
    seen.add(p.no);
  }
  return [...dupes].sort((a, b) => a - b);
}

/** Prochain numéro libre du paquet : une lame ajoutée ne doit jamais entrer en collision. */
export function nextFreeNumber(pack: Pack): number {
  const taken = new Set(pack.planks.map((p) => p.no));
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/** Récapitulatif par longueur, pour lire le stock d'un coup d'œil. */
export function byLength(pack: Pack): { length: number; count: number }[] {
  const m = new Map<number, number>();
  for (const p of pack.planks) m.set(p.length, (m.get(p.length) ?? 0) + 1);
  return [...m.entries()]
    .map(([length, count]) => ({ length, count }))
    .sort((a, b) => b.length - a.length);
}
