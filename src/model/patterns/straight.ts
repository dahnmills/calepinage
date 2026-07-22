import type { LayoutConfig, PlacedPlank, Point } from '../types';
import type { Inventory } from '../inventory';
import { clipRectToRoom, polygonBBox, rotate, type RoomClipper } from '../geometry';

export interface PatternInput {
  /** Découpe de la pièce, DÉJÀ dans le repère de pose (tourné de -orientation). */
  clipper: RoomClipper;
  config: LayoutConfig;
  inventory: Inventory;
  /** Largeur de pose (cm) et longueur nominale de lame (cm). */
  poseWidth: number;
  nominalLength: number;
  optimizeStart: boolean;
  /** Ligne de départ (y dans le repère de pose) : rangées posées des deux côtés. */
  startLineY?: number;
}

/** Étendue d'un polygone le long de l'axe x (repère de pose). */
function xExtent(poly: Point[]): { minX: number; maxX: number } {
  let minX = Infinity, maxX = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  return { minX, maxX };
}

/**
 * Plages de matière CONTINUE le long de l'axe des lames. Les morceaux clipés adjacents (bord
 * concave, triangulation) fusionnent en une seule plage ; un vrai trou — cloison, zone
 * exclue — laisse deux plages séparées. Une lame ne s'étend jamais d'une plage à l'autre.
 */
function mergeRuns(pieces: Point[][], gap: number): { start: number; end: number }[] {
  const iv = pieces.map(xExtent).sort((a, b) => a.minX - b.minX);
  const out: { start: number; end: number }[] = [];
  const weld = Math.max(gap, 0) + 0.5; // sous ce seuil, deux morceaux se touchent (pas un trou)
  for (const e of iv) {
    const last = out[out.length - 1];
    if (last && e.minX <= last.end + weld) last.end = Math.max(last.end, e.maxX);
    else out.push({ start: e.minX, end: e.maxX });
  }
  return out;
}

/**
 * Génère la pose droite à coupe décalée dans le repère de pose (x = axe des lames),
 * puis retransforme chaque lame dans le repère PIÈCE via `orientationDeg`.
 */
