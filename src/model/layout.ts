import type {
  LayoutConfig, LayoutResult, PackSheet, PlankBatch, PlacedPlank, Point, Room,
} from './types';
import { Inventory } from './inventory';
import { getPattern } from './patterns';
import {
  makeRoomClipper, offsetPolygon, pointInPolygon, polygonArea, polygonBBox, rotate,
} from './geometry';
import { detectSpaces } from './spaces';

/** Largeur de pose : celle du lot ayant le plus grand stock total. */
export function dominantWidth(batches: PlankBatch[]): number {
  const byWidth = new Map<number, number>();
  for (const b of batches) byWidth.set(b.width, (byWidth.get(b.width) ?? 0) + b.quantity);
  let best = batches[0]?.width ?? 20;
  let bestQty = -1;
  for (const [w, q] of byWidth) if (q > bestQty) { bestQty = q; best = w; }
  return best;
}

/** Longueur nominale : la plus grande longueur disponible pour la largeur de pose. */
function nominalLength(batches: PlankBatch[], width: number): number {
  const same = batches.filter((b) => Math.abs(b.width - width) <= 0.5);
  return same.reduce((m, b) => Math.max(m, b.length), 0) || 120;
}

/**
 * Décalage des joints RÉELLEMENT obtenu, relevé sur les lames posées.
 *
 * Mesuré ici plutôt que dans le motif : c'est vrai pour n'importe quel motif, et c'est
 * l'information dont l'utilisateur a besoin — le décalage demandé n'est pas toujours
 * atteignable (stock de lames courtes = beaucoup de joints par rangée), et un plan
 * silencieusement dégradé est pire qu'un plan qui annonce ce qu'il tient.
 */
