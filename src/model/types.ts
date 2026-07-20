// Modèle de données du calepinage. Toutes les longueurs sont en centimètres.

export interface Point {
  x: number;
  y: number;
}

export type TextureId = 'chene-clair' | 'chene-moyen' | 'gris' | 'noyer-fonce';

/** Image de fond (plan importé) pour tracer par-dessus, avec échelle calibrable. */
export interface BgImage {
  dataUrl: string;
  imgW: number;
  imgH: number;
  /** Coin haut-gauche de l'image en cm (monde). */
  offset: Point;
  /** cm par pixel image (échelle). */
  scale: number;
  opacity: number;
}

/** Une pièce = un polygone fermé (liste de sommets, non répété). */
/** Une porte / ouverture, posée sur un mur du périmètre ou sur une cloison. */
export interface Door {
  id: string;
  /** Support : mur du périmètre, ou segment de cloison intérieure. */
  host: 'wall' | 'partition';
  /**
   * `wall` : index du mur (arête pts[edgeIndex] -> pts[edgeIndex+1]).
   * `partition` : index de la cloison dans `room.partitions`.
   */
  edgeIndex: number;
  /** `partition` uniquement : segment de la polyligne portant la porte. */
  segIndex: number;
  /** Position du centre le long du segment (0..1). */
  center: number;
  /** Largeur du passage (cm). */
  width: number;
  /** Côté du gond. */
  hinge: 'l' | 'r';
  /** Côté vers lequel le vantail s'ouvre (+1 / -1 le long de la normale du support). */
  swing: 1 | -1;
  /**
   * Le parquet traverse la baie au lieu de s'arrêter dessous (pas de barre de seuil).
   * Les deux pièces ne forment alors qu'une seule zone de pose : trame continue, lames
   * courant d'une pièce à l'autre. Sinon, chaque pièce est posée pour elle-même.
   */
  throughFloor: boolean;
}

/** Côté sur lequel l'épaisseur de la cloison est portée, vu depuis le sens du tracé. */
export type WallAlign = 'center' | 'left' | 'right';

/** Une cloison intérieure : polyligne avec épaisseur (placo…). */
export interface Partition {
  id: string;
  points: Point[];
  /** Épaisseur du mur (cm). */
  thickness: number;
  /**
   * Où poser l'épaisseur par rapport au tracé. `center` = à cheval (axe du mur) ;
   * `left`/`right` = le tracé est une FACE du mur, l'épaisseur part d'un seul côté —
   * c'est ce qu'on veut quand on longe un mur existant ou qu'on relève une pièce au nu.
   */
  align: WallAlign;
}

/** Une cote posée sur le plan (distance entre deux points, souvent deux murs). */
export interface Measure {
  id: string;
  a: Point;
  b: Point;
}

/**
 * Étiquette posée dans une pièce fermée : son nom, et si on y pose du parquet.
 * L'ancrage est un POINT, pas un index : les pièces sont redécoupées à chaque modification
 * des cloisons, un index ne survivrait pas. Le point, lui, reste dans sa pièce.
 */
export interface SpaceTag {
  id: string;
  point: Point;
  name: string;
  /** Pièce non parquetée (salle de bain carrelée, terrasse…) : ni pose, ni stock consommé. */
  excluded: boolean;
}

export interface Room {
  id: string;
  name: string;
  points: Point[];
  /** Nommage / exclusion des pièces détectées. */
  spaceTags: SpaceTag[];
  /** Zones exclues (trémie, îlot, cheminée) : polygones soustraits de la surface. */
  holes: Point[][];
  /** Portes / ouvertures posées sur les murs. */
  doors: Door[];
  /** Cloisons intérieures (emprise retirée du parquet). */
  partitions: Partition[];
}

/** Un lot de stock : `quantity` lames identiques de dimensions `length` × `width`. */
export interface PlankBatch {
  id: string;
  length: number;
  width: number;
  quantity: number;
  texture: TextureId;
  /**
   * Numéros des lames de ce lot, DANS leur paquet : ceux que l'utilisateur inscrit sur
   * ses lames. Le plan emploie exactement ces numéros, sinon la codification ne sert à rien.
   */
  numbers: number[];
}

/**
 * Une lame physique, unique. Son numéro est celui qu'on inscrit au crayon dessus en vidant
 * le paquet : deux lames d'un même paquet ne peuvent pas le partager.
 */
export interface Plank {
  id: string;
  /** Numéro DE LA lame, dans son paquet. */
  no: number;
  length: number;
  width: number;
  texture: TextureId;
}

