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
  const { jointGap, offsetMode, orientationDeg, seed } = config;

  // BBox de la pièce dans le repère de pose.
  const allPts = clipper.convex ? clipper.poly : clipper.triangles.flat();
  if (allPts.length === 0) return [];
  const bb = polygonBBox(allPts);

  const rand = mulberry32(seed);
  const rowStep = poseWidth + jointGap;
  const planks: PlacedPlank[] = [];
  let idCounter = 0;
  const origin = { x: 0, y: 0 };

  // Centre les coupes de bord le long des lames.
  const lenSpan = bb.maxX - bb.minX;
  const lenPhase = optimizeStart ? (nominalLength - (lenSpan % nominalLength)) / 2 : 0;

  const shiftFor = (k: number) => {
    if (offsetMode === '1/2') return (((k % 2) + 2) % 2) * (nominalLength / 2);
    if (offsetMode === '1/3') return (((k % 3) + 3) % 3) * (nominalLength / 3);
    if (offsetMode === 'random') return rand() * nominalLength;
    return 0;
  };

  // --- Passe 1 : géométrie seule. On établit toutes les cellules et la longueur qu'il
  // faut y poser, sans toucher au stock : l'affectation des lames en dépendra, pas l'inverse.
  const tol = Math.max(0, config.cutTolerance ?? 0);
  const minCut = Math.max(0, config.minCutLength ?? 0);


  // Joints (fins de lame) de chaque rangée déjà tracée, pour tenir le décalage d'une
  // rangée à l'autre. La clé est la position de la rangée : les rangées ne sont pas
  // établies dans l'ordre spatial quand il y a une ligne de départ.
  const jointsByRow = new Map<number, number[]>();
  const rowKey = (y: number) => Math.round(y * 10);
  const minOffset = Math.max(0, config.minJointOffset ?? 0);

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
  const chooseLength = (x: number, room: number, avail: number, near: number[], far: number[]): number => {
    // Une lame ne peut pas dépasser la place restante ; et si elle laisse un reste plus
    // court que la coupe minimale, ce reste serait inposable — on l'écarte.
    const stock = inventory.availableLengths(poseWidth).filter((l) => {
      if (l < minCut || l > room + tol) return false;
      const rest = avail - l;
      return rest <= tol || rest >= minCut;
    });
    if (stock.length === 0) return room; // rien ne convient : on comble en coupant

    // Au-delà de ce seuil, un joint est « bien écarté » : inutile de chercher mieux, sinon
    // on n'utiliserait plus qu'une seule longueur et le calepinage deviendrait monotone.
    const enough = Math.max(minOffset, 1) * 1.5;
    const score = (l: number) => {
      // La dernière lame bute sur le mur : sa fin n'est pas un joint, elle ne gêne personne.
      if (avail - l <= tol) return 5 + l * 0.05;

      const dNear = Math.min(gapTo(x, l, near), enough);
      const dFar = gapTo(x, l, far);
      // Un joint sous le décalage minimal est une faute : on la sanctionne lourdement.
      const fault = dNear < minOffset - 1e-6 ? -1000 + dNear * 10 : dNear * 3;
      // Un joint aligné avec celui d'une rangée sur deux dessine un escalier régulier :
      // c'est le défaut qu'on voit le plus sur un plancher, il faut le casser aussi.
      const stair = dFar < 10 ? -60 + dFar * 4 : Math.min(dFar, enough);
      // Un soupçon d'aléa (déterministe : même graine, même plan) départage les longueurs
      // équivalentes. Sans lui, les mêmes choix reviennent et le calepinage se met à rimer.
      return fault + stair + l * 0.05 + rand() * 4;
    };

    /**
     * Un choix glouton se piège lui-même : une première lame qui tombe bien peut ne laisser
     * AUCUNE longueur acceptable pour la suivante, et la rangée finit avec un joint fautif.
     * On regarde donc un cran plus loin — la lame retenue doit laisser une suite jouable.
     */
    const leavesAWay = (l: number): boolean => {
      const rest = avail - l;
      if (rest <= tol) return true; // cette lame ferme la rangée : rien après elle
      const x2 = x + l + jointGap;
      return stock.some((l2) => {
        if (l2 > rest + tol) return false;
        if (rest - l2 > tol && rest - l2 < minCut) return false; // laisserait un bout inposable
        if (rest - l2 <= tol) return true; // l2 ferme la rangée contre le mur
        return gapTo(x2, l2, near) >= minOffset - 1e-6;
      });
    };

    let best = stock[0], bestScore = -Infinity;
    for (const l of stock) {
      const sc = score(l) + (leavesAWay(l) ? 0 : -500);
      if (sc > bestScore) { bestScore = sc; best = l; }
    }
    return best;
  };

  /**
   * Dernier recours quand aucune lame du stock ne convient : on coupe pour écarter le joint,
   * mais jamais pour gagner trois centimètres — la coupe doit valoir le trait de scie.
   */
  const fixJoint = (x: number, len: number, maxLen: number, avail: number, neighbours: number[]): number => {
    if (minOffset <= 0 || neighbours.length === 0) return len;
    // Une lame qui ferme la rangée bute sur le mur : sa fin n'est pas un joint, elle ne
    // gêne personne et n'a aucune raison d'être recoupée.
    const closesRow = (l: number) => avail - l <= tol;
    const clash = (l: number) => !closesRow(l) && gapTo(x, l, neighbours) < minOffset - 1e-6;
    if (!clash(len)) return len;

    // Chaque joint voisin interdit une plage de ±minOffset autour de lui. On cherche donc
    // la longueur autorisée la PLUS PROCHE de celle qu'on voulait, en testant les bords de
    // ces plages interdites — et pas seulement « pile à minOffset d'un joint », car un tel
    // point tombe souvent dans la plage interdite d'un AUTRE joint et se faisait éliminer,
    // ne laissant aucun candidat : la lame restait alors fautive.
    const cand = [len, minCut, maxLen];
    for (const j of neighbours) cand.push(j - minOffset - x, j + minOffset - x);
    const usable = cand
      .map((l) => Math.round(l * 10) / 10) // au millimètre : pas de cote biscornue
      .filter((l) => {
        if (l < minCut - 1e-6 || l > maxLen + 1e-6 || clash(l)) return false;
        // Le reste doit rester posable, sinon on déplace le problème sur la lame suivante.
        const rest = avail - l;
        return rest <= tol || rest >= minCut;
      })
      .sort((a, b) => Math.abs(a - len) - Math.abs(b - len));
    return usable[0] ?? len;
  };

  const planRow = (rowTop: number, k: number) => {
    const shift = shiftFor(k);
    let x = bb.minX - nominalLength + (shift % nominalLength) - lenPhase;
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

    let guard = 0;
    while (x < bb.maxX && guard++ < 5000) {
      const cellLen = nominalLength;
      const rect: Point[] = [
        { x, y: rowTop }, { x: x + cellLen, y: rowTop },
        { x: x + cellLen, y: rowBottom }, { x, y: rowBottom },
      ];
      const pieces = clipRectToRoom(rect, clipper);
      if (pieces.length === 0) { x += cellLen + jointGap; continue; }

      // Segments de matière CONTINUE dans la case, le long du grain. Une cloison (ou une
      // zone exclue) coupe la rangée : elle produit un trou. Une lame ne peut pas l'enjamber
      // — elle est coupée à la cloison, et une autre reprend de l'autre côté.
      const runs = mergeRuns(pieces, jointGap);
      const run = runs.find((r) => r.end > x + 1e-6);
      if (!run) { x += cellLen + jointGap; continue; }
      if (run.start > x + 1e-6) { x = run.start; continue; } // on démarre où la matière reprend

      const avail = Math.max(0, run.end - x); // matière continue restante dans la plage
      const room = Math.min(cellLen, avail); // ce qui tient dans la cellule courante
      if (room < 1e-3) { x += cellLen + jointGap; continue; }
      // La lame bute-t-elle sur une cloison (trou après) plutôt que sur le mur du fond ?
      const atCloison = run.end < bb.maxX - tol && runs.some((r) => r.start > run.end + tol);

      // On sort du stock la lame qu'on va POSER, tout de suite : la géométrie suit la lame
      // obtenue, et non l'inverse. Planifier d'abord puis affecter ensuite faisait diverger
      // les deux — joints imprévus, cases mal comblées, chutes de 9 cm.
      const rowMaxX = runs[runs.length - 1].end; // bout de matière de la rangée (mur du fond)
      const pick = chooseLength(x, room, avail, near, far);
      // `chooseLength` ne peut proposer que des longueurs EXISTANTES. Quand le stock est
      // à longueurs rondes (40…160), les joints retombent tous sur la même trame et il
      // arrive qu'AUCUNE lame entière ne respecte le décalage minimal. Il faut alors
      // couper — c'est ce que fait le poseur. `fixJoint` était placé derrière le `??`,
      // donc appelé seulement quand la lame entière manquait : exactement le cas où on
      // n'en avait pas besoin. Résultat : des joints alignés d'une rangée à l'autre.
      const want = fixJoint(x, Math.min(pick, room), room, avail, near);
      const cut = (Math.abs(want - pick) <= 1e-6 ? inventory.takeExact(pick, poseWidth) : null)
        ?? inventory.request(want, poseWidth);

      const placedLen = Math.min(room, cut.provided);
      if (placedLen <= 1e-3) { x += cellLen + jointGap; continue; }

      const placedRect: Point[] = [
        { x, y: rowTop }, { x: x + placedLen, y: rowTop },
        { x: x + placedLen, y: rowBottom }, { x, y: rowBottom },
      ];
      // Toujours reclipper : la lame est bornée à la matière continue, jamais à travers un trou.
      const placedPieces = clipRectToRoom(placedRect, clipper);
      // Coupée si raccourcie, OU si elle vient buter contre une cloison (bord de coupe franc).
      const hitsCloison = atCloison && placedLen >= room - tol;

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
      // Contre une cloison : la lame suivante reprend de l'autre côté du trou.
      x = hitsCloison ? (runs.find((r) => r.start > endX + tol)?.start ?? endX + jointGap) : endX + jointGap;
      // Fin de lame = joint, sauf contre le mur du fond de la rangée. La coupe contre une
      // cloison est un joint à part entière : les rangées voisines doivent l'éviter.
      if (endX < rowMaxX - tol) joints.push(endX);
    }

    jointsByRow.set(rowKey(rowTop), joints);
  };

  if (startLineY != null) {
    // Ligne de départ : rangées des deux côtés. L'ordre = ordre de pose (numérotation
    // radiale). `startFlip` choisit par quel côté on commence.
    const down = () => { let k = 0; for (let y = startLineY; y < bb.maxY; y += rowStep, k++) planRow(y, k); };
    const up = () => { let k = 1; for (let y = startLineY - rowStep; y + poseWidth > bb.minY; y -= rowStep, k++) planRow(y, -k); };
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
    let k = 0;
    for (let y = startY; y < bb.maxY; y += rowStep, k++) planRow(y, k);
  }

  return planks;
}
