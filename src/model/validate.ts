import type { LayoutConfig, LayoutResult, Point, Room } from './types';
import { pointInPolygon } from './geometry';

export interface Diagnostic {
  severity: 'error' | 'warn' | 'info';
  kind: string;
  message: string;
  /** Zone du défaut en repère PIÈCE, pour surligner et recadrer. */
  region?: { x: number; y: number; w: number; h: number };
  count?: number;
}

const STEP = 0.5;   // cm par cellule
const ERODE = 3;    // 3 érosions ≈ 3 cm : sous ce seuil, jeu de dilatation ou filet de rive

/** Vides réels du sol (au-delà du jeu de dilatation), un Diagnostic par composante. */
function coverageHoles(result: LayoutResult): Diagnostic[] {
  const spaces = result.spaces.filter((s) => !s.excluded);
  if (!spaces.length) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of spaces) for (const p of s.outer) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  minX -= 5; maxX += 5; minY -= 5; maxY += 5;
  const W = Math.ceil((maxX - minX) / STEP), H = Math.ceil((maxY - minY) / STEP);
  if (W <= 0 || H <= 0 || W * H > 6_000_000) return []; // garde-fou mémoire

  const floor = new Uint8Array(W * H), laid = new Uint8Array(W * H);
  const mark = (buf: Uint8Array, poly: Point[], holes: Point[][]) => {
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const p of poly) {
      bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x);
      by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y);
    }
    const i0 = Math.max(0, Math.floor((bx0 - minX) / STEP)), i1 = Math.min(W - 1, Math.ceil((bx1 - minX) / STEP));
    const j0 = Math.max(0, Math.floor((by0 - minY) / STEP)), j1 = Math.min(H - 1, Math.ceil((by1 - minY) / STEP));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const p = { x: minX + (i + 0.5) * STEP, y: minY + (j + 0.5) * STEP };
      if (!pointInPolygon(p, poly)) continue;
      if (holes.some((h) => pointInPolygon(p, h))) continue;
      buf[j * W + i] = 1;
    }
  };
  for (const s of spaces) mark(floor, s.outer, s.holes);
  for (const pl of result.placed) for (const pc of pl.pieces) mark(laid, pc, []);

  let cur = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) cur[k] = floor[k] && !laid[k] ? 1 : 0;
  for (let e = 0; e < ERODE; e++) {
    const nx = new Uint8Array(W * H);
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (cur[k] && cur[k - 1] && cur[k + 1] && cur[k - W] && cur[k + W]) nx[k] = 1;
    }
    cur = nx;
  }

  const seen = new Uint8Array(W * H);
  const out: Diagnostic[] = [];
  for (let k = 0; k < W * H; k++) {
    if (seen[k] || !cur[k]) continue;
    const st = [k]; seen[k] = 1;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    while (st.length) {
      const c = st.pop() as number; const ci = c % W, cj = (c - ci) / W; n++;
      x0 = Math.min(x0, ci); x1 = Math.max(x1, ci); y0 = Math.min(y0, cj); y1 = Math.max(y1, cj);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nk = nj * W + ni;
        if (seen[nk] || !cur[nk]) continue;
        seen[nk] = 1; st.push(nk);
      }
    }
    // Reconstituer la bbox en cm, en compensant l'érosion (ERODE cellules de chaque côté).
    const pad = ERODE * STEP;
    const rx = minX + x0 * STEP - pad, ry = minY + y0 * STEP - pad;
    const rw = (x1 - x0 + 1) * STEP + 2 * pad, rh = (y1 - y0 + 1) * STEP + 2 * pad;
    out.push({ severity: 'error', kind: 'hole',
      message: `Trou de ${rw.toFixed(0)}×${rh.toFixed(0)} cm non couvert.`,
      region: { x: rx, y: ry, w: rw, h: rh } });
  }
  return out;
}