/** Un paquet : un nom, et ses lames, une par une. */
export interface Pack {
  id: string;
  name: string;
  /** Largeur appliquée aux lames ajoutées (les lames de parquet ont presque toutes la même). */
  defaultWidth: number;
  planks: Plank[];
}

export type OffsetMode = '0' | '1/2' | '1/3' | 'random';

export interface LayoutConfig {
  patternId: string;
  /** Orientation de la trame de pose, en degrés (0 = lames horizontales). */
  orientationDeg: number;
  offsetMode: OffsetMode;
  /** Jeu entre lames (joint), en cm. */
  jointGap: number;
  /** Longueur minimale d'une coupe posée / d'une chute réutilisable (cm). */
  minCutLength: number;
  /**
   * Décalage minimal entre les joints de deux rangées voisines (cm). Règle de pose : des
   * joints alignés d'une rangée à l'autre sont laids et affaiblissent le plancher. 30 cm
   * est l'usage courant. 0 = aucune contrainte.
   */
  minJointOffset: number;
  reuseOffcuts: boolean;
  /**
   * Tolérance de coupe (cm) : en deçà, on ne coupe pas. Une lame à qui il ne manque que
   * quelques millimètres pour rentrer est posée pleine et mord d'autant sur le jeu de
   * dilatation — on ne passe pas une lame à la scie pour 8 mm.
   */
  cutTolerance: number;
  /**
   * Utilise toutes les longueurs du paquet : une lame courte est posée entière plutôt que
   * de couper une longue. Indispensable quand un paquet mélange les longueurs, sinon les
   * courtes ne servent jamais et le surplus dort en stock.
   */
  mixLengths: boolean;
  /**
   * Mélange les paquets pendant la pose au lieu d'en vider un avant d'ouvrir le suivant.
   * C'est la règle de l'art : les nuances varient d'un paquet à l'autre, et les répartir
   * évite les plages franchement plus claires ou plus foncées.
   */
  mixPacks: boolean;
  /**
   * Sert la lame la plus courte qui couvre le besoin (une 80 plutôt qu'une 120 à recouper).
   * Moins de coupes et un peu moins de déchet, mais plus de lames consommées : une longue
   * coupée laisse une chute réutilisable, une courte posée est consommée pour de bon.
   */
  preferShort: boolean;
  /** Épaisseur des murs extérieurs (cm). Le sol = intérieur du tracé, décalé de moitié. */
  exteriorWallThickness: number;
  /** Jeu de dilatation périmétrique (cm) : la pièce est rétrécie d'autant avant pose. */
  expansionGap: number;
  /** Optimise le point de départ (rangées de rive équilibrées, coupes de bord centrées). */
  optimizeStart: boolean;
  /** Ligne de départ (point de la pièce par lequel passe la 1ʳᵉ rangée) ; null = auto. */
  startLine: Point | null;
  /** Inverse le côté par lequel on commence la pose depuis la ligne de départ. */
  startFlip: boolean;
  /** Marge de perte pour l'achat (%) ajoutée aux quantités à commander. */
  wastePurchasePct: number;
  seed: number;
}

/**
 * Une lame posée. Coordonnées dans le repère PIÈCE (déjà retransformées).
 * `clip` est le polygone réellement visible (portion ∩ pièce).
 */
export interface PlacedPlank {
  id: string;
  /** Numéro de la lame physique d'origine (1..N), unique sur tout le chantier. */
  plankNo: number;
  /** Paquet dont sort la lame, et son numéro DANS ce paquet (codification chantier). */
  packId: string;
  packNo: number;
  packPlankNo: number;
  /** Indice du morceau dans cette lame (0 = A, 1 = B…). */
  pieceIndex: number;
  /** Libellé reporté sur le plan : « 2·7 » = paquet 2, lame 7 ; « 2·7A » si découpée. */
  label: string;
  /** Morceaux visibles (portion ∩ pièce), repère PIÈCE. Plusieurs si pièce concave. */
  pieces: Point[][];
  /** Les 4 coins du rectangle nominal de la lame, repère PIÈCE (pour tracer les joints). */
  rect: Point[];
  angleDeg: number;
  sourceBatchId: string;
  texture: TextureId;
  /** Longueur nominale de la lame posée (cm), avant clip. */
  length: number;
  width: number;
  /** Largeur réellement occupée après clip (cm) : < `width` si la lame est refendue. */
  usedWidth: number;
  /**
   * Longueur réellement occupée après clip (cm). Sur un mur oblique, la lame est coupée en
   * biais : c'est CETTE cote qu'on mesure sur le chantier, pas la longueur avant coupe.
   */
  usedLength: number;
  /** Coupe en longueur (refend / trait de scie sur le chant) : rangée de rive, mur oblique. */
  isRipped: boolean;
  isCut: boolean;
  /** Espace (pièce fermée) dans lequel la lame est posée. */
  spaceIndex: number;
  /** Posée alors que le stock est épuisé : elle reste à acheter. */
  isMissing: boolean;
  /** true si cette lame provient d'une chute réutilisée. */
  fromOffcut: boolean;
  /** Sens du grain (vecteur unitaire) pour le veinage. */
  grain: Point;
}

