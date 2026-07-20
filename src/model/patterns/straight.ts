import type { LayoutConfig, PlacedPlank, Point } from '../types';
import type { Inventory } from '../inventory';
import { clipRectToRoom, polygonBBox, rotate, type RoomClipper } from '../geometry';

/** RNG déterministe (mulberry32) pour le décalage aléatoire reproductible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  const { clipper, config, inventory, poseWidth, nominalLength, optimizeStart, startLineY } = input;
  const { jointGap, orientationDeg, seed } = config;

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
  /** Découpages tirés au sort par plage avant d'en retenir un. Réglé au banc de mesure. */
  const RUN_ATTEMPTS = 12;
  /** Essais supplémentaires sur une plage où la contrainte ne passe pas du premier coup. */
  const RUN_ATTEMPTS_HARD = 60;
  /** En deçà de cet écart, deux joints se lisent comme « côte à côte » : on répare. */
  const REPAIR_BELOW = 6; // retenu au banc : −82 % de joints collés pour +0,2 pt de fautes
  /**
   * Coût d'un joint de plus dans une plage. Moins de joints = décalage plus facile à tenir
   * ET rendu plus calme. Valeur retenue au banc (600 simulations) : meilleure sur tous les
   * indicateurs à la fois — fautes, chute et nombre de coupes.
   */
  const JOINT_PENALTY = 60;
  /** Écart réellement obtenu sur chaque plage, pour pouvoir dire ce qu'on a vraiment tenu. */
  const achievedGaps: number[] = [];
  /** Écart de note en deçà duquel deux longueurs sont jugées équivalentes (exploration). */
  const EXPLORE_MARGIN = 30;

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
  /**
   * `room` = ce qui tient dans la cellule courante (plafonné à la longueur nominale).
   * `avail` = matière CONTINUE restante jusqu'au bout de la plage (mur du fond ou cloison).
   * Le reste doit se juger sur `avail` : mesuré sur la cellule, il déclarait posable un
   * reliquat qui, une fois la rangée poursuivie, finissait en bout de 8 cm.
   */
  const chooseLength = (
    x: number, room: number, avail: number, near: number[], far: number[], prevDrift: number,
    live: number[], draw: () => number, off: number,
  ): number => {
    // `live` = longueurs disponibles dans la SIMULATION en cours, pas dans le stock réel :
    // une plage se planifie entièrement avant d'être posée, sinon on ne peut pas la noter.
    // Une lame ne peut pas dépasser la place restante ; et si elle laisse un reste plus
    // court que la coupe minimale, ce reste serait inposable — on l'écarte.
    const stock = live.filter((l) => {
      if (l < minCut || l > room + tol) return false;
      const rest = avail - l;
      return rest <= tol || rest >= minCut;
    });
    if (stock.length === 0) return room; // rien ne convient : on comble en coupant

    // Au-delà de ce seuil, un joint est « bien écarté » : inutile de chercher mieux, sinon
    // on n'utiliserait plus qu'une seule longueur et le calepinage deviendrait monotone.
    const enough = Math.max(off, 1) * 1.5;
    const score = (l: number) => {
      // La dernière lame bute sur le mur : sa fin n'est pas un joint, elle ne gêne personne.
      if (avail - l <= tol) return 5 + l * 0.05;

      const dNear = Math.min(gapTo(x, l, near), enough);
      const dFar = gapTo(x, l, far);
      // Un joint sous le décalage minimal est une faute : on la sanctionne lourdement.
      const fault = dNear < off - 1e-6 ? -1000 + dNear * 10 : dNear * 3;
      // Un joint aligné avec celui d'une rangée sur deux dessine un escalier régulier :
      // c'est le défaut qu'on voit le plus sur un plancher, il faut le casser aussi.
      const stair = dFar < 10 ? -300 + dFar * 4 : Math.min(dFar, enough);
      // ESCALIER. Prendre à chaque rangée le même décalage dans le même sens dessine des
      // marches régulières en travers du plancher : conforme à la règle du décalage
      // minimal, et pourtant proscrit (NWFA : « avoid blatant stair-steps or equal
      // end-joint offsets in sequential rows »). On sanctionne donc le décalage qui
      // REPRODUIT celui de la rangée précédente, signe compris.
      const drift = signedGapTo(x, l, near);
      const steps = Number.isFinite(prevDrift) && Number.isFinite(drift)
        && Math.abs(drift - prevDrift) < 4 && Math.abs(drift) > 5 ? -120 : 0;
      // Un soupçon d'aléa (déterministe : même graine, même plan) départage les longueurs
      // équivalentes. Sans lui, les mêmes choix reviennent et le calepinage se met à rimer.
      return fault + stair + steps + l * 0.05 + draw() * 4;
    };

    /**
     * Un choix glouton se piège lui-même : une première lame qui tombe bien peut ne laisser
     * AUCUNE longueur acceptable pour la suivante, et la rangée finit avec un joint fautif.
     * On regarde donc un cran plus loin — la lame retenue doit laisser une suite jouable.
     */
    // Anticipation d'UN cran. Deux crans ont été essayés et mesurés : aucun gain global
    // (5,6 % → 5,7 % de joints fautifs sur 120 simulations) pour davantage de chute. Le
    // blocage restant n'est pas là — voir DEV_NOTES.
    const leavesAWay = (l: number): boolean => {
      const rest = avail - l;
      if (rest <= tol) return true; // cette lame ferme la rangée : rien après elle
      const x2 = x + l + jointGap;
      return stock.some((l2) => {
        if (l2 > rest + tol) return false;
        if (rest - l2 > tol && rest - l2 < minCut) return false; // laisserait un bout inposable
        if (rest - l2 <= tol) return true; // l2 ferme la rangée contre le mur
        return gapTo(x2, l2, near) >= off - 1e-6;
      });
    };

    // On ne prend PAS systématiquement le meilleur : on tire au sort parmi les choix
    // quasi équivalents. Sans cette exploration, les essais successifs d'une même plage
    // redonnent tous le même découpage et la recherche locale ne cherche rien. La marge
    // reste bien inférieure à la pénalité de faute (−1000) : un choix fautif ne peut pas
    // entrer dans le tirage.
    const scored = stock.map((l) => ({ l, sc: score(l) + (leavesAWay(l) ? 0 : -500) }));
    const top = Math.max(...scored.map((c) => c.sc));
    const pool = scored.filter((c) => c.sc >= top - EXPLORE_MARGIN);
    return pool[Math.min(pool.length - 1, Math.floor(draw() * pool.length))].l;
  };

  /**
   * Dernier recours quand aucune lame du stock ne convient : on coupe pour écarter le joint,
   * mais jamais pour gagner trois centimètres — la coupe doit valoir le trait de scie.
   */
  const fixJoint = (
    x: number, len: number, maxLen: number, avail: number, neighbours: number[], second: number[],
    off: number,
  ): number => {
    if (off <= 0 || (neighbours.length === 0 && second.length === 0)) return len;
    // Joint en « H » : deux joints alignés de part et d'autre d'UNE rangée (n et n+2).
    // Absent du DTU mais explicitement proscrit par les guidelines NWFA (« avoid H
    // patterns »), avec ~10 cm de marge. `fixJoint` ne regardait que la voisine immédiate :
    // dès qu'elle était satisfaite il ne coupait plus, et la rangée reproduisait la n−2.
    const secondMin = Math.min(off, H_JOINT_MIN);
    // Une lame qui ferme la rangée bute sur le mur : sa fin n'est pas un joint, elle ne
    // gêne personne et n'a aucune raison d'être recoupée.
    const closesRow = (l: number) => avail - l <= tol;
    const hitsNear = (l: number) => !closesRow(l) && gapTo(x, l, neighbours) < off - 1e-6;
    const hitsSecond = (l: number) => !closesRow(l) && gapTo(x, l, second) < secondMin - 1e-6;
    if (!hitsNear(len) && !hitsSecond(len)) return len;

    // Chaque joint voisin interdit une plage de ±minOffset autour de lui. On cherche donc
    // la longueur autorisée la PLUS PROCHE de celle qu'on voulait, en testant les bords de
    // ces plages interdites — et pas seulement « pile à minOffset d'un joint », car un tel
    // point tombe souvent dans la plage interdite d'un AUTRE joint et se faisait éliminer,
    // ne laissant aucun candidat : la lame restait alors fautive.
    const cand = [len, minCut, maxLen];
    for (const j of neighbours) cand.push(j - off - x, j + off - x);
    for (const j of second) cand.push(j - secondMin - x, j + secondMin - x);
    const placeable = cand
      .map((l) => Math.round(l * 10) / 10) // au millimètre : pas de cote biscornue
      .filter((l) => {
        if (l < minCut - 1e-6 || l > maxLen + 1e-6) return false;
        // Le reste doit rester posable, sinon on déplace le problème sur la lame suivante.
        const rest = avail - l;
        return rest <= tol || rest >= minCut;
      })
      .sort((a, b) => Math.abs(a - len) - Math.abs(b - len));

    // Deux rangs de priorité, jamais mélangés : la voisine immédiate est une RÈGLE, la
    // rangée n±2 une PRÉFÉRENCE. Les traiter à égalité faisait sacrifier la première pour
    // satisfaire la seconde — on cassait l'appareil en brique en créant de vraies fautes.
    const both = placeable.filter((l) => !hitsNear(l) && !hitsSecond(l));
    if (both.length) return both[0];
    const nearOnly = placeable.filter((l) => !hitsNear(l));
    return nearOnly[0] ?? len;
  };

  /**
   * Découpage d'une plage entière, SIMULÉ sur une copie du stock.
   *
   * Le glouton décide lame par lame et ne revient jamais en arrière : sur une plage courte
   * — un couloir de 250 cm entre deux cloisons — le premier choix condamne la suite, et la
   * plage finit avec des joints collés à ceux de la rangée voisine. C'est là que se
   * concentraient les fautes restantes (55 % sur les plages de ~250 cm).
   *
   * On tire donc plusieurs découpages au sort, on NOTE la plage entière, et on garde la
   * meilleure : une recherche locale, comme le poseur qui présente sa rangée à sec avant
   * de clouer (le « racking » des guidelines NWFA). Rien n'est consommé ici — la simulation
   * travaille sur une copie des quantités, sinon elle réutiliserait dix fois la dernière
   * lame de 160.
   */
  const planRun = (
    runStart: number, runEnd: number, near: number[], far: number[], prevDrift: number,
    draw: () => number, off: number,
  ): number[] => {
    const { counts } = inventory.availableCounts(poseWidth);
    const stockLens = [...counts.keys()].sort((a, b) => b - a);
    const take = (l: number): void => {
      const n = counts.get(l) ?? 0;
      if (n > 0) { counts.set(l, n - 1); return; }
      // Pas cette cote en stock : on entame la plus courte lame qui la couvre, le reste
      // retourne au pool de chutes — exactement ce que fera `Inventory.request`.
      const src = stockLens.filter((s) => (counts.get(s) ?? 0) > 0 && s > l).pop();
      if (src == null) return;
      counts.set(src, (counts.get(src) ?? 0) - 1);
      const rest = src - l - jointGap;
      if (rest >= minCut) counts.set(rest, (counts.get(rest) ?? 0) + 1);
    };

    const out: number[] = [];
    let x = runStart;
    let guard = 0;
    // S'arrêter dans la TOLÉRANCE de coupe : un reliquat de 8 mm n'est pas une lame à
    // poser, c'est du bruit numérique. La boucle s'arrêtait à 1e-3, donc elle posait des
    // lames de 0,8 cm en bout de plage — invisibles comme lames, mais elles créaient un
    // faux joint collé à celui de la rangée voisine.
    while (x < runEnd - Math.max(tol, 1e-3) && guard++ < 5000) {
      const avail = runEnd - x;
      const live = [...counts.entries()].filter(([, n]) => n > 0).map(([l]) => l);
      const longest = live.length ? Math.max(...live) : nominalLength;
      const room = Math.min(avail, longest);
      const pick = chooseLength(x, room, avail, near, far, prevDrift, live, draw, off);
      const want = fixJoint(x, Math.min(pick, room), room, avail, near, far, off);
      const len = Math.min(avail, Math.max(want, Math.min(minCut, avail)));
      if (len <= 1e-3) break;
      take(len);
      out.push(len);
      x += len + jointGap;
    }
    // Talon plus court que la coupe minimale : on l'absorbe dans la lame précédente
    // plutôt que de le poser. Une lame de 8 mm ne se pose pas.
    while (out.length >= 2 && out[out.length - 1] < minCut - 1e-6) {
      const tail = out.pop() as number;
      out[out.length - 1] += tail + jointGap;
    }
    return out;
  };

  /**
   * RÉPARATION CIBLÉE d'une plage. Quand un joint reste trop près de la rangée voisine, on
   * ne retire pas au sort : on déplace CE joint, en rééquilibrant les deux lames qui
   * l'encadrent, vers la position qui maximise l'écart. Les tirages aléatoires laissaient
   * un joint à 0 cm là où un écart de 15 cm existait — parce qu'ils cherchaient partout au
   * lieu de corriger le point précis qui pose problème.
   */
  const repairRun = (
    runStart: number, runEnd: number, lens: number[], near: number[], off: number,
  ): number[] => {
    if (!near.length || lens.length < 2) return lens;
    const out = lens.slice();
    let x = runStart;
    for (let i = 0; i < out.length - 1; i++) {
      const jointX = x + out[i];
      // Une lame qui ferme la plage bute sur un mur : sa fin n'est pas un joint.
      if (runEnd - jointX <= tol) { x += out[i] + jointGap; continue; }
      // On ne répare QUE les joints vraiment collés. Corriger aussi ceux qui sont juste
      // sous la règle a été mesuré : le déplacement modifie la lame suivante, donc les
      // joints que la rangée d'après devra éviter, et l'ensemble se dégrade (5 % → 10 %
      // de joints sous la cible). Ici on ne vise que le défaut visible à l'œil.
      if (gapTo(x, out[i], near) >= REPAIR_BELOW - 1e-6) { x += out[i] + jointGap; continue; }

      // Les deux lames encadrantes couvrent une longueur fixe : on ne déplace QUE leur
      // frontière, donc rien en amont ni en aval n'est touché.
      const span = out[i] + jointGap + out[i + 1];
      let bestLen = out[i];
      let bestGap = gapTo(x, out[i], near);
      for (let c = minCut; c <= span - jointGap - minCut + 1e-6; c += 0.5) {
        const g = gapTo(x, c, near);
        if (g > bestGap + 1e-6) { bestGap = g; bestLen = Math.round(c * 10) / 10; }
        if (bestGap >= off) break; // inutile de chercher au-delà de la règle
      }
      out[i] = bestLen;
      out[i + 1] = span - jointGap - bestLen;
      x += out[i] + jointGap;
    }
    return out;
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
      // le moins de fautes, puis le PLUS GRAND écart minimal (max-min), puis la note. Là où
      // c'est faisable on obtient la valeur demandée ; là où ça ne l'est pas, on obtient le
      // meilleur écart possible, jamais un joint collé.
      let bestLens: number[] = [];
      let bestViol = Infinity;
      let bestGap = -Infinity;
      let bestScore = -Infinity;
      // Effort ADAPTATIF : 12 essais suffisent partout où la contrainte passe. Là où elle
      // coince, ils ne suffisent pas — et c'est exactement là que ça compte, car le plan
      // se rabattait alors sur un joint à 0 cm quand un joint à 15 existait. On insiste
      // donc uniquement sur les plages difficiles ; ailleurs on s'arrête tôt.
      let attempts = RUN_ATTEMPTS;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt === RUN_ATTEMPTS - 1 && bestViol > 0) attempts = RUN_ATTEMPTS_HARD;
        // Graine dérivée de la position : même plan pour la même graine de projet.
        const draw = mulberry32(seed + rowKey(rowTop) * 131 + ri * 17 + attempt * 7919);
        const lens = planRun(run.start, run.end, near, far, prevDrift, draw, minOffset);
        if (!lens.length) continue;
        const r = scoreRun(
          run.start, run.end, lens, near, far, prevDrift, offcuts.has(lens[0]), minOffset,
        );
        const better = r.violations < bestViol
          || (r.violations === bestViol && r.minGap > bestGap + 1e-6)
          || (r.violations === bestViol && Math.abs(r.minGap - bestGap) <= 1e-6 && r.score > bestScore);
        if (better) {
          bestViol = r.violations; bestGap = r.minGap; bestScore = r.score; bestLens = lens;
        }
      }
      if (!bestLens.length) continue;
      if (bestGap < REPAIR_BELOW) {
        // Il reste des joints trop proches : on les déplace un par un plutôt que de
        // relancer des tirages, qui cherchent partout sauf là où ça coince.
        const fixed = repairRun(run.start, run.end, bestLens, near, minOffset);
        const r = scoreRun(
          run.start, run.end, fixed, near, far, prevDrift, offcuts.has(fixed[0]), minOffset,
        );
        // On n'accepte la réparation que si elle N'AGGRAVE RIEN : déplacer un joint change
        // la lame suivante, donc le joint suivant. Sans cette garde, on supprimait un joint
        // collé en en créant deux autres juste sous la règle.
        if (r.violations <= bestViol && r.minGap > bestGap + 1e-6) {
          bestLens = fixed; bestViol = r.violations; bestGap = r.minGap;
        }
      }
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
      while (x < run.end - Math.max(tol, 1e-3) && guard++ < 5000) {
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
      if (avail - want > tol && avail - want < minCut) want = avail;
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
