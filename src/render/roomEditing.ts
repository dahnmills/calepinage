import type { Point } from '../model/types';

export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const len = (a: Point): number => Math.hypot(a.x, a.y);
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Angle (deg) du vecteur, 0 = +x, sens horaire écran (y bas). */
export const angleDeg = (v: Point): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;
export const dirFromAngle = (deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
};

export const snapToGrid = (p: Point, step: number): Point => ({
  x: Math.round(p.x / step) * step,
  y: Math.round(p.y / step) * step,
});

/**
 * Contraint la direction depuis `from` vers `to` au multiple de `stepDeg` le plus proche,
 * en conservant la distance. Renvoie le point contraint + l'angle retenu.
 */
export function snapAngleFrom(from: Point, to: Point, stepDeg: number): { point: Point; angle: number } {
  const v = sub(to, from);
  const d = len(v);
  const a = angleDeg(v);
  const snapped = Math.round(a / stepDeg) * stepDeg;
  return { point: add(from, scale(dirFromAngle(snapped), d)), angle: snapped };
}

/** Index du sommet le plus proche de `p` sous le seuil (en cm), sinon -1. */
export function nearestVertex(pts: Point[], p: Point, threshold: number): number {
  let best = -1, bestD = threshold;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[i], p);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

export interface EdgeHit {
  index: number; // arête entre pts[index] et pts[index+1]
  point: Point; // projection sur l'arête
  t: number; // position 0..1 le long de l'arête
  d: number; // distance au segment
}

export function projectToSegment(a: Point, b: Point, p: Point): { point: Point; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y || 1;
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  t = Math.max(0, Math.min(1, t));
  const point = add(a, scale(ab, t));
  return { point, t, d: dist(point, p) };
}

/** Arête (fermée) la plus proche de `p` sous le seuil, sinon null. */
export function nearestEdge(pts: Point[], p: Point, threshold: number, closed = true): EdgeHit | null {
  let best: EdgeHit | null = null;
  const n = pts.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const pr = projectToSegment(a, b, p);
    if (pr.d <= threshold && (!best || pr.d < best.d)) best = { index: i, point: pr.point, t: pr.t, d: pr.d };
  }
  return best;
}

/**
 * Magnétisme complet pendant le tracé.
 * Priorité : point de départ (fermeture) > sommet existant > angle contraint + grille.
 */
export interface SnapContext {
  points: Point[]; // sommets déjà posés
  raw: Point; // curseur en cm
  gridStep: number;
  snapGrid: boolean;
  snapAngle: boolean;
  angleStep: number;
  vertexThreshold: number; // cm
  overrideAngle?: number; // si l'utilisateur a fixé un angle (saisie clavier)
  overrideLen?: number; // si l'utilisateur a fixé une longueur
  /**
   * Géométrie déjà en place sur laquelle s'accrocher (murs du périmètre, cloisons
   * existantes). Sans ça, impossible de raccorder une cloison au mur qu'elle rejoint.
   */
  guides?: Guide[];
}

export interface Guide {
  pts: Point[];
  closed: boolean;
}

export interface SnapResult {
  point: Point;
  closing: boolean; // proche du point de départ
  onVertex: number; // index si accroché à un sommet, sinon -1
  angle: number | null;
  length: number | null;
  /** Accroché à un mur existant : sur un de ses angles, ou en un point de son tracé. */
  onGuide: 'vertex' | 'edge' | null;
}

/** Angle de mur le plus proche : c'est là qu'on raccorde en priorité. */
function snapToGuideVertex(guides: Guide[], p: Point, threshold: number): Point | null {
  let best: { point: Point; d: number } | null = null;
  for (const g of guides) {
    for (const v of g.pts) {
      const d = dist(v, p);
      if (d <= threshold && (!best || d < best.d)) best = { point: v, d };
    }
  }
  return best ? best.point : null;
}

/** Point le plus proche sur le tracé d'un mur (hors de ses angles). */
function snapToGuides(guides: Guide[], p: Point, threshold: number): { point: Point; kind: 'vertex' | 'edge' } | null {
  let best: { point: Point; d: number } | null = null;
  for (const g of guides) {
    const hit = nearestEdge(g.pts, p, threshold, g.closed);
    if (hit && (!best || hit.d < best.d)) best = { point: hit.point, d: hit.d };
  }
  return best ? { point: best.point, kind: 'edge' } : null;
}

/**
 * Intersection de la demi-droite `from + t*dir` (t > 0) avec un segment [a, b].
 * Null si les droites sont parallèles ou si l'intersection tombe hors du segment.
 */
function rayHitSegment(from: Point, dir: Point, a: Point, b: Point): Point | null {
  const sx = b.x - a.x, sy = b.y - a.y;
  const denom = dir.x * sy - dir.y * sx;
  if (Math.abs(denom) < 1e-9) return null; // parallèles : pas de croisement franc
  const t = ((a.x - from.x) * sy - (a.y - from.y) * sx) / denom;
  const u = ((a.x - from.x) * dir.y - (a.y - from.y) * dir.x) / denom;
  if (t <= 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: from.x + dir.x * t, y: from.y + dir.y * t };
}

