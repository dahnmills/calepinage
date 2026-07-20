/**
 * Banc de mesure du calepinage.
 *
 * Un calepinage « conforme » n'est pas forcément beau : l'algorithme peut respecter le
 * décalage minimal entre rangées voisines tout en reproduisant la même rangée tous les
 * deux rangs (attracteur de période 2). Ce banc mesure donc la CONFORMITÉ *et* la
 * RÉGULARITÉ indésirable, sur beaucoup de configurations, pour qu'aucun réglage ne soit
 * validé « au jugé ».
 *
 * Usage : npx esbuild tools/bench-layout.ts --bundle --platform=node --format=cjs \
 *           --outfile=_b.cjs && node _b.cjs [--full]
 */
import { computeLayout } from '../src/model/layout';
import { flattenPacks } from '../src/model/stock';
import type { LayoutConfig, PlankBatch, Point, Room } from '../src/model/types';

const fs = require('fs');

export interface Metrics {
  planks: number;
  rows: number;
  joints: number;
  /** Joints trop proches d'un joint de la rangée VOISINE (règle dure). */
  viol1Pct: number;
  /** Joints à moins d'1 cm d'un joint de la rangée voisine : alignement franc. */
  flush1: number;
  /** Joints alignés (<1 cm) avec la rangée n±2 : c'est l'effet « brique » régulier. */
  align2Pct: number;
  /** Rangées dont la suite de joints reproduit celle de la rangée n−2 : périodicité. */
  repeat2Pct: number;
  /** Séries de ≥3 rangées dont les joints dérivent d'un pas constant : effet escalier. */
  staircase: number;
  /** Écart médian au joint voisin le plus proche (cm) — plus haut = plus aéré. */
  medGap: number;
  wastePct: number;
  cuts: number;
  underMinCut: number;
  /**
   * Plus longue BANDE de rangées consécutives portant un joint à la même position (±2 cm).
   * Les métriques par PAIRES ne voient pas une ligne qui traverse dix rangées : elles
   * comparent n avec n−1 et concluent que tout va bien. C'est précisément le défaut que
   * l'utilisateur voyait pendant que le banc annonçait 0,3 joint collé.
   */
  bandMax: number;
  /**
   * Lames voisines issues de la MÊME lame physique (`plankNo`). Même veinage, même teinte
   * côte à côte : proscrit par les guidelines NWFA (« work from multiple bundles »).
   */
  samePlank: number;
  /** Plus court morceau posé (cm) — doit rester ≥ `minCutLength`. */
  minPiece: number;
  /** Plus petite largeur après refend (cm) : une bande de 0,7 cm est inposable. */
  minRip: number;
  /**
   * Surface du sol NON couverte (m²), hors jeu de dilatation. Doit rester à zéro : un
   * calepinage qui laisse un vide contre un mur est inutilisable, il faudra improviser au
   * chantier. Ce garde-fou existe parce que le cas s'est produit — la pose s'arrêtait au
   * bout du découpage prévu au lieu d'aller jusqu'au mur.
   */
  uncoveredM2: number;
}

type Seg = { x0: number; x1: number; plankNo: number };

/**
 * Rangées reconstruites dans le repère de pose, groupées par y SEUL.
 *
 * Volontairement pas par pièce : `detectSpaces` découpe aussi sur les trous, donc deux
 * « espaces » peuvent être physiquement adjacents sans cloison entre eux. Les grouper
 * séparément masquait les alignements de part et d'autre. Deux lames d'espaces différents
 * au même y sont bien dans la même bande physique ; un vrai mur entre elles ne crée pas de
 * faux joint, puisqu'un joint exige qu'une lame reprenne à moins de 1,5 cm.
 */
function rowsOf(placed: any[], orientationDeg: number): Seg[][] {
  const a = (-orientationDeg * Math.PI) / 180;
  const un = (p: Point) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
  const by = new Map<string, Seg[]>();
  for (const pl of placed) {
    const r = pl.rect.map(un);
    const ys = r.map((p: Point) => p.y), xs = r.map((p: Point) => p.x);
    const key = (Math.round(Math.min(...ys) * 10) / 10).toFixed(1);
    if (!by.has(key)) by.set(key, []);
    by.get(key)!.push({ x0: Math.min(...xs), x1: Math.max(...xs), plankNo: pl.plankNo });
  }
  const keys = [...by.keys()].sort((k1, k2) => parseFloat(k1) - parseFloat(k2));
  // Deux rangées séparées par un vide (étage de la pièce, décrochement) ne se comparent pas :
  // on insère une coupure pour que les métriques ne les traitent pas comme voisines.
  const out: Seg[][] = [];
  let prev: string | null = null;
  for (const k of keys) {
    const segs = by.get(k)!.sort((p, q) => p.x0 - q.x0);
    if (prev && Math.abs(parseFloat(k) - parseFloat(prev)) > 12.6) out.push([]); // coupure
    out.push(segs);
    prev = k;
  }
  return out;
}