export interface BatchUsage {
  batchId: string;
  used: number;
  available: number;
}

export interface CutListEntry {
  index: number;
  /** Libellé de la lame/morceau (ex. « 2·7A »). */
  label: string;
  /** Paquet et numéro de lame dans ce paquet. */
  packNo: number;
  packPlankNo: number;
  batchId: string;
  requestedLength: number;
  /** Largeur à conserver (cm) : < largeur du lot si la lame doit être refendue. */
  requestedWidth: number;
  /** Largeur nominale du lot (cm). */
  nominalWidth: number;
  /** Coupe en longueur (refend sur le chant), en plus ou à la place de la coupe en bout. */
  isRipped: boolean;
  /** Coupe en bout (transversale). */
  isCut: boolean;
  offcutLength: number;
  fromOffcut: boolean;
}

export interface LayoutStats {
  /** Une entrée par pièce fermée détectée (cloisons comprises). */
  spaces: { index: number; name: string; excluded: boolean; areaM2: number; planks: number }[];
  /** Surface des pièces explicitement non parquetées (m²). */
  excludedAreaM2: number;
  roomAreaM2: number;
  laidAreaM2: number;
  planksPlaced: number;
  newPlanksUsed: number;
  offcutsReused: number;
  /** Coupes en bout (transversales). */
  cuts: number;
  /** Coupes en longueur (refends) : lames à passer à la scie sur le chant. */
  ripCuts: number;
  /** Lames posées faute de stock : la pièce est calepinée, mais il faut les acheter. */
  missingPlanks: number;
  wasteAreaM2: number;
  wastePct: number;
  batchUsage: BatchUsage[];
  /** Lames manquantes par lot (>0 si stock insuffisant). */
  shortage: { batchId: string; missing: number }[];
  /** Périmètre de la pièce (m). */
  perimeterM: number;
  /** Nombre de portes/ouvertures. */
  doorCount: number;
  /** Longueur de plinthes à prévoir (m), périmètre hors passages de porte. */
  plintheM: number;
  /** Longueur totale de cloisons (m). */
  partitionM: number;
  /**
   * Qualité du décalage des joints RÉELLEMENT obtenue. Le décalage demandé n'est pas
   * toujours atteignable — un stock de lames courtes dans une grande pièce donne 4 joints
   * par rangée, et 4 joints voisins qui s'interdisent chacun ±30 cm saturent la rangée.
   * Le plan reste posable, mais l'utilisateur doit savoir ce qu'il obtient vraiment.
   */
  stagger: {
    /** Écart minimal constaté entre deux joints de rangées voisines (cm). */
    min: number;
    /** Écart médian (cm). */
    median: number;
    /** Nombre de joints sous le décalage demandé, et total de joints comparés. */
    below: number;
    total: number;
    /** Décalage demandé (cm) et valeur conseillée = 2 × largeur de lame (NF DTU 51.2, NWFA). */
    target: number;
    recommended: number;
  };
}

/**
 * Bordereau d'un paquet : les lames à en sortir, dans l'ordre, avec leur numéro.
 * C'est le document qu'on suit en ouvrant le paquet pour numéroter ses lames au crayon,
 * afin que la lame « 2·7 » du plan soit bien la 7ᵉ lame du paquet 2 sur le chantier.
 */
export interface PackSheet {
  packNo: number;
  packId: string;
  planks: { no: number; length: number; width: number }[];
}

export interface LayoutResult {
  placed: PlacedPlank[];
  /** Une entrée par paquet réellement entamé. */
  packSheets: PackSheet[];
  /** Pièces fermées détectées, dans l'ordre décroissant de surface. */
  spaces: { index: number; outer: Point[]; holes: Point[][]; areaM2: number; name: string; excluded: boolean }[];
  stats: LayoutStats;
  cutList: CutListEntry[];
}