/**
 * Point où la direction contrainte vient buter sur un mur existant.
 * C'est ce qui manquait : sans ça, l'accroche au mur remplaçait purement le point contraint
 * et l'angle redevenait libre au moment précis où l'on rejoint le mur d'en face.
 */
function angleHitGuides(
  guides: Guide[], from: Point, dir: Point, raw: Point, threshold: number,
): Point | null {
  let best: { point: Point; d: number } | null = null;
  for (const g of guides) {
    const n = g.pts.length;
    const last = g.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const hit = rayHitSegment(from, dir, g.pts[i], g.pts[(i + 1) % n]);
      if (!hit) continue;
      // On ne s'accroche que si l'on visait bien ce mur-là.
      const d = dist(hit, raw);
      if (d <= threshold && (!best || d < best.d)) best = { point: hit, d };
    }
  }
  return best ? best.point : null;
}

export function snapDrawPoint(ctx: SnapContext): SnapResult {
  const { points, raw, gridStep, snapGrid, snapAngle, angleStep, vertexThreshold } = ctx;
  const last = points.length ? points[points.length - 1] : null;
  const lenTo = (p: Point) => (last ? dist(last, p) : null);

  // Saisie clavier explicite : longueur/angle imposés depuis le dernier point.
  if (last && (ctx.overrideLen != null || ctx.overrideAngle != null)) {
    const baseAngle = ctx.overrideAngle != null
      ? ctx.overrideAngle
      : snapAngle
        ? snapAngleFrom(last, raw, angleStep).angle
        : angleDeg(sub(raw, last));
    const l = ctx.overrideLen != null ? ctx.overrideLen : dist(last, raw);
    const point = add(last, scale(dirFromAngle(baseAngle), l));
    return { point, closing: false, onVertex: -1, angle: baseAngle, length: l, onGuide: null };
  }

  // Fermeture : proche du premier sommet.
  if (points.length >= 3 && dist(points[0], raw) <= vertexThreshold) {
    return { point: points[0], closing: true, onVertex: 0, angle: null, length: lenTo(points[0]), onGuide: null };
  }

  // Accroche à un sommet du tracé courant.
  const vi = nearestVertex(points, raw, vertexThreshold);
  if (vi >= 0) {
    return { point: points[vi], closing: false, onVertex: vi, angle: null, length: lenTo(points[vi]), onGuide: null };
  }

  const guides = ctx.guides ?? [];

  // Accroche à un ANGLE de mur : c'est là qu'on veut raccorder, l'angle du segment cède.
  const corner = guides.length ? snapToGuideVertex(guides, raw, vertexThreshold) : null;
  if (corner) {
    return {
      point: corner, closing: false, onVertex: -1,
      angle: last ? angleDeg(sub(corner, last)) : null, length: lenTo(corner), onGuide: 'vertex',
    };
  }

  // Le mur atteint EN GARDANT l'angle contraint : la cloison reste droite jusqu'à venir
  // buter exactement sur le mur d'en face, au lieu de dériver en l'approchant.
  if (last && snapAngle && guides.length) {
    const a = snapAngleFrom(last, snapGrid ? snapToGrid(raw, gridStep) : raw, angleStep).angle;
    const dir = dirFromAngle(a);
    const hit = angleHitGuides(guides, last, dir, raw, vertexThreshold * 1.6);
    if (hit) {
      return { point: hit, closing: false, onVertex: -1, angle: a, length: lenTo(hit), onGuide: 'edge' };
    }
  }

  // Sinon : projection simple sur le tracé d'un mur (angle libre).
  const g = guides.length ? snapToGuides(guides, raw, vertexThreshold) : null;
  if (g) {
    return { point: g.point, closing: false, onVertex: -1, angle: last ? angleDeg(sub(g.point, last)) : null, length: lenTo(g.point), onGuide: g.kind };
  }

  let p = snapGrid ? snapToGrid(raw, gridStep) : raw;
  let angle: number | null = null;
  if (last && snapAngle) {
    const s = snapAngleFrom(last, snapGrid ? snapToGrid(raw, gridStep) : raw, angleStep);
    angle = s.angle;
    // Angle contraint : on garde la direction exacte, mais on cale AUSSI la longueur sur
    // la grille. Sinon le point tombe à un angle juste mais une longueur bâtarde (23,4 cm),
    // et le trait paraît « de travers » avec des cotes qui ne tombent jamais rond.
    let len = dist(last, s.point);
    if (snapGrid && gridStep > 0) len = Math.round(len / gridStep) * gridStep;
    p = add(last, scale(dirFromAngle(angle), len));
  } else if (last) {
    angle = angleDeg(sub(p, last));
  }
  return { point: p, closing: false, onVertex: -1, angle, length: lenTo(p), onGuide: null };
}
