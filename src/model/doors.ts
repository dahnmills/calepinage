// Une porte vit sur un mur du périmètre ou sur une cloison : les deux supports ont un
// segment, une épaisseur et une orientation, c'est tout ce dont le rendu et le métré ont
// besoin. Ce module est le seul endroit qui sait faire la différence.
import type { Door, Point, Room, WallAlign } from './types';

export interface DoorHost {
  a: Point;
  b: Point;
  thickness: number;
  /**
   * Bornes de l'épaisseur du support, mesurées le long de sa normale gauche
   * (`(-uy, ux)` pour une direction `u`). Le rendu perce la baie entre ces deux bornes,
   * sans avoir à savoir s'il s'agit d'un mur ou d'une cloison.
   */
  near: number;
  far: number;
  /** Sens d'ouverture par défaut du vantail, le long de la normale gauche. */
  defaultSwing: 1 | -1;
}

const alignBounds = (thickness: number, align: WallAlign): { near: number; far: number } => {
  const near = align === 'center' ? -thickness / 2 : align === 'left' ? -thickness : 0;
  return { near, far: near + thickness };
};

/** Segment portant la porte, ou null si le support a disparu (mur/cloison supprimé). */
export function doorHost(room: Room, door: Door, wallThickness: number): DoorHost | null {
  if (door.host === 'partition') {
    const part = room.partitions?.[door.edgeIndex];
    if (!part || part.points.length < 2) return null;
    const a = part.points[door.segIndex];
    const b = part.points[door.segIndex + 1];
    if (!a || !b) return null;
    const { near, far } = alignBounds(part.thickness, part.align ?? 'center');
    return { a, b, thickness: part.thickness, near, far, defaultSwing: 1 };
  }
  const pts = room.points;
  const n = pts.length;
  if (n < 3 || door.edgeIndex >= n) return null;
  const a = pts[door.edgeIndex];
  const b = pts[(door.edgeIndex + 1) % n];
  // Le tracé est le nu intérieur : l'épaisseur part vers l'extérieur, le vantail rentre.
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const nrm = { x: -dy / l, y: dx / l }; // normale gauche
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const leftIsInside = isInside(pts, { x: mid.x + nrm.x * 0.01, y: mid.y + nrm.y * 0.01 });
  // Le mur occupe l'extérieur : de 0 (nu intérieur) à `thickness` vers le dehors.
  const near = 0;
  const far = leftIsInside ? -wallThickness : wallThickness;
  return { a, b, thickness: wallThickness, near, far, defaultSwing: leftIsInside ? 1 : -1 };
}

/** Centre de la porte dans le plan. */
export function doorCenter(host: DoorHost, door: Door): Point {
  return {
    x: host.a.x + (host.b.x - host.a.x) * door.center,
    y: host.a.y + (host.b.y - host.a.y) * door.center,
  };
}

function isInside(poly: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
