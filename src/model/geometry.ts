import type { Point, WallAlign } from './types';

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Retire les sommets confondus consécutifs (et la fermeture répétée du 1er point).
 * Indispensable : un sommet dupliqué crée une arête de longueur nulle, dont la direction
 * est indéfinie — d'où des normales fausses et des angles de mur qui partent de travers.
 */
export function dedupePoints(pts: Point[], eps = 1e-6): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > eps) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) out.pop();
  return out;
}

/** Aire signée absolue d'un polygone (formule du lacet). */
export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonBBox(poly: Point[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Test point-dans-polygone par lancer de rayon. */
export function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    const intersect =
      pi.y > pt.y !== pj.y > pt.y &&
      pt.x < ((pj.x - pi.x) * (pt.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function rotate(p: Point, deg: number, origin: Point = { x: 0, y: 0 }): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - origin.x, dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

/**
 * Découpe le polygone `subject` (convexe : un rectangle de lame) par le polygone
 * `clip` (la pièce), via Sutherland–Hodgman. La pièce doit être convexe OU on l'utilise
 * comme demi-plans successifs : pour un polygone de pièce quelconque potentiellement
 * concave, on découpe plutôt le sujet par la pièce en utilisant l'algorithme inverse
 * (voir clipPlankToRoom). Ici : clip d'un polygone convexe par un ensemble de demi-plans.
 */
function clipByHalfPlane(subject: Point[], a: Point, b: Point): Point[] {
  // Garde les points à gauche (côté intérieur) de l'arête orientée a->b.
  const out: Point[] = [];
  const inside = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
  const intersect = (p: Point, q: Point): Point => {
    const dpx = q.x - p.x, dpy = q.y - p.y;
    const dax = b.x - a.x, day = b.y - a.y;
    // t = cross(A-P, e) / cross(d, e), avec d = q-p, e = b-a.
    const denom = dpx * day - dpy * dax;
    if (Math.abs(denom) < 1e-9) return q; // arêtes ~parallèles : évite un NaN
    const t = ((a.x - p.x) * day - (a.y - p.y) * dax) / denom;
    return { x: p.x + t * dpx, y: p.y + t * dpy };
  };
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i];
    const prev = subject[(i + subject.length - 1) % subject.length];
    const curIn = inside(cur), prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/** Oriente un polygone en sens anti-horaire (CCW) pour un repère y-bas cohérent. */
export function ensureCCW(poly: Point[]): Point[] {
  let signed = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    signed += p.x * q.y - q.x * p.y;
  }
  return signed < 0 ? [...poly].reverse() : poly;
}

/** Décompose un polygone (éventuellement concave) en triangles par fan + earcut simple. */
export function triangulate(poly: Point[]): Point[][] {
  const pts = ensureCCW(poly).slice();
  const tris: Point[][] = [];
  const idx = pts.map((_, i) => i);
  const area2 = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const pointInTri = (p: Point, a: Point, b: Point, c: Point) => {
    const d1 = area2(p, a, b), d2 = area2(p, b, c), d3 = area2(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (area2(a, b, c) <= 0) continue; // pas une oreille convexe
      let ear = true;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (pointInTri(pts[k], a, b, c)) { ear = false; break; }
      }
      if (ear) {
        tris.push([a, b, c]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  return tris;
}

/**
 * Décale un polygone vers l'intérieur de `dist` cm (érosion). Chaque arête est
 * translatée le long de sa normale intérieure, les nouveaux sommets = intersection des
 * arêtes décalées consécutives. Robuste pour des pièces d'habitation (convexes ou en L).
 * Renvoie le polygone original si l'inset dégénère.
 */
export function offsetPolygon(poly: Point[], dist: number): Point[] {
  const n = poly.length;
  // `dist` < 0 : dilatation (face extérieure des murs). Même construction, normale inversée.
  if (n < 3 || Math.abs(dist) < 1e-9) return poly;
  const eps = 0.01;

  // Normale intérieure de chaque arête.
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const dir = { x: dx / l, y: dy / l };
    let nrm = { x: -dir.y, y: dir.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!pointInPolygon({ x: mid.x + nrm.x * eps, y: mid.y + nrm.y * eps }, poly)) {
      nrm = { x: -nrm.x, y: -nrm.y };
    }
    return { p: { x: a.x + nrm.x * dist, y: a.y + nrm.y * dist }, dir };
  });

  // Intersection de deux droites (point + direction).
  const intersect = (l1: { p: Point; dir: Point }, l2: { p: Point; dir: Point }): Point => {
    const denom = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
    if (Math.abs(denom) < 1e-9) return l2.p; // quasi parallèles
    const t = ((l2.p.x - l1.p.x) * l2.dir.y - (l2.p.y - l1.p.y) * l2.dir.x) / denom;
    return { x: l1.p.x + l1.dir.x * t, y: l1.p.y + l1.dir.y * t };
  };

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i + n - 1) % n];
    out.push(intersect(prev, lines[i]));
  }
  // Garde-fou : inset dégénéré -> polygone d'origine (sans objet en dilatation).
  if (dist > 0 && polygonArea(out) < polygonArea(poly) * 0.02) return poly;
  return out;
}

/**
 * Rectangle d'emprise d'un segment de cloison.
 * `align` dit où porter l'épaisseur : `center` = à cheval sur le tracé (axe du mur),
 * `left`/`right` = le tracé est une face, l'épaisseur part entièrement d'un côté.
 */
export function segmentRect(
  a: Point, b: Point, thickness: number, align: WallAlign = 'center',
  extendA = true, extendB = true,
): Point[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  // Normale (gauche du sens de tracé, repère écran y vers le bas).
  const px = -uy, py = ux;
  // Bornes de l'épaisseur de part et d'autre du tracé.
  const near = align === 'center' ? -thickness / 2 : align === 'left' ? -thickness : 0;
  const far = near + thickness;
  // Rallonge SEULEMENT aux angles d'une polyligne, pour les souder. Une extrémité libre
  // reste franche : sinon la cloison dépasse dans le vide de la moitié de son épaisseur.
  const ex = ux * (thickness / 2), ey = uy * (thickness / 2);
  const a2 = extendA ? { x: a.x - ex, y: a.y - ey } : a;
  const b2 = extendB ? { x: b.x + ex, y: b.y + ey } : b;
  return [
    { x: a2.x + px * near, y: a2.y + py * near },
    { x: b2.x + px * near, y: b2.y + py * near },
    { x: b2.x + px * far, y: b2.y + py * far },
    { x: a2.x + px * far, y: a2.y + py * far },
  ];
}

/** Intersection de deux droites (point + direction). Null si parallèles. */
function lineIntersect(p1: Point, d1: Point, p2: Point, d2: Point): Point | null {
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/**
 * Emprises (rectangles) de toutes les cloisons, PLUS un remblai d'angle par sommet
 * intérieur. Chaque segment garde EXACTEMENT sa longueur tracée (la face plate ne
 * déborde pas) ; seul le coin est comblé jusqu'au point d'ONGLET, ce qui donne une
 * jonction carrée nette sans rien ajouter à la longueur. Angle très aigu : l'onglet
 * est plafonné (chanfrein) pour ne pas laisser filer une pointe.
 */
export function partitionRects(
  partitions: { points: Point[]; thickness: number; align?: WallAlign }[],
): Point[][] {
  const miterLimit = 3;
  const rects: Point[][] = [];
  for (const p of partitions) {
    const pts = dedupePoints(p.points);
    const t = p.thickness;
    // Côté de l'épaisseur : on la porte vers le CREUX de la polyligne (le côté concave),
    // pour que les dimensions extérieures = les longueurs tracées (une cloison en L de
    // 60×30 encombre 60×30, on n'ajoute pas l'épaisseur du bras perpendiculaire). Le côté
    // dépend du sens de tracé : on le déduit de l'aire signée. Cloison droite (aire ~0) :
    // pas de creux, on garde le réglage choisi (défaut = une face, jamais l'axe milieu).
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    const align: WallAlign = Math.abs(area) < 1e-6 ? (p.align === 'right' ? 'right' : 'left')
      : area > 0 ? 'left' : 'right';
    const near = align === 'left' ? -t : 0;
    const far = near + t;
    for (let i = 0; i < pts.length - 1; i++) {
      rects.push(segmentRect(pts[i], pts[i + 1], t, align, false, false));
    }
    // Remblai d'onglet à chaque sommet interne.
    for (let i = 1; i < pts.length - 1; i++) {
      const A = pts[i - 1], V = pts[i], B = pts[i + 1];
      const uA = { x: V.x - A.x, y: V.y - A.y };
      const lA = Math.hypot(uA.x, uA.y) || 1; uA.x /= lA; uA.y /= lA;
      const uB = { x: B.x - V.x, y: B.y - V.y };
      const lB = Math.hypot(uB.x, uB.y) || 1; uB.x /= lB; uB.y /= lB;
      const pA = { x: -uA.y, y: uA.x }, pB = { x: -uB.y, y: uB.x };
      // Les deux côtés (near/far) : celui qui bâille (convexe) est comblé jusqu'à l'onglet,
      // l'autre tombe dans le recouvrement (inoffensif).
      for (const off of [near, far]) {
        const Pa = { x: V.x + pA.x * off, y: V.y + pA.y * off };
        const Pb = { x: V.x + pB.x * off, y: V.y + pB.y * off };
        const M = lineIntersect(Pa, uA, Pb, uB);
        // Le remblai PASSE PAR V : il partage une arête avec chaque bras (et non un simple
        // point de contact), donc l'union soude vraiment au lieu de laisser des morceaux.
        if (M && Math.hypot(M.x - V.x, M.y - V.y) <= miterLimit * t) {
          rects.push([Pa, M, Pb, V]); // onglet plein (coin carré)
        } else {
          rects.push([Pa, Pb, V]); // chanfrein : angle très aigu, pas de pointe qui file
        }
      }
    }
  }
  return rects;
}

/** Vrai si le polygone est convexe (tous les produits croisés de même signe). */
export function isConvex(poly: Point[]): boolean {
  let sign = 0;
  const n = poly.length;
  if (n < 4) return true;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Clippe un polygone convexe `subject` par le polygone convexe `clip` (Sutherland–Hodgman). */
export function clipConvex(subject: Point[], clip: Point[]): Point[] {
  const c = ensureCCW(clip);
  let poly = subject;
  for (let i = 0; i < c.length && poly.length; i++) {
    poly = clipByHalfPlane(poly, c[i], c[(i + 1) % c.length]);
  }
  return poly;
}

/** Retire un triangle (zone exclue) d'un ensemble de morceaux convexes. */
function subtractTriangle(pieces: Point[][], tri: Point[]): Point[][] {
  const t = ensureCCW(tri);
  const res: Point[][] = [];
  for (const piece of pieces) {
    let remaining = piece;
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3];
      const outside = clipByHalfPlane(remaining, b, a); // demi-plan hors triangle
      if (outside.length >= 3) res.push(outside);
      remaining = clipByHalfPlane(remaining, a, b); // ce qui reste dans le triangle
      if (remaining.length < 3) break;
    }
    // `remaining` restant = à l'intérieur du triangle -> supprimé (c'est le trou).
  }
  return res;
}

/**
 * Découpe préparée d'une pièce : si convexe, on garde le polygone tel quel (clip direct,
 * pas de couture interne) ; sinon on triangule. Les zones exclues (trous) sont
 * pré-triangulées pour être soustraites de chaque lame.
 */
export interface RoomClipper {
  convex: boolean;
  poly: Point[];
  triangles: Point[][];
  holeTriangles: Point[][];
}

export function makeRoomClipper(poly: Point[], holes: Point[][] = []): RoomClipper {
  const convex = isConvex(poly) && holes.length === 0;
  const holeTriangles = holes
    .flatMap((h) => (h.length >= 3 ? triangulate(h) : []))
    .filter((t) => polygonArea(t) > 1e-6); // ignore les triangles dégénérés
  return { convex, poly, triangles: convex ? [] : triangulate(poly), holeTriangles };
}

/**
 * Intersecte un rectangle de lame avec la pièce, puis soustrait les zones exclues.
 * Pièce convexe sans trou -> 1 polygone propre. Sinon triangulation + agrégation.
 */
export function clipRectToRoom(rect: Point[], clipper: RoomClipper): Point[][] {
  let pieces: Point[][];
  if (clipper.convex) {
    const p = clipConvex(rect, clipper.poly);
    pieces = p.length >= 3 ? [p] : [];
  } else {
    pieces = [];
    for (const tri of clipper.triangles) {
      const poly = clipConvex(rect, tri);
      if (poly.length >= 3) pieces.push(poly);
    }
  }
  for (const ht of clipper.holeTriangles) {
    if (pieces.length === 0) break;
    pieces = subtractTriangle(pieces, ht);
  }
  return pieces;
}