/** Fins de lame qui sont de VRAIS joints : une autre lame de la rangée reprend juste après. */
const jointsOf = (segs: Seg[]): number[] =>
  segs.filter((s) => segs.some((o) => o !== s && Math.abs(o.x0 - s.x1) < 1.5)).map((s) => s.x1).sort((p, q) => p - q);

export function measure(room: Room, batches: PlankBatch[], config: LayoutConfig): Metrics {
  const res: any = computeLayout(room, batches, config);
  const bands = rowsOf(res.placed, config.orientationDeg);
  const rows = bands.map(jointsOf);
  const minOffset = config.minJointOffset ?? 0;

  let joints = 0, viol1 = 0, flush1 = 0, a2 = 0, a2tot = 0;
  const gaps: number[] = [];
  const nearest = (j: number, other: number[]) =>
    other.length ? Math.min(...other.map((k) => Math.abs(j - k))) : Infinity;

  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1] ?? [];
    const prev2 = rows[i - 2] ?? [];
    for (const j of rows[i]) {
      if (prev.length) {
        joints++;
        const g = nearest(j, prev);
        gaps.push(g);
        if (g < minOffset - 1e-6) viol1++;
        if (g < 1) flush1++;
      }
      if (prev2.length) { a2tot++; if (nearest(j, prev2) < 1) a2++; }
    }
  }

  // Périodicité : la rangée reproduit-elle celle d'il y a deux rangs ?
  let rep = 0, repTot = 0;
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i], b = rows[i - 2];
    if (a.length < 2 || b.length < 2) continue;
    repTot++;
    if (a.length === b.length && a.every((v, n) => Math.abs(v - b[n]) < 1.5)) rep++;
  }

  // Escalier : ≥3 rangées consécutives dont le 1ᵉʳ joint dérive du même pas.
  let stair = 0;
  for (let i = 2; i < rows.length; i++) {
    const [a, b, c] = [rows[i - 2], rows[i - 1], rows[i]];
    if (!a.length || !b.length || !c.length) continue;
    const d1 = b[0] - a[0], d2 = c[0] - b[0];
    if (Math.abs(d1) > 5 && Math.abs(d1 - d2) < 2) stair++;
  }

  // BANDE : combien de rangées CONSÉCUTIVES portent un joint au même endroit. C'est la
  // « ligne en travers » du plancher — invisible à toute métrique qui compare des paires.
  let bandMax = 0;
  for (let i = 0; i < rows.length; i++) {
    for (const j of rows[i]) {
      let run = 1;
      for (let k = i + 1; k < rows.length; k++) {
        if (!rows[k].some((v) => Math.abs(v - j) <= 2)) break;
        run++;
      }
      if (run > bandMax) bandMax = run;
    }
  }

  // Deux morceaux de la MÊME lame physique dans des rangées voisines, et qui se chevauchent
  // le long de la rangée : c'est là que l'œil voit le même veinage deux fois.
  let samePlank = 0;
  for (let i = 1; i < bands.length; i++) {
    for (const a of bands[i]) {
      if (!a.plankNo) continue;
      for (const b of bands[i - 1]) {
        if (b.plankNo !== a.plankNo) continue;
        if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1) { samePlank++; break; }
      }
    }
  }

  // Couverture : surface des pièces à parqueter moins surface réellement posée. Le jeu
  // périphérique en fait légitimement partie, on le déduit en tolérant une marge.
  const toLay = res.spaces
    .filter((sp: any) => !sp.excluded)
    .reduce((s: number, sp: any) => s + sp.areaM2, 0);
  const uncovered = Math.max(0, toLay - res.stats.laidAreaM2);

  const lens = res.placed.map((p: any) => p.usedLength).filter((l: number) => l > 0.05);
  const rips = res.placed.map((p: any) => p.usedWidth).filter((w: number) => w > 0.05);
  const sorted = gaps.slice().sort((p, q) => p - q);
  const pct = (n: number, d: number) => (d ? +((n / d) * 100).toFixed(1) : 0);

  return {
    planks: res.placed.length,
    rows: rows.filter((r) => r.length).length,
    joints,
    viol1Pct: pct(viol1, joints),
    flush1,
    align2Pct: pct(a2, a2tot),
    repeat2Pct: pct(rep, repTot),
    staircase: stair,
    medGap: sorted.length ? +sorted[sorted.length >> 1].toFixed(1) : 0,
    wastePct: +res.stats.wastePct.toFixed(1),
    cuts: res.stats.cuts,
    underMinCut: lens.filter((l: number) => l < (config.minCutLength ?? 0) - 0.05).length,
    bandMax,
    samePlank,
    minPiece: lens.length ? +Math.min(...lens).toFixed(1) : 0,
    minRip: rips.length ? +Math.min(...rips).toFixed(1) : 0,
    uncoveredM2: +uncovered.toFixed(3),
  };
}

// ---------------------------------------------------------------- jeux d'essai

const rect = (w: number, h: number): Room => ({
  id: 'r', name: 'r', points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
  holes: [], doors: [], partitions: [], spaceTags: [],
} as any);

