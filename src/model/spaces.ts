// Détection des espaces : les cloisons découpent le logement en pièces fermées, chacune
// calepinée pour elle-même. Sans ça, la trame traverse les cloisons et une même lame se
// retrouve à cheval sur deux pièces — impossible à poser.
import polygonClipping, { type Geom, type Ring } from 'polygon-clipping';
import type { Point, Room } from './types';
import { partitionRects, pointInPolygon, polygonArea } from './geometry';
import { doorHost } from './doors';

/** Une pièce fermée : son contour et ses éventuels trous (poteau, gaine…). */
export interface Space {
  index: number;
  outer: Point[];
  holes: Point[][];
  areaM2: number;
  name: string;
  /** Pièce non parquetée : on la dessine, on la mesure, mais on n'y pose rien. */
  excluded: boolean;
}

const toRing = (pts: Point[]): Ring => {
  const r = pts.map((p) => [p.x, p.y] as [number, number]);
  // polygon-clipping veut des anneaux fermés.
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
  return r;
};
const toPoints = (ring: Ring): Point[] => {
  const pts = ring.map(([x, y]) => ({ x, y }));
  // On retire le point de fermeture dupliqué : le reste du modèle travaille en polygones ouverts.
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
  }
  return pts;
};

/** Aire minimale d'un espace retenu (cm²) : filtre les échardes issues du découpage. */
const MIN_SPACE_CM2 = 2000; // 0,2 m²

/**
 * Baies des portes de cloison sous lesquelles le parquet passe : elles trouent la cloison,
 * si bien que les deux pièces qu'elle sépare ne forment plus qu'une seule zone de pose.
 */
function throughDoorGaps(room: Room, wallThickness: number): Geom[] {
  const gaps: Geom[] = [];
  for (const door of room.doors ?? []) {
    if (!door.throughFloor || door.host !== 'partition') continue;
    const host = doorHost(room, door, wallThickness);
    if (!host) continue;
    const { a, b, near, far } = host;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const px = -uy, py = ux;
    const half = Math.min(door.width, len) / 2;
    const c = { x: a.x + ux * (door.center * len), y: a.y + uy * (door.center * len) };
    // On déborde un peu de l'épaisseur pour percer franchement, sans laisser de pellicule.
    const m = 1;
    const at = (t: number, off: number): Point => ({ x: c.x + ux * t + px * off, y: c.y + uy * t + py * off });
    gaps.push([toRing([at(-half, near - m), at(half, near - m), at(half, far + m), at(-half, far + m)])]);
  }
  return gaps;
}

/**
 * Découpe le sol par les cloisons et les zones exclues. Renvoie une zone de pose par
 * région fermée. Une porte « parquet traversant » rouvre le passage entre deux pièces.
 */
export function detectSpaces(room: Room, wallThickness: number): Space[] {
  const floorPoly = room.points;
  if (floorPoly.length < 3) return [];
  const holes = room.holes ?? [];

  // Les cloisons, percées des baies que le parquet traverse.
  const wallGeoms = partitionRects(room.partitions ?? []).map((r) => [toRing(r)] as Geom);
  const gaps = throughDoorGaps(room, wallThickness);
  let cutters: Geom[] = wallGeoms;
  if (gaps.length && wallGeoms.length) {
    try {
      const solid = polygonClipping.union(wallGeoms[0], ...wallGeoms.slice(1));
      const pierced = polygonClipping.difference(solid as Geom, ...gaps);
      cutters = pierced.map((p) => p as Geom);
    } catch {
      cutters = wallGeoms; // en cas de géométrie dégénérée, on garde les cloisons pleines
    }
  }
  cutters = [...cutters, ...holes.filter((h) => h.length >= 3).map((h) => [toRing(h)] as Geom)];

  let regions;
  try {
    regions = cutters.length
      ? polygonClipping.difference([toRing(floorPoly)] as Geom, ...cutters)
      : [[toRing(floorPoly)]];
  } catch {
    // Géométrie dégénérée : mieux vaut une pièce unique qu'un plan vide.
    regions = [[toRing(floorPoly)]];
  }

  const spaces: Space[] = [];
  for (const poly of regions) {
    if (!poly.length) continue;
    const outer = toPoints(poly[0]);
    if (outer.length < 3) continue;
    const inner = poly.slice(1).map(toPoints).filter((h) => h.length >= 3);
    const area = polygonArea(outer) - inner.reduce((s, h) => s + polygonArea(h), 0);
    if (area < MIN_SPACE_CM2) continue;
    spaces.push({
      index: spaces.length, outer, holes: inner, areaM2: +(area / 10000).toFixed(3),
      name: '', excluded: false,
    });
  }
  // Les plus grandes d'abord : la pièce principale porte le numéro 1.
  spaces.sort((a, b) => b.areaM2 - a.areaM2);
  spaces.forEach((sp, i) => {
    sp.index = i;
    // L'étiquette posée par l'utilisateur suit sa pièce, quel que soit le redécoupage.
    const tag = (room.spaceTags ?? []).find((t) => pointInPolygon(t.point, sp.outer));
    sp.name = tag?.name || `Pièce ${i + 1}`;
    sp.excluded = tag?.excluded ?? false;
  });
  return spaces;
}

/** Distance d'un point au bord du polygone (0 s'il est dessus). */
function distToEdges(poly: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Point d'ancrage d'une pièce : GARANTI à l'intérieur, et le plus au large possible.
 * Le centre de gravité ne convient pas : sur une pièce en L ou un couloir en U, il tombe
 * hors de la pièce — voire dans la pièce voisine, qui se retrouverait étiquetée à sa place.
 */
export function spaceCentroid(space: Space): Point {
  const pts = space.outer;
  if (pts.length < 3) return pts[0] ?? { x: 0, y: 0 };

  // Le centre de gravité convient dans le cas courant (pièce convexe) : on le garde.
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  const inside = (p: Point) =>
    pointInPolygon(p, pts) && !space.holes.some((h) => pointInPolygon(p, h));

  if (Math.abs(a) > 1e-9) {
    const c = { x: cx / (3 * a), y: cy / (3 * a) };
    if (inside(c)) return c;
  }

  // Sinon on cherche le point intérieur le plus éloigné des murs, par balayage.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const steps = 24;
  let best: Point = pts[0];
  let bestD = -1;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const p = {
        x: minX + ((maxX - minX) * i) / steps,
        y: minY + ((maxY - minY) * j) / steps,
      };
      if (!inside(p)) continue;
      const d = distToEdges(pts, p);
      if (d > bestD) { bestD = d; best = p; }
    }
  }
  return best;
}