export function generateStraight(input: PatternInput): PlacedPlank[] {
  const { clipper, config, inventory, poseWidth, optimizeStart, startLineY } = input;
  const { jointGap, orientationDeg } = config;

  // BBox de la pièce dans le repère de pose.
  const allPts = clipper.convex ? clipper.poly : clipper.triangles.flat();
  if (allPts.length === 0) return [];
  const bb = polygonBBox(allPts);

  const rowStep = poseWidth + jointGap;
  const planks: PlacedPlank[] = [];
  let idCounter = 0;
  const origin = { x: 0, y: 0 };

  // `offsetMode` (1/2, 1/3, aléatoire) n'est plus consommé ici. Il décalait le x de départ
  // de la rangée, mais la rangée se recale sur le bord de la matière : le décalage était
  // effacé, les trois modes rendaient le même plan (mesuré). Et il n'a pas lieu d'être avec
  // un stock multi-longueurs : le NF DTU 51.11 pose alors la « coupe perdue » comme mode par
  // défaut, où le décalage naît des contraintes de joints, pas d'une trame théorique. Le
  // motif régulier normatif (« coupe de pierre », DTU 51.2 §6d : décalage d'une demi-longueur
  // à 3 mm près, rangées n et n+2 alignées à 2 mm près) suppose des lames toutes identiques
  // et reste à implémenter comme un motif à part entière.

  // --- Passe 1 : géométrie seule. On établit toutes les cellules et la longueur qu'il
  // faut y poser, sans toucher au stock : l'affectation des lames en dépendra, pas l'inverse.
  const tol = Math.max(0, config.cutTolerance ?? 0);
  const minCut = Math.max(0, config.minCutLength ?? 0);


  // Joints (fins de lame) de chaque rangée déjà tracée, pour tenir le décalage d'une
  // rangée à l'autre. La clé est la position de la rangée : les rangées ne sont pas
  // établies dans l'ordre spatial quand il y a une ligne de départ.
  const jointsByRow = new Map<number, number[]>();
  /**
   * Décalage DOMINANT de chaque rangée par rapport à sa voisine précédente. Sert à casser
   * l'escalier : NWFA proscrit « equal end-joint offsets in sequential rows ». Un
   * algorithme qui prend systématiquement le premier décalage valide produit un escalier
   * parfait — techniquement conforme, visuellement inacceptable. C'est le piège classique.
   */
  const driftByRow = new Map<number, number>();
  /**
   * Lames physiques posées dans chaque rangée. Sert à ne pas servir à la rangée suivante
   * une chute issue d'une lame déjà posée juste à côté : deux morceaux du même bois côte à
   * côte, c'est le même veinage répété — proscrit par les guidelines NWFA.
   */
  const plankNosByRow = new Map<number, Set<number>>();
  const rowKey = (y: number) => Math.round(y * 10);
  const minOffset = Math.max(0, config.minJointOffset ?? 0);
  /** Marge anti joint en « H » entre rangées n et n+2 (NWFA). */
  const H_JOINT_MIN = 10;
  /**
   * Coût d'un joint de plus dans une plage. Moins de joints = décalage plus facile à tenir
   * ET rendu plus calme. Valeur retenue au banc (600 simulations) : meilleure sur tous les
   * indicateurs à la fois — fautes, chute et nombre de coupes.
   */
  const JOINT_PENALTY = 60;
  /** Écart réellement obtenu sur chaque plage, pour pouvoir dire ce qu'on a vraiment tenu. */
  const achievedGaps: number[] = [];

  /** Écart SIGNÉ au joint voisin le plus proche : le signe porte le sens de l'escalier. */
  const signedGapTo = (x: number, l: number, joints: number[]): number => {
    let best = Infinity, sign = 0;
    for (const j of joints) {
      const d = x + l - j;
      if (Math.abs(d) < Math.abs(best) || best === Infinity) { best = Math.abs(d); sign = d; }
    }
    return Number.isFinite(best) ? sign : Infinity;
  };

  /** Écart entre le joint produit par une lame de longueur `l` et le joint voisin le plus proche. */
  const gapTo = (x: number, l: number, joints: number[]): number => {
    let best = Infinity;
    for (const j of joints) best = Math.min(best, Math.abs(x + l - j));
    return best;
  };

  /**
   * Choisit la LONGUEUR de la prochaine lame, parmi celles qu'on a réellement en stock.
   *
   * Le seul critère « la plus proche de la longueur théorique » alignait les joints : les
   * mêmes longueurs revenant partout, les coupes finissaient par former des lignes qui
   * traversent la pièce — laid, et contraire aux règles de pose. On note donc chaque
   * longueur possible sur l'écart qu'elle donne aux joints des rangées voisines (les deux
   * de chaque côté, la plus proche pesant le plus), et l'on retient la mieux placée.
   * À qualité égale, la lame la plus longue gagne : moins de coupes, moins de chutes.
   */
  /** Pénalité d'un joint à la position absolue `P` (plus c'est haut, pire c'est). */
  // Grille de phase (période première aux longueurs de stock 60/80/90 → pas de résonance).
  const PHASE_PERIOD = 47;
  const jointCost = (P: number, near: number[], far: number[], off: number, phase: number): number => {
    let c = JOINT_PENALTY; // chaque joint de plus coûte : on préfère les lames longues
    let gN = Infinity;
    for (const j of near) gN = Math.min(gN, Math.abs(P - j));
    if (Number.isFinite(gN)) {
      if (gN < off - 1e-6) c += 1000 + (off - gN) * 20; // faute : joint trop près de la voisine
      else c -= Math.min(gN, off * 1.5) * 2;            // récompense un bon écart
    }
    let gF = Infinity;
    for (const j of far) gF = Math.min(gF, Math.abs(P - j));
    if (Number.isFinite(gF) && gF < H_JOINT_MIN - 1e-6) c += 200; // joint en « H » (n±2)
    // Biais de phase PAR RANGÉE : départage les séquences à coût égal pour que deux rangées
    // de longueur identique (near vide) ne convergent pas sur les MÊMES joints (bande alignée).
    // Poids faible (0,35) : brise la symétrie sans jamais renverser un vrai écart de décalage.
    const d = Math.abs(((P - phase) % PHASE_PERIOD + PHASE_PERIOD + PHASE_PERIOD / 2) % PHASE_PERIOD - PHASE_PERIOD / 2);
    c += d * 0.8;
    return c;
  };

  /**
   * SOLVEUR par programmation dynamique. Trouve la séquence de lames qui minimise le coût
   * total des joints, avec une règle dure : toutes les lames SAUF la dernière sont ENTIÈRES
   * (longueurs qui existent en stock/chute) — jamais de coupe en plein champ. Seule la
   * dernière lame comble jusqu'au mur (coupe au bord). Contrairement au glouton, le DP
   * regarde toute la rangée d'un coup : il obtient à la fois le milieu entier ET le meilleur
   * décalage, là où les approches gloutonnes sacrifiaient l'un pour l'autre.
   */
  const planRunDP = (
    runStart: number, runEnd: number, near: number[], far: number[], off: number,
    phase: number,
  ): number[] => {
    const T = runEnd - runStart;
    if (T < minCut) return T > tol ? [T] : [];
    const wholes = inventory.availableLengths(poseWidth).filter((l) => l >= minCut - 1e-6);
    if (!wholes.length) return [T]; // rien en stock : on comble d'un tenant
    const maxWhole = Math.max(...wholes); // la dernière lame doit être COUPABLE dans une lame
    // CONSCIENCE DES QUANTITÉS : le DP minimise le nombre de joints, donc préfère les lames
    // LES PLUS LONGUES — or ce sont souvent les plus rares (2 lames de 120 pour tout un
    // plancher). Il en planifiait plus qu'il n'en existe ; la passe d'affectation, à court de
    // 120, coupait alors une lame plus longue EN PLEIN MILIEU. On pénalise donc chaque
    // longueur à proportion de sa rareté : le DP étale l'usage vers les lames abondantes et
    // n'épuise plus le stock rare. Les chutes (réutilisables, la cascade) sont épargnées.
    const { counts, offcuts: offSet } = inventory.availableCounts(poseWidth);
    const scarcity = (L: number): number => {
      for (const o of offSet) if (Math.abs(o - L) <= tol) return 0; // chute : réemploi encouragé
      let n = 0;
      for (const [len, c] of counts) if (Math.abs(len - L) <= tol) n += c;
      if (n <= 0) return 0;
      return Math.min(40, 40 / n); // n=1→40, n=2→20, n=10→4, n=80→0,5
    };
    const key = (x: number) => Math.round(x * 10);
    // dp : position cumulée (un bord de lame) -> {coût mini, longueur de la lame qui y mène, x précédent}
    const dp = new Map<number, { cost: number; len: number; prev: number }>();
    dp.set(key(0), { cost: 0, len: 0, prev: -1 });
    const order = [0]; // positions à traiter, dans l'ordre croissant
    let best: { cost: number; end: number } | null = null;

    // STARTER COUPÉ EN CASCADE (règle du métier, NF DTU 51.11 « coupe perdue ») : le premier
    // morceau de la rangée peut être une COUPE (pas une lame entière), pour décaler le premier
    // joint là où aucune combinaison de lames entières ne le permet — typiquement un stock
    // uniforme (que des 120), où toute rangée en lames pleines s'aligne fatalement. Le bout
    // coupé n'est pas perdu : la passe d'affectation le sert depuis le pool de chutes (le reste
    // du bout de la rangée précédente). C'est la SEULE façon de décaler SANS couper au milieu.
    const STARTER_CUT = 22; // coût modéré : starter bien placé bat une lame pleine alignée
    const starterCands = (): number[] => {
      if (!Number.isFinite(off)) return [];
      const smax = Math.min(maxWhole, T - minCut);
      const cand = new Set<number>();
      for (const j of near) {
        for (const s of [j - runStart + off, j - runStart - off]) {
          if (s >= minCut - 1e-6 && s <= smax + 1e-6) cand.add(Math.round(s * 10) / 10);
        }
      }
      if (!near.length) {
        const s = minCut + (phase % Math.max(1, Math.round(smax - minCut)));
        if (s >= minCut - 1e-6 && s <= smax + 1e-6) cand.add(Math.round(s * 10) / 10);
      }
      // Jamais une longueur de stock (ce serait une lame pleine, déjà couverte par le milieu).
      return [...cand].filter((s) => !wholes.some((l) => Math.abs(l - s) <= tol));
    };
    for (let qi = 0; qi < order.length && qi < 20000; qi++) {
      const x = order[qi];
      const node = dp.get(key(x));
      if (!node) continue;
      const rem = T - x;
      // TERMINAISON : la dernière lame comble de x jusqu'au mur (rem). Coupe au bord, ou
      // lame entière si rem tombe pile sur une longueur stock. Pas de joint (mur).
      // rem DOIT être coupable dans une seule lame (≤ maxWhole) : sinon on terminerait avec
      // une lame de 340 cm impossible, et le placement se rabattrait sur un remplissage
      // glouton non décalé (c'était la cause des joints alignés du DP).
      if ((rem >= minCut - 1e-6 && rem <= maxWhole + tol) || rem <= tol) {
        const closeCut = wholes.some((l) => Math.abs(l - rem) <= tol) ? 0 : 30; // préférer fermer entier
        const total = node.cost + closeCut;
        if (!best || total < best.cost) best = { cost: total, end: x };
      }
      // DÉPART DE RANGÉE : en plus des lames entières, on autorise un STARTER COUPÉ (première
      // lame non entière) pour décaler le premier joint là où les lames pleines s'alignent.
      if (x === 0) {
        for (const s of starterCands()) {
          const after = rem - s;
          if (after > tol && after < minCut - 1e-6) continue;
          const nx = s + jointGap;
          if (nx > T + tol) continue;
          const jc = after <= tol ? 0 : jointCost(runStart + s, near, far, off, phase);
          const nc = node.cost + jc + STARTER_CUT;
          const k = key(nx);
          const cur = dp.get(k);
          if (!cur || nc < cur.cost) {
            if (!cur) order.push(nx);
            dp.set(k, { cost: nc, len: s, prev: x });
          }
        }
      }
      // MILIEU : poser une lame ENTIÈRE L, joint créé à runStart+x+L, il faut laisser un
      // reste posable (≥ minCut) OU fermer la plage (rem-L ≤ tol → traité en terminaison).
      for (const L of wholes) {
        const after = rem - L;
        if (L > rem + tol) continue;
        if (after > tol && after < minCut - 1e-6) continue; // laisserait un talon inposable
        const nx = x + L + jointGap;
        if (nx > T + tol) continue;
        const jc = after <= tol ? 0 : jointCost(runStart + x + L, near, far, off, phase); // ferme => pas de joint
        const nc = node.cost + jc + scarcity(L);
        const k = key(nx);
        const cur = dp.get(k);
        if (!cur || nc < cur.cost) {
          if (!cur) order.push(nx);
          dp.set(k, { cost: nc, len: L, prev: x });
        }
      }
    }
    if (!best) return [T];
    // Reconstruction depuis le meilleur point de terminaison.
    const lens: number[] = [];
    let x = best.end;
    const rem = T - x;
    if (rem > tol) lens.push(rem); // dernière lame (coupe au bord ou entière)
    while (x > tol) {
      const node = dp.get(key(x));
      if (!node || node.prev < 0) break;
      lens.push(node.len);
      x = node.prev;
    }
    lens.reverse();
    return lens.filter((l) => l > tol);
  };

  /** Note une plage découpée : plus c'est haut, meilleur c'est. */
  const scoreRun = (
    runStart: number, runEnd: number, lens: number[], near: number[], far: number[],
    prevDrift: number, startsOnOffcut: boolean, off: number,
  ): { score: number; violations: number; minGap: number } => {
    let s = 0;
    let violations = 0;
    let minGap = Infinity;
    let x = runStart;
    let lastDrift = prevDrift;
    for (let i = 0; i < lens.length; i++) {
      const end = x + lens[i];
      const closes = runEnd - end <= tol;
      if (!closes) {
        const dN = gapTo(x, lens[i], near);
        const dF = gapTo(x, lens[i], far);
        // Faute sur la voisine immédiate : c'est la règle, elle domine tout le reste.
        if (Number.isFinite(dN)) minGap = Math.min(minGap, dN);
        if (dN < off - 1e-6) { violations++; s -= 1000 + (off - dN) * 20; }
        else s += Math.min(dN, off * 1.5) * 2;
        if (dF < H_JOINT_MIN - 1e-6) s -= 200; // joint en « H »
        // Escalier : même décalage, même sens, d'une rangée à l'autre.
        const d = signedGapTo(x, lens[i], near);
        if (Number.isFinite(d) && Number.isFinite(lastDrift)
          && Math.abs(d - lastDrift) < 4 && Math.abs(d) > 5) s -= 120;
        if (Number.isFinite(d)) lastDrift = d;
      }
      // Un bout plus court que la coupe minimale n'est pas posable.
      if (lens[i] < minCut - 1e-6 && !closes) s -= 400;
      x = end + jointGap;
    }
    // Démarrer la rangée sur une chute est la règle du métier (Pergo : « start new rows
    // with pieces trimmed from previous row »), mais elle reste une PRÉFÉRENCE : imposée,
    // elle recrée un escalier quand toutes les lames se valent.
    if (startsOnOffcut) s += 40;
    // Moins de joints = plus facile à écarter ET plus beau : une plage tenue par 2 lames
    // vaut mieux que la même tenue par 5. Décisif avec un stock de lames courtes.
    s -= lens.length * JOINT_PENALTY;
    return { score: s, violations, minGap };
  };

  const planRow = (rowTop: number) => {
    const rowBottom = Math.min(rowTop + poseWidth, bb.maxY);
    // Rangées voisines immédiates (contrainte dure) et suivantes (simple préférence) :
    // des joints alignés à deux rangées d'écart se voient encore, en escalier.
    const near = [
      ...(jointsByRow.get(rowKey(rowTop - rowStep)) ?? []),
      ...(jointsByRow.get(rowKey(rowTop + rowStep)) ?? []),
    ];
    const far = [
      ...(jointsByRow.get(rowKey(rowTop - 2 * rowStep)) ?? []),
      ...(jointsByRow.get(rowKey(rowTop + 2 * rowStep)) ?? []),
    ];
    const joints: number[] = [];
    const drifts: number[] = [];
    // La dérive se lit sur la voisine RÉELLEMENT tracée, des deux côtés — comme `near`.
    // Elle n'était lue qu'en `rowTop - rowStep` : or avec une ligne de départ, la passe
    // `up()` remonte en y décroissant, sa voisine déjà tracée est de l'autre côté.
    // `prevDrift` valait donc `Infinity` sur TOUTE la moitié `up()`, et les gardes
    // `Number.isFinite(prevDrift)` y désarmaient silencieusement l'anti-escalier : la
    // moitié du plancher était calepinée sans aucune protection contre l'alignement.
    const avoidPlanks = config.avoidSamePlank === false ? undefined : new Set<number>([
      ...(plankNosByRow.get(rowKey(rowTop - rowStep)) ?? []),
      ...(plankNosByRow.get(rowKey(rowTop + rowStep)) ?? []),
    ]);
    const rowPlanks = new Set<number>();
    const prevDrift = driftByRow.get(rowKey(rowTop - rowStep))
      ?? driftByRow.get(rowKey(rowTop + rowStep))
      ?? Infinity;
    // Phase de rangée : biais faible qui varie d'une rangée à l'autre (17 coprime à 47),
    // pour casser la symétrie du DP déterministe (rangées identiques → bande alignée).
    const phase = ((rowKey(rowTop) * 17) % PHASE_PERIOD + PHASE_PERIOD) % PHASE_PERIOD;

    // Plages de matière CONTINUE de la rangée ENTIÈRE, calculées une fois.
    //
    // Elles étaient calculées case par case (une case = une longueur nominale) : `run.end`
    // ne dépassait donc jamais le bout de la CASE, et `rowMaxX` — censé être le mur du
    // fond — valait la fin de la case courante. Or un joint n'était enregistré que si
    // `endX < rowMaxX`, condition FAUSSE pour toute lame qui remplissait sa case. Aucun
    // joint n'était donc mémorisé, `near` restait vide, et la contrainte de décalage ne
    // s'appliquait jamais : avec un stock uniforme, toutes les rangées sortaient
    // identiques. C'est la cause racine des joints alignés.
    const band: Point[] = [
      { x: bb.minX, y: rowTop }, { x: bb.maxX, y: rowTop },
      { x: bb.maxX, y: rowBottom }, { x: bb.minX, y: rowBottom },
    ];
    const runs = mergeRuns(clipRectToRoom(band, clipper), jointGap);

    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];

      // On présente la plage à sec plusieurs fois avant de « clouer » : chaque essai tire
      // ses départages au hasard, on note la plage ENTIÈRE et on garde la meilleure. Le
      // glouton, lui, ne revenait jamais sur son premier choix.
      const { offcuts } = inventory.availableCounts(poseWidth);

      // TOUJOURS POSABLE, ET LE MIEUX POSSIBLE.
      //
      // Le décalage demandé n'est pas toujours atteignable : une plage de 304 cm tenue par
      // 5 lames de 60-90 porte 4 joints, et 4 joints voisins interdisent chacun ±30 cm,
      // soit 240 cm d'exclusion sur 304 cm utiles. Aucun découpage ne satisfait la règle.
      // Refuser n'a aucun sens — le parquet doit être posé.
      //
      // On ne baisse PAS la cible pour autant : abaisser le seuil dès qu'il coince a été
      // essayé et mesuré, et c'est pire (11,3 % de joints sous la valeur demandée contre
      // 5,2 %) — toute la rangée se rabat sur le seuil dégradé, y compris là où le décalage
      // demandé passait. On garde donc la cible et on classe les découpages par : d'abord
      // SOLVEUR DP : déterministe, il trouve directement la meilleure séquence de lames
      // ENTIÈRES au milieu (coupe seulement en RIVE — début et fin de rangée). Plus de
      // tirages aléatoires, plus de `repairRun` (qui recoupait au milieu). Le DP regarde
      // toute la plage d'un coup : il obtient le décalage ET les coupes en rive à la fois.
      const bestLens = planRunDP(run.start, run.end, near, far, minOffset, phase);
      if (!bestLens.length) continue;
      // On relève l'écart minimal réellement obtenu, pour pouvoir dire ce qu'on a tenu.
      const bestGap = scoreRun(
        run.start, run.end, bestLens, near, far, prevDrift, offcuts.has(bestLens[0]), minOffset,
      ).minGap;
      if (Number.isFinite(bestGap) && bestGap > 0) achievedGaps.push(bestGap);

      let x = run.start;
      // On boucle jusqu'à COUVRIR la plage, pas jusqu'à épuiser le découpage prévu.
      //
      // La simulation raisonne sur une copie du stock ; à la pose, `request` peut fournir
      // moins que demandé (chute plus courte, lot épuisé). Le découpage prévu se décale
      // alors et la plage se terminait AVANT le mur : il restait un vrai trou de plusieurs
      // centimètres contre le mur du fond. Un calepinage ne doit jamais laisser un vide
      // qu'il faudra combler au chantier — au-delà du découpage prévu, on continue avec ce
      // que le stock permet.
      let li = 0;
      let guard = 0;
      // On couvre jusqu'au BORD DU CHAMP (1e-3), pas `tol` avant : s'arrêter à `run.end - tol`
      // laissait un JEU AU MUR de la taille de `cutTolerance` (jusqu'à 3 cm), par-dessus le
      // jeu de dilatation. `cutTolerance` est un débordement toléré, jamais un vide.
      while (x < run.end - 1e-3 && guard++ < 5000) {
      const avail = run.end - x; // matière continue restante jusqu'au bout de la plage
      const planned = li < bestLens.length ? bestLens[li] : null;
      li++;
      const fallback = () => {
        const live = inventory.availableLengths(poseWidth); // décroissant
        // Mêmes règles que le choix normal : la lame ne dépasse pas la place restante, et
        // ne laisse pas un reliquat inposable. Sans ces gardes, le rattrapage bouchait le
        // trou en semant des bouts sous la coupe minimale.
        const ok = live.filter((l) => l <= avail + tol && (avail - l <= tol || avail - l >= minCut));
        if (ok.length) return ok[0];
        // Rien ne convient : on coupe pour couvrir la plage d'un seul tenant plutôt que de
        // laisser un vide — un trou contre le mur est pire qu'une coupe de plus.
        return Math.min(avail, Math.max(live[0] ?? avail, minCut));
      };
      let want = Math.min(planned ?? fallback(), avail);
      // Si ce qui resterait APRÈS cette lame est plus court que la coupe minimale, on
      // allonge cette lame jusqu'au mur au lieu de laisser un confetti derrière elle.
      // Sans ça, boucher le trou produisait des morceaux de 3 cm — aussi inposables que le
      // vide qu'ils comblaient.
      //
      // Le seuil bas est 1e-3, PAS `tol` : un reliquat sous la tolérance de coupe n'est PAS
      // « négligeable » — c'est un JEU AU MUR de la taille de `cutTolerance` (jusqu'à 3 cm),
      // par-dessus le jeu de dilatation déjà réservé. La sémantique de `cutTolerance` est un
      // DÉBORDEMENT (la lame trop longue mord sur la dilatation), jamais un vide. On absorbe
      // donc le reliquat dans cette lame : elle couvre jusqu'au bord du champ.
      if (avail - want > 1e-3 && avail - want < minCut) want = avail;
      // La simulation a raisonné sur une copie fidèle des quantités : la lame exacte doit
      // exister. Sinon on retombe sur `request`, qui coupera dans une plus longue.
      const cut = inventory.takeExact(want, poseWidth, avoidPlanks)
        ?? inventory.request(want, poseWidth, avoidPlanks);
      rowPlanks.add(cut.plankNo);

      let placedLen = Math.min(avail, cut.provided);
      // Le stock a pu fournir moins que demandé (chute plus courte, lot épuisé). Si le
      // reliquat qui suivrait était plus court que la coupe minimale, on RACCOURCIT cette
      // lame pour que la suivante fasse au moins `minCut` : mieux vaut deux lames franches
      // qu'une lame pleine suivie d'un confetti de 8 cm.
      const left = avail - placedLen;
      if (left > tol && left < minCut && avail >= 2 * minCut) {
        placedLen = Math.max(minCut, avail - minCut);
      }
      if (placedLen <= 1e-3) break;

      const placedRect: Point[] = [
        { x, y: rowTop }, { x: x + placedLen, y: rowTop },
        { x: x + placedLen, y: rowBottom }, { x, y: rowBottom },
      ];
      // Toujours reclipper : la lame est bornée à la matière continue, jamais à travers un trou.
      const placedPieces = clipRectToRoom(placedRect, clipper);
      // Ferme-t-elle la plage ? Si oui et qu'une autre plage suit, elle bute sur une
      // cloison : bord de coupe franc, et c'est un joint que les voisines doivent éviter.
      const closesRun = x + placedLen >= run.end - tol;
      const hitsCloison = closesRun && ri < runs.length - 1;

      if (placedPieces.length > 0) {
        planks.push({
          id: `p${idCounter++}`,
          plankNo: cut.plankNo,
          packId: cut.batchId.split(':')[0],
          packNo: 0, // renseigné par `layout`, seul à connaître l'ordre des paquets
          packPlankNo: cut.packPlankNo,
          pieceIndex: cut.pieceIndex,
          label: '',
          pieces: placedPieces.map((pc) => pc.map((p) => rotate(p, orientationDeg, origin))),
          rect: placedRect.map((p) => rotate(p, orientationDeg, origin)),
          angleDeg: orientationDeg,
          sourceBatchId: cut.batchId,
          texture: 'chene-clair',
          length: placedLen,
          width: poseWidth,
          // Les cotes utiles se mesurent sur la surface clipée : `layout` les renseigne.
          usedWidth: poseWidth,
          usedLength: placedLen,
          isRipped: false,
          isCut: cut.isCut || placedLen < cut.provided - 1e-6 || hitsCloison,
          isMissing: cut.isMissing,
          spaceIndex: 0, // renseigné par `layout` : le motif ne connaît qu'une pièce à la fois
          fromOffcut: cut.fromOffcut,
          grain: rotate({ x: 1, y: 0 }, orientationDeg, origin),
        });
      }

      const endX = x + placedLen;
      // Fin de lame = joint, SAUF quand elle ferme la plage : là, elle bute sur un mur ou
      // sur une cloison, la fibre s'arrête et rien ne se raccorde.
      if (!closesRun) {
        joints.push(endX);
        const d = signedGapTo(x, placedLen, near);
        if (Number.isFinite(d)) drifts.push(d);
      }
      x = endX + jointGap;
      }
    }

    jointsByRow.set(rowKey(rowTop), joints);
    plankNosByRow.set(rowKey(rowTop), rowPlanks);
    // Décalage dominant = médiane : une valeur isolée ne doit pas passer pour la tendance.
    if (drifts.length) {
      const sorted = drifts.slice().sort((a, b) => a - b);
      driftByRow.set(rowKey(rowTop), sorted[sorted.length >> 1]);
    }
  };

  /**
   * Largeur visible des deux rangées de RIVE pour une trame donnée.
   * Une rive de 0,7 cm ne se pose pas : elle casse à la scie et ne tient pas. La notice
   * Quick-Step exige « the width of the first and last row should be at least 5 cm ».
   */
  const edgeWidths = (origin: number): [number, number] => {
    const kTop = Math.floor((bb.minY - origin) / rowStep);
    const topY = origin + kTop * rowStep;
    const kBot = Math.floor((bb.maxY - origin) / rowStep);
    const botY = origin + kBot * rowStep;
    const top = Math.min(topY + poseWidth, bb.maxY) - bb.minY;
    const bot = bb.maxY - botY;
    // Une seule rangée couvre toute la pièce : pas de rive à équilibrer.
    if (kBot <= kTop) return [bb.maxY - bb.minY, bb.maxY - bb.minY];
    return [Math.min(top, poseWidth), Math.min(bot, poseWidth)];
  };

  const gapY = Math.max(0, config.expansionGap ?? 0);
  // Une rive est ACCEPTABLE si elle disparaît dans le jeu de dilatation (≤ gap, la lame
  // voisine va jusqu'au mur) OU si elle est assez large pour être posée (≥ minRipWidth).
  // Entre les deux, c'est la zone morte : trop grande pour être cachée (vide visible contre
  // le mur — le « 1,7 cm inacceptable »), trop petite pour être sciée proprement.
  const edgeOk = (w: number) => w <= gapY + 1e-6 || w >= (config.minRipWidth ?? 0) - 1e-6;

  /**
   * Décale la trame pour qu'AUCUNE rive ne tombe dans la zone morte. C'est le geste du
   * poseur : plutôt qu'un filet inposable contre un mur, on refend la rangée de rive pour
   * qu'elle ait une largeur franche (EGGER : « cut the first row so both the first and last
   * rows are of a similar width »).
   *
   * Faisabilité, pas esthétique : appliqué même sans `optimizeStart`, car un vide contre le
   * mur n'est jamais acceptable. On prend le PLUS PETIT décalage qui règle les deux rives —
   * la ligne de départ, posée délibérément par l'utilisateur, ne bouge que du strict
   * nécessaire. À décalage égal, `optimizeStart` préfère en plus des rives équilibrées.
   */
  const solveEdges = (origin: number): number => {
    if ((config.minRipWidth ?? 0) <= 0) return origin;
    const [t0, b0] = edgeWidths(origin);
    if (edgeOk(t0) && edgeOk(b0)) return origin; // déjà bon : on ne touche à rien
    let best: number | null = null;
    let bestScore = -Infinity;
    // Décalages par |d| croissant : le premier qui règle les deux rives gagne (sauf
    // `optimizeStart`, qui continue à |d| égal pour équilibrer).
    for (let step = 0; step <= rowStep + 1e-6; step += 0.1) {
      for (const d of step === 0 ? [0] : [step, -step]) {
        const [t, b] = edgeWidths(origin + d);
        if (!edgeOk(t) || !edgeOk(b)) continue;
        // Moins on décale, mieux c'est ; à décalage égal et si optimizeStart, rives égales.
        const score = -Math.abs(d) * 10 + (optimizeStart ? Math.min(t, b) : 0);
        if (score > bestScore) { bestScore = score; best = origin + d; }
      }
      // Sans optimizeStart, le premier |d| qui marche suffit : inutile d'aller plus loin.
      if (best != null && !optimizeStart) break;
    }
    return best ?? origin;
  };

  if (startLineY != null) {
    // Ligne de départ : rangées des deux côtés. L'ordre = ordre de pose (numérotation
    // radiale). `startFlip` choisit par quel côté on commence.
    // La trame était ancrée telle quelle sur la ligne de départ : la dernière rangée
    // recevait ce qui restait, fût-ce un filet inposable écarté ensuite → vide contre le
    // mur. On la recale pour qu'aucune rive ne tombe dans la zone morte.
    const base = solveEdges(startLineY);
    const down = () => { for (let y = base; y < bb.maxY; y += rowStep) planRow(y); };
    const up = () => { for (let y = base - rowStep; y + poseWidth > bb.minY; y -= rowStep) planRow(y); };
    if (config.startFlip) { up(); down(); } else { down(); up(); }
  } else {
    // Rive équilibrée (haut/bas de largeur égale).
    let startY = bb.minY;
    if (optimizeStart) {
      const span = bb.maxY - bb.minY;
      const nFull = Math.floor(span / rowStep);
      const rem = span - nFull * rowStep;
      if (rem > 1e-3 && nFull >= 1) startY = bb.minY - (rowStep - (rowStep + rem) / 2);
    }
    startY = solveEdges(startY); // filet de sécurité : jamais de rive dans la zone morte
    for (let y = startY; y < bb.maxY; y += rowStep) planRow(y);
  }

  return planks;
}