const BASE: LayoutConfig = {
  patternId: 'straight', orientationDeg: 0, offsetMode: '1/3', jointGap: 0,
  minCutLength: 30, minJointOffset: 30, minRipWidth: 5, avoidSamePlank: true,
  reuseOffcuts: true, cutTolerance: 1,
  mixLengths: true, mixPacks: true, preferShort: false, exteriorWallThickness: 20,
  expansionGap: 0.8, optimizeStart: true, startFlip: false, wastePurchasePct: 10, seed: 12345,
} as any;

function loadJson(path: string) {
  const d = JSON.parse(fs.readFileSync(path, 'utf8'));
  // Comme `loadInto` dans le store : un projet enregistré avant l'ajout d'un réglage doit
  // hériter de sa valeur par défaut, sinon le banc mesure une configuration qui n'existe
  // dans l'app d'aucun utilisateur.
  return {
    room: d.room as Room,
    batches: flattenPacks(d.packs),
    config: { ...BASE, ...d.config } as LayoutConfig,
  };
}

const REAL = [
  '/Users/jeremydahan/Downloads/calepinage-2026-07-20 (3).json',
  '/Users/jeremydahan/Downloads/calepinage-2026-07-20 (4).json',
].filter((p: string) => fs.existsSync(p));

/** Stocks de synthèse : du plus homogène au plus hétéroclite. */
function synthBatches(spec: [number, number][], width = 12): PlankBatch[] {
  let n = 1;
  return spec.map(([length, quantity], i) => ({
    id: `s${i}:${length}x${width}:chene-clair`, length, width, quantity,
    texture: 'chene-clair' as any, numbers: Array.from({ length: quantity }, () => n++),
  }));
}

const STOCKS: Record<string, PlankBatch[]> = {
  'uniforme-120': synthBatches([[120, 400]]),
  'uniforme-160': synthBatches([[160, 300]]),
  'deux-longueurs': synthBatches([[120, 200], [60, 200]]),
  'heteroclite': synthBatches([[40, 25], [50, 44], [60, 81], [70, 23], [80, 57], [90, 55], [120, 20], [140, 11], [160, 10]]),
  'longues-dominantes': synthBatches([[160, 150], [140, 60], [90, 30], [60, 20]]),
};

export function runSuite(full: boolean) {
  const cases: { name: string; room: Room; batches: PlankBatch[]; config: LayoutConfig }[] = [];

  for (const p of REAL) {
    const { room, batches, config } = loadJson(p);
    const tag = p.slice(p.lastIndexOf('(')).replace(/[^0-9]/g, '');
    for (const seed of full ? [12345, 7, 99, 2024, 555] : [12345]) {
      cases.push({ name: `reel-${tag}-s${seed}`, room, batches, config: { ...config, seed } });
    }
  }

  const sizes: [number, number][] = full
    ? [[400, 300], [600, 420], [800, 500], [1000, 700], [530, 290], [250, 250]]
    : [[600, 420], [800, 500]];
  for (const [sk, batches] of Object.entries(STOCKS)) {
    for (const [w, h] of sizes) {
      for (const seed of full ? [12345, 7, 99] : [12345]) {
        cases.push({ name: `${sk}-${w}x${h}-s${seed}`, room: rect(w, h), batches, config: { ...BASE, seed } });
      }
    }
  }
  if (full) {
    for (const off of [20, 30, 40, 50]) {
      for (const [sk, batches] of Object.entries(STOCKS)) {
        cases.push({ name: `off${off}-${sk}`, room: rect(700, 450), batches, config: { ...BASE, minJointOffset: off } });
      }
    }
  }

  const rowsOut: (Metrics & { name: string })[] = [];
  for (const c of cases) {
    try { rowsOut.push({ name: c.name, ...measure(c.room, c.batches, c.config) }); }
    catch (e: any) { console.error(`ECHEC ${c.name}: ${e.message}`); }
  }
  return rowsOut;
}

if (require.main === module) {
  const full = process.argv.includes('--full');
  const rows = runSuite(full);
  const cols: (keyof Metrics)[] = ['rows', 'joints', 'viol1Pct', 'flush1', 'bandMax', 'samePlank', 'align2Pct', 'repeat2Pct', 'staircase', 'medGap', 'minPiece', 'minRip', 'uncoveredM2', 'wastePct', 'cuts', 'underMinCut'];
  const head = ['cas'.padEnd(28), ...cols.map((c) => String(c).padStart(10))].join(' ');
  console.log(head); console.log('-'.repeat(head.length));
  for (const r of rows) console.log([r.name.padEnd(28), ...cols.map((c) => String(r[c]).padStart(10))].join(' '));
  const avg = (k: keyof Metrics) => +(rows.reduce((s, r) => s + (r[k] as number), 0) / rows.length).toFixed(1);
  console.log('-'.repeat(head.length));
  console.log(['MOYENNE'.padEnd(28), ...cols.map((c) => String(avg(c)).padStart(10))].join(' '));
  console.log(`\n${rows.length} simulations`);
}