function staggerStats(placed: PlacedPlank[], orientationDeg: number, target: number, width: number) {
  const a = (-orientationDeg * Math.PI) / 180;
  const un = (p: Point) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
  const rows = new Map<string, { x0: number; x1: number }[]>();
  for (const pl of placed) {
    const r = pl.rect.map(un);
    const ys = r.map((p) => p.y), xs = r.map((p) => p.x);
    const key = `${pl.spaceIndex}|${(Math.round(Math.min(...ys) * 10) / 10).toFixed(1)}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push({ x0: Math.min(...xs), x1: Math.max(...xs) });
  }
  const keys = [...rows.keys()].sort((k1, k2) => {
    const [s1, y1] = k1.split('|'), [s2, y2] = k2.split('|');
    return s1 === s2 ? parseFloat(y1) - parseFloat(y2) : +s1 - +s2;
  });
  // Une fin de lame n'est un JOINT que si une autre lame reprend juste après : contre un
  // mur ou une cloison, la matière s'arrête, rien ne se raccorde.
  const jointsOf = (segs: { x0: number; x1: number }[]) =>
    segs.filter((s) => segs.some((o) => o !== s && Math.abs(o.x0 - s.x1) < 1.5)).map((s) => s.x1);

  const gaps: number[] = [];
  for (let i = 1; i < keys.length; i++) {
    const [sp, y] = keys[i].split('|'), [ps, py] = keys[i - 1].split('|');
    // Rangées d'une même pièce et réellement contiguës, sinon la comparaison n'a pas de sens.
    if (sp !== ps || Math.abs(parseFloat(y) - parseFloat(py)) > width + 0.6) continue;
    const prev = jointsOf(rows.get(keys[i - 1])!);
    if (!prev.length) continue;
    for (const j of jointsOf(rows.get(keys[i])!)) {
      gaps.push(Math.min(...prev.map((k) => Math.abs(j - k))));
    }
  }
  gaps.sort((p, q) => p - q);
  return {
    min: gaps.length ? +gaps[0].toFixed(1) : 0,
    median: gaps.length ? +gaps[gaps.length >> 1].toFixed(1) : 0,
    below: gaps.filter((g) => g < target - 0.01).length,
    total: gaps.length,
    target,
    recommended: Math.round(2 * width),
  };
}

export function computeLayout(room: Room, batches: PlankBatch[], config: LayoutConfig): LayoutResult {
  const empty: LayoutResult = {
    placed: [],
    packSheets: [],
    spaces: [],
    stats: {
      spaces: [], excludedAreaM2: 0, roomAreaM2: 0, laidAreaM2: 0, planksPlaced: 0, newPlanksUsed: 0,
      offcutsReused: 0, cuts: 0, ripCuts: 0, droppedSlivers: 0, minRipWidth: 0,
      missingPlanks: 0, wasteAreaM2: 0, wastePct: 0,
      batchUsage: [], shortage: [],
      perimeterM: 0, doorCount: 0, plintheM: 0, partitionM: 0,
      stagger: { min: 0, median: 0, below: 0, total: 0, target: 0, recommended: 0 },
    },
    cutList: [],
  };
  if (room.points.length < 3 || batches.length === 0) return empty;

  const poseWidth = dominantWidth(batches);
  const nominal = nominalLength(batches, poseWidth);

  // Le tracé EST le nu intérieur des murs : un mur dessiné à 300 cm fait 300 cm dans la
  // pièce, l'épaisseur pousse vers l'extérieur. Le sol est donc le tracé lui-même ; seule
  // la dilatation périmétrique le rétrécit.
  const gap = config.expansionGap ?? 0;
  const floorPoly = room.points;
  const layPoly = gap > 0 ? offsetPolygon(room.points, gap) : room.points;

  // Repère de pose commun (tourné de -orientation autour du centre du logement) : la trame
  // reste alignée d'une pièce à l'autre, mais chaque pièce est posée pour elle-même.
  const bb = polygonBBox(layPoly);
  const center: Point = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  const toPose = (p: Point): Point => {
    const r = rotate(p, -config.orientationDeg, center);
    return { x: r.x - center.x, y: r.y - center.y };
  };
  // Les cloisons découpent le logement en pièces fermées. Chacune est calepinée seule :
  // une lame ne peut pas courir sous une cloison ni passer d'une pièce à l'autre.
  const spaces = detectSpaces(room, config.exteriorWallThickness ?? 0);

  const inventory = new Inventory(
    batches, config.reuseOffcuts, config.minCutLength, config.jointGap,
    config.mixPacks, config.preferShort,
  );
  const pattern = getPattern(config.patternId);
  const startPoseY = config.startLine ? toPose(config.startLine).y : undefined;

  // Un stock unique pour tout le chantier : les chutes d'une pièce servent à la suivante.
  const placedCentered: (PlacedPlank & { spaceIndex: number })[] = [];
  for (const space of spaces) {
    if (space.excluded) continue; // pièce non parquetée : aucune lame, aucun stock consommé
    // Le jeu de dilatation s'applique à chaque pièce : les lames s'arrêtent avant la cloison.
    const lay = gap > 0 ? offsetPolygon(space.outer, gap) : space.outer;
    if (lay.length < 3) continue;
    const spaceHoles = space.holes.map((h) => (gap > 0 ? offsetPolygon(h, -gap) : h));
    const clipper = makeRoomClipper(lay.map(toPose), spaceHoles.map((h) => h.map(toPose)));

    // La ligne de départ ne vaut que pour la pièce qui la contient ; les autres partent
    // de leur propre rive optimisée.
    const inSpace = config.startLine != null && pointInPolygon(config.startLine, space.outer);

    const planks = pattern.generate({
      clipper,
      config,
      inventory,
      poseWidth,
      nominalLength: nominal,
      optimizeStart: config.optimizeStart,
      startLineY: inSpace ? startPoseY : undefined,
    });
    for (const pl of planks) placedCentered.push({ ...pl, spaceIndex: space.index });
  }

  const batchTexture = new Map(batches.map((b) => [b.id, b.texture] as const));
  const shift = (p: Point): Point => ({ x: p.x + center.x, y: p.y + center.y });
  // Compte les morceaux par lame physique pour décider du suffixe (A/B/C).
  const piecesPerPlank = new Map<number, number>();
  for (const pl of placedCentered) {
    if (pl.plankNo > 0) piecesPerPlank.set(pl.plankNo, (piecesPerPlank.get(pl.plankNo) ?? 0) + 1);
  }
  // Numéro d'ordre de chaque paquet : c'est ce qui figure sur le plan et sur les lames.
  const packNoById = new Map<string, number>();
  for (const b of batches) {
    const packId = b.id.split(':')[0];
    if (!packNoById.has(packId)) packNoById.set(packId, packNoById.size + 1);
  }

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  /**
   * Codification chantier : « paquet · lame ». La lame 7 du paquet 2 s'écrit « 2·7 »,
   * et ses morceaux « 2·7A » / « 2·7B ». C'est exactement ce que l'utilisateur inscrit
   * sur ses lames en ouvrant les paquets.
   */
  const labelFor = (packNo: number, packPlankNo: number, plankNo: number, pieceIndex: number) => {
    if (packPlankNo <= 0) return '?'; // lame à acheter : elle n'a pas encore de numéro
    if (plankNo <= 0) return '';
    const multi = (piecesPerPlank.get(plankNo) ?? 1) > 1;
    const base = `${packNo}·${packPlankNo}`;
    return multi ? `${base}${LETTERS[pieceIndex] ?? pieceIndex + 1}` : base;
  };

  // En deçà de la largeur nominale (tolérance déduite), la lame doit être refendue.
  const ripTol = Math.max(0, config.cutTolerance ?? 0);

  /** Longueur réellement occupée : étendue de la surface clipée DANS le sens du grain. */
  const usedLengthOf = (pl: PlacedPlank): number => {
    let min = Infinity, max = -Infinity;
    for (const pc of pl.pieces)
      for (const p of pc) {
        const u = p.x * pl.grain.x + p.y * pl.grain.y;
        if (u < min) min = u;
        if (u > max) max = u;
      }
    return Number.isFinite(min) ? max - min : 0;
  };

  // Un filet de quelques millimètres de large ne se pose pas : il casse à la scie, et
  // aucun poseur ne le taillerait. En bord de pièce il disparaît sous la plinthe et dans le
  // jeu de dilatation ; ailleurs, l'annoncer sur le plan revient à demander l'impossible.
  // On l'écarte donc du calepinage plutôt que de le facturer et de le dessiner.
  const minRip = Math.max(0, config.minRipWidth ?? 0);
  const skinny = (pl: (typeof placedCentered)[number]) => {
    if (minRip <= 0) return false;
    const len = Math.min(pl.length, usedLengthOf(pl));
    if (len <= 1e-3) return true;
    const area = pl.pieces.reduce((s, pc) => s + polygonArea(pc), 0);
    return Math.min(pl.width, area / len) < minRip - 1e-6;
  };
  const droppedSlivers = placedCentered.filter(skinny).length;

  const placed: PlacedPlank[] = placedCentered.filter((pl) => !skinny(pl)).map((pl) => {
    const usedLength = Math.min(pl.length, usedLengthOf(pl));
    const packNo = packNoById.get(pl.packId) ?? 0;
    const visibleArea = pl.pieces.reduce((s, pc) => s + polygonArea(pc), 0);
    // Largeur réellement conservée = aire visible / longueur. Contrairement à l'étendue
    // maximale, ce ratio « voit » les encoches : une lame qui longe une cloison sur une
    // partie de sa longueur a une largeur moyenne < largeur nominale -> refend détecté.
    const clipped = usedLength > 1e-3 ? Math.min(pl.width, visibleArea / usedLength) : pl.width;
    const isRipped = clipped < pl.width - ripTol;
    // Une lame dont la surface visible est plus petite que son rectangle (encoche autour
    // d'un îlot, d'un angle de cloison) est bel et bien découpée, même à cote « pleine ».
    const notched = visibleArea < pl.length * pl.width - Math.max(2, pl.width) - 1e-3;
    return {
      ...pl,
      packNo,
      usedLength: +usedLength.toFixed(1),
      label: labelFor(packNo, pl.packPlankNo, pl.plankNo, pl.pieceIndex),
      pieces: pl.pieces.map((pc) => pc.map(shift)),
      rect: pl.rect.map(shift),
      texture: batchTexture.get(pl.sourceBatchId) ?? pl.texture,
      // Non refendue = lame pleine : on n'annonce pas une largeur rognée de quelques
      // millimètres que personne ne scie.
      usedWidth: isRipped ? clipped : pl.width,
      isRipped,
      isCut: pl.isCut || isRipped || notched,
    };
  });
  const ripCuts = placed.filter((pl) => pl.isRipped).length;
  const missingPlanks = placed.filter((pl) => pl.isMissing).length;

  // Statistiques.
  let laidCm2 = 0;
  for (const pl of placed) for (const pc of pl.pieces) laidCm2 += polygonArea(pc);
  const usage = inventory.usage();
  const newPlanksUsed = usage.reduce((s, u) => s + u.used, 0);
  const stockAreaCm2 = usage.reduce((s, u) => {
    const b = batches.find((x) => x.id === u.batchId);
    return s + (b ? u.used * b.length * b.width : 0);
  }, 0);
  const wasteCm2 = Math.max(0, stockAreaCm2 - laidCm2);

  const cm2ToM2 = (v: number) => v / 10000;

  // Métré : périmètre intérieur (sol), portes, plinthes (hors passages de porte).
  const pts = floorPoly;
  let perimeterCm = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    perimeterCm += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const doorsWidthCm = (room.doors ?? []).reduce((s, d) => s + d.width, 0);
  const plintheCm = Math.max(0, perimeterCm - doorsWidthCm);

  // Cloisons : longueur totale + emprise soustraite de la surface. L'emprise est recoupée
  // avec le sol : une cloison qui longe un mur (ou en déborde) ne doit pas retirer
  // deux fois la même surface.
  let partitionLenCm = 0;
  for (const w of room.partitions ?? []) {
    for (let i = 0; i < w.points.length - 1; i++) {
      const a = w.points[i], b = w.points[i + 1];
      partitionLenCm += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  // Surface nette : somme des pièces RÉELLEMENT parquetées. Le découpage a déjà retiré
  // l'emprise des cloisons, sans jamais compter deux fois la même surface.
  const roomAreaCm2 = spaces
    .filter((sp) => !sp.excluded)
    .reduce((s, sp) => s + sp.areaM2 * 10000, 0);
  const excludedAreaM2 = +spaces
    .filter((sp) => sp.excluded)
    .reduce((s, sp) => s + sp.areaM2, 0)
    .toFixed(3);
  const spaceStats = spaces.map((sp) => ({
    index: sp.index,
    name: sp.name,
    excluded: sp.excluded,
    areaM2: sp.areaM2,
    planks: placed.filter((pl) => pl.spaceIndex === sp.index).length,
  }));

  // Bordereau : pour chaque paquet entamé, les lames à en sortir dans l'ordre de numérotation.
  const sheets = new Map<string, PackSheet>();
  const seen = new Set<string>();
  for (const pl of placed) {
    const key = `${pl.packId}#${pl.packPlankNo}`;
    if (pl.packPlankNo <= 0 || seen.has(key)) continue; // un morceau B ne rouvre pas la lame
    seen.add(key);
    let sheet = sheets.get(pl.packId);
    if (!sheet) {
      sheet = { packNo: pl.packNo, packId: pl.packId, planks: [] };
      sheets.set(pl.packId, sheet);
    }
    const b = batches.find((x) => x.id === pl.sourceBatchId);
    sheet.planks.push({ no: pl.packPlankNo, length: b?.length ?? pl.length, width: pl.width });
  }
  const packSheets = [...sheets.values()].sort((a, b) => a.packNo - b.packNo);
  for (const sh of packSheets) sh.planks.sort((a, b) => a.no - b.no);

  return {
    placed,
    packSheets,
    spaces,
    stats: {
      spaces: spaceStats,
      excludedAreaM2,
      roomAreaM2: +cm2ToM2(roomAreaCm2).toFixed(3),
      laidAreaM2: +cm2ToM2(laidCm2).toFixed(3),
      planksPlaced: placed.length,
      newPlanksUsed,
      offcutsReused: inventory.offcutsReused,
      cuts: inventory.cuts,
      ripCuts,
      droppedSlivers,
      minRipWidth: placed.length
        ? +Math.min(...placed.map((pl) => pl.usedWidth)).toFixed(1) : 0,
      missingPlanks,
      wasteAreaM2: +cm2ToM2(wasteCm2).toFixed(3),
      wastePct: stockAreaCm2 > 0 ? +((wasteCm2 / stockAreaCm2) * 100).toFixed(1) : 0,
      batchUsage: usage,
      shortage: inventory.shortageList(),
      perimeterM: +(perimeterCm / 100).toFixed(2),
      doorCount: (room.doors ?? []).length,
      plintheM: +(plintheCm / 100).toFixed(2),
      partitionM: +(partitionLenCm / 100).toFixed(2),
      stagger: staggerStats(placed, config.orientationDeg, config.minJointOffset ?? 0, poseWidth),
    },
    cutList: placed
      .filter((pl) => pl.isCut || pl.isRipped)
      .map((pl, i) => ({
        index: i + 1,
        label: pl.label,
        packNo: pl.packNo,
        packPlankNo: pl.packPlankNo,
        batchId: pl.sourceBatchId,
        requestedLength: +pl.usedLength.toFixed(1),
        requestedWidth: +pl.usedWidth.toFixed(1),
        nominalWidth: pl.width,
        isRipped: pl.isRipped,
        isCut: pl.isCut,
        offcutLength: 0,
        fromOffcut: pl.fromOffcut,
      })),
  };
}