/** Joints collés entre rangées voisines (repère de pose), régionalisés en repère PIÈCE. */
function jointDiagnostics(result: LayoutResult, config: LayoutConfig): Diagnostic[] {
  const deg = (-(config.orientationDeg ?? 0) * Math.PI) / 180;
  const un = (p: Point) => ({ x: p.x * Math.cos(deg) - p.y * Math.sin(deg), y: p.x * Math.sin(deg) + p.y * Math.cos(deg) });
  // Regrouper par rangée (y arrondi au dixième en repère de pose) ; joint = fin de lame.
  type Seg = { x0: number; x1: number; cx: number; cy: number };
  const rows = new Map<string, Seg[]>();
  for (const pl of result.placed) {
    const r = pl.rect.map(un);
    const ys = r.map((p) => p.y), xs = r.map((p) => p.x);
    const key = (Math.round(Math.min(...ys) * 10) / 10).toFixed(1);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push({
      x0: Math.min(...xs), x1: Math.max(...xs),
      cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    });
  }
  const keys = [...rows.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));
  const jointsOf = (segs: Seg[]) => segs.filter((s) => segs.some((o) => o !== s && Math.abs(o.x0 - s.x1) < 1.5)).map((s) => s.x1);
  const out: Diagnostic[] = [];
  const FLUSH = 6;
  const rot = (x: number, y: number) => ({ x: x * Math.cos(-deg) - y * Math.sin(-deg), y: x * Math.sin(-deg) + y * Math.cos(-deg) });
  for (let i = 1; i < keys.length; i++) {
    const prev = jointsOf(rows.get(keys[i - 1])!);
    if (!prev.length) continue;
    const yTop = parseFloat(keys[i]);
    for (const j of jointsOf(rows.get(keys[i])!)) {
      const gap = Math.min(...prev.map((k) => Math.abs(j - k)));
      if (gap < FLUSH - 1e-6) {
        // Position du joint en repère pièce : point (j, yTop) tourné à l'envers.
        const c = rot(j, yTop);
        out.push({ severity: 'warn', kind: 'joint-flush',
          message: `Joint collé (${gap.toFixed(1)} cm de la rangée voisine).`,
          region: { x: c.x - 8, y: c.y - 8, w: 16, h: 16 } });
      }
    }
  }
  return out;
}

/** Morceaux sous la coupe mini, agrégés (pas de région). */
function shortPieceDiagnostics(result: LayoutResult, config: LayoutConfig): Diagnostic[] {
  const minCut = config.minCutLength ?? 0;
  if (minCut <= 0) return [];
  const n = result.placed.filter((p) => p.usedLength > 0.05 && p.usedLength < minCut - 0.05).length;
  return n > 0
    ? [{ severity: 'info', kind: 'piece-short', count: n, message: `${n} morceau(x) sous ${minCut} cm.` }]
    : [];
}

/**
 * Certifie la qualité d'un plan calepiné. Question sur le RÉSULTAT, indépendante du motif :
 * marche sur n'importe quel plan, comme le banc de mesure.
 */
export function validatePlan(_room: Room, result: LayoutResult, config: LayoutConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const st = result.stats;

  if (st.missingPlanks > 0) {
    out.push({ severity: 'error', kind: 'missing', count: st.missingPlanks,
      message: `${st.missingPlanks} lame(s) manquante(s) — stock insuffisant.` });
  }
  if (st.narrowRips > 0) {
    out.push({ severity: 'warn', kind: 'rip-narrow', count: st.narrowRips,
      message: `${st.narrowRips} refend(s) sous ${config.minRipWidth} cm de large — coupe délicate.` });
  }
  if (st.stagger.below > 0) {
    out.push({ severity: 'info', kind: 'joint-offset', count: st.stagger.below,
      message: `${st.stagger.below} joint(s) sous le décalage demandé (${st.stagger.target} cm).` });
  }
  out.push(...coverageHoles(result));
  out.push(...jointDiagnostics(result, config));
  out.push(...shortPieceDiagnostics(result, config));
  const order = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return out;
}
