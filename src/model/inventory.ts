import type { PlankBatch } from './types';

/** Résultat d'une demande de lame : une longueur `length`, d'une largeur `width`. */
export interface CutResult {
  batchId: string;
  fromOffcut: boolean;
  isCut: boolean;
  offcutLength: number;
  /** Longueur effectivement disponible fournie (>= demande si servie, sinon partielle). */
  provided: number;
  ok: boolean;
  /** Numéro de la lame physique d'origine (1..N), unique sur tout le chantier. */
  plankNo: number;
  /** La lame n'existe pas en stock : elle est posée quand même, et reste à acheter. */
  isMissing: boolean;
  /** Numéro de la lame DANS son paquet (1..N) : la codification utilisée au chantier. */
  packPlankNo: number;
  /** Indice du morceau découpé dans cette lame (0 = A, 1 = B…). */
  pieceIndex: number;
}

interface Offcut {
  batchId: string;
  width: number;
  length: number;
  plankNo: number;
  packPlankNo: number;
  pieceIndex: number;
}

/**
 * Gère le stock fini par lot + un pool de chutes réutilisables.
 * Cœur de l'optimisation « minimiser déchets / limiter découpes » : on sert d'abord
 * une chute (best-fit) avant d'entamer une lame neuve.
 */
export class Inventory {
  private remaining = new Map<string, number>();
  private available = new Map<string, number>();
  private batchById = new Map<string, PlankBatch>();
  private offcuts: Offcut[] = [];
  private reuse: boolean;
  private minCut: number;
  private jointGap: number;
  cuts = 0;
  offcutsReused = 0;
  shortage = new Map<string, number>();
  private plankSeq = 0; // numéro de lame physique
  /** Mélange les paquets : on alterne au lieu d'en vider un avant d'ouvrir le suivant. */
  private mixPacks: boolean;
  /** Sert la lame la plus courte qui couvre le besoin, au lieu de préserver les chutes. */
  private preferShort: boolean;
  /** Lames déjà tirées de chaque paquet : sert au mélange ET à numéroter dans le paquet. */
  private packUse = new Map<string, number>();
  /** Lames posées faute de stock, par paquet : elles restent à acheter. */
  private missingByPack = new Map<string, number>();

  constructor(
    batches: PlankBatch[], reuseOffcuts: boolean, minCutLength: number, jointGap: number,
    mixPacks = false, preferShort = false,
  ) {
    this.reuse = reuseOffcuts;
    this.minCut = minCutLength;
    this.jointGap = jointGap;
    this.mixPacks = mixPacks;
    this.preferShort = preferShort;
    for (const b of batches) {
      this.remaining.set(b.id, b.quantity);
      this.available.set(b.id, b.quantity);
      this.batchById.set(b.id, b);
    }
  }

  /** Un lot est identifié `paquet:ligne` : le préfixe donne le paquet d'origine. */
  private packOf = (batchId: string) => batchId.split(':')[0];

  /** Ordre de service entre paquets : le moins entamé passe devant. */
  private packRank(b: PlankBatch): number {
    return this.mixPacks ? (this.packUse.get(this.packOf(b.id)) ?? 0) : 0;
  }

  /**
   * Sort une lame du stock et renvoie son numéro DANS son paquet.
   * Ce numéro ne dépend pas de l'ordre de pose : il vient de la place de la lame dans le
   * paquet (ordre des lignes de stock). C'est le numéro que l'utilisateur inscrit au crayon
   * en vidant le paquet — les deux doivent coïncider, sinon la codification ne sert à rien.
   */
  private takeFrom(b: PlankBatch): number {
    const left = this.remaining.get(b.id) ?? 0;
    const usedBefore = (this.available.get(b.id) ?? 0) - left;
    this.remaining.set(b.id, left - 1);
    const pk = this.packOf(b.id);
    this.packUse.set(pk, (this.packUse.get(pk) ?? 0) + 1); // sert au mélange des paquets
    // Le numéro vient du stock : c'est celui que l'utilisateur a inscrit sur la lame.
    return b.numbers?.[usedBefore] ?? usedBefore + 1;
  }

  /** Lots compatibles avec une largeur donnée (tolérance 0.5 cm). */
  private batchesForWidth(width: number): PlankBatch[] {
    return [...this.batchById.values()].filter((b) => Math.abs(b.width - width) <= 0.5);
  }

  /**
   * Longueurs réellement disponibles (lames neuves + chutes), de la plus longue à la plus
   * courte. Sert à choisir une lame qui EXISTE plutôt qu'à inventer une cote qu'il faudra
   * tailler — recouper une lame de 60 à 56,7 pour gagner trois centimètres est absurde.
   */
  availableLengths(width: number): number[] {
    const set = new Set<number>();
    for (const b of this.batchesForWidth(width)) {
      if ((this.remaining.get(b.id) ?? 0) > 0) set.add(b.length);
    }
    if (this.reuse) {
      for (const o of this.offcuts) {
        if (Math.abs(o.width - width) <= 0.5) set.add(o.length);
      }
    }
    return [...set].sort((a, b) => b - a);
  }

  /**
   * Sort une lame d'une longueur EXACTE (chute d'abord). Sert au motif, qui choisit lui-même
   * la longueur qui place le mieux son joint, puis vient la réserver ici.
   */
  takeExact(length: number, width: number): CutResult | null {
    if (this.reuse) {
      const i = this.offcuts.findIndex(
        (o) => Math.abs(o.width - width) <= 0.5 && Math.abs(o.length - length) <= 1e-6,
      );
      if (i !== -1) {
        const o = this.offcuts[i];
        this.offcuts.splice(i, 1);
        this.offcutsReused++;
        return {
          batchId: o.batchId, fromOffcut: true, isMissing: false, isCut: false, offcutLength: 0,
          provided: o.length, ok: true,
          plankNo: o.plankNo, packPlankNo: o.packPlankNo, pieceIndex: o.pieceIndex,
        };
      }
    }
    const fits = this.batchesForWidth(width).filter(
      (b) => (this.remaining.get(b.id) ?? 0) > 0 && Math.abs(b.length - length) <= 1e-6,
    );
    if (fits.length === 0) return null;
    // À longueur égale, on pioche dans le paquet le moins entamé (mélange des nuances).
    fits.sort((a, b) => this.packRank(a) - this.packRank(b));
    const b = fits[0];
    const packPlankNo = this.takeFrom(b);
    return {
      batchId: b.id, fromOffcut: false, isMissing: false, isCut: false, offcutLength: 0,
      provided: b.length, ok: true, plankNo: ++this.plankSeq, packPlankNo, pieceIndex: 0,
    };
  }

  /** Copie l'état du stock : sert à simuler une pose sans la consommer. */
  clone(): Inventory {
    const c = new Inventory(
      [], this.reuse, this.minCut, this.jointGap, this.mixPacks, this.preferShort,
    );
    c.remaining = new Map(this.remaining);
    c.available = new Map(this.available);
    c.batchById = new Map(this.batchById);
    c.offcuts = this.offcuts.map((o) => ({ ...o }));
    c.plankSeq = this.plankSeq;
    c.packUse = new Map(this.packUse);
    c.missingByPack = new Map(this.missingByPack);
    return c;
  }

  /**
   * Sert une lame ENTIÈRE dont la longueur tient dans `maxLen`, sans la couper.
   * Indispensable dès que les paquets mélangent les longueurs : sinon le moteur coupe
   * toujours la plus longue et les lames courtes du paquet ne sont jamais posées.
   * Le choix équilibre la consommation entre longueurs, au prorata du stock initial :
   * on épuise le paquet de façon homogène, comme on le fait sur un chantier.
   */
  requestWhole(maxLen: number, width: number): CutResult | null {
    // Une chute qui tient telle quelle est toujours préférable à une lame neuve.
    if (this.reuse) {
      let best = -1;
      for (let i = 0; i < this.offcuts.length; i++) {
        const o = this.offcuts[i];
        if (Math.abs(o.width - width) > 0.5 || o.length > maxLen + 1e-6) continue;
        if (best === -1 || o.length > this.offcuts[best].length) best = i;
      }
      if (best !== -1) {
        const o = this.offcuts[best];
        this.offcuts.splice(best, 1);
        this.offcutsReused++;
        return {
          batchId: o.batchId, fromOffcut: true, isMissing: false, isCut: false, offcutLength: 0,
          provided: o.length, ok: true,
          plankNo: o.plankNo, packPlankNo: o.packPlankNo, pieceIndex: o.pieceIndex,
        };
      }
    }

    const fits = this.batchesForWidth(width)
      .filter((b) => (this.remaining.get(b.id) ?? 0) > 0 && b.length <= maxLen + 1e-6);
    if (fits.length === 0) return null;

    // Part de stock encore disponible : on pioche d'abord dans la longueur la moins entamée.
    const share = (b: PlankBatch) => {
      const total = this.available.get(b.id) ?? 0;
      return total > 0 ? (this.remaining.get(b.id) ?? 0) / total : 0;
    };
    fits.sort((a, b) =>
      this.packRank(a) - this.packRank(b) || share(b) - share(a) || b.length - a.length);

    const b = fits[0];
    const packPlankNo = this.takeFrom(b);
    return {
      batchId: b.id, fromOffcut: false, isMissing: false, isCut: false, offcutLength: 0,
      provided: b.length, ok: true, plankNo: ++this.plankSeq, packPlankNo, pieceIndex: 0,
    };
  }

  /**
   * Demande une lame de longueur `length` et largeur `width`.
   * Stratégie : chute best-fit >= length -> sinon lame neuve (découpe si plus longue).
   */
  request(length: number, width: number): CutResult {
    // 1) Réutiliser une chute : la plus courte qui couvre le besoin (best-fit).
    if (this.reuse) {
      let best = -1;
      for (let i = 0; i < this.offcuts.length; i++) {
        const o = this.offcuts[i];
        if (Math.abs(o.width - width) > 0.5) continue;
        if (o.length + 1e-6 >= length) {
          if (best === -1 || o.length < this.offcuts[best].length) best = i;
        }
      }
      if (best !== -1) {
        const o = this.offcuts[best];
        const rest = o.length - length - this.jointGap;
        this.offcuts.splice(best, 1);
        this.offcutsReused++;
        let offcutLength = 0;
        if (rest >= this.minCut) {
          this.offcuts.push({
            batchId: o.batchId, width: o.width, length: rest,
            plankNo: o.plankNo, packPlankNo: o.packPlankNo, pieceIndex: o.pieceIndex + 1,
          });
          offcutLength = rest;
        }
        const isCut = length < o.length - 1e-6;
        if (isCut) this.cuts++;
        return {
          batchId: o.batchId, fromOffcut: true, isMissing: false, isCut, offcutLength,
          provided: length, ok: true,
          plankNo: o.plankNo, packPlankNo: o.packPlankNo, pieceIndex: o.pieceIndex,
        };
      }
    }

    // 2) Lame neuve depuis un lot compatible (disponibilité + longueur suffisante d'abord).
    // Le tri ne cherche pas la lame la plus ajustée mais celle qui gaspille le moins :
    // une chute >= minCut retourne au pool et resservira, alors qu'une chute plus courte
    // que minCut est définitivement perdue. À perte égale, on garde la chute la plus
    // longue — c'est celle qui couvrira le plus de demandes futures.
    const lossOf = (b: PlankBatch): number => {
      const rest = b.length - length - this.jointGap;
      if (rest <= 1e-6) return 0; // lame consommée entièrement
      return rest < this.minCut ? rest : 0; // chute trop courte = déchet définitif
    };
    const restOf = (b: PlankBatch): number => Math.max(0, b.length - length - this.jointGap);

    // Une lame déjà à la bonne cote passe avant tout : la couper serait absurde.
    const exact = (b: PlankBatch): number => (Math.abs(b.length - length) <= 1e-6 ? 0 : 1);

    const candidates = this.batchesForWidth(width)
      .filter((b) => (this.remaining.get(b.id) ?? 0) > 0)
      .sort((a, b) => {
        const aFits = a.length + 1e-6 >= length ? 0 : 1;
        const bFits = b.length + 1e-6 >= length ? 0 : 1;
        if (aFits !== bFits) return aFits - bFits;
        const de = exact(a) - exact(b);
        if (de !== 0) return de;
        if (this.preferShort) {
          // Best-fit : la plus courte qui couvre le besoin. On entame une 80 plutôt que
          // de tailler dans une 120 — moins de coupes, mais pas de chute à recycler.
          const dLen = a.length - b.length;
          if (Math.abs(dLen) > 1e-6) return dLen;
        } else {
          const dl = lossOf(a) - lossOf(b);
          if (Math.abs(dl) > 1e-6) return dl;
          const dr = restOf(b) - restOf(a);
          if (Math.abs(dr) > 1e-6) return dr;
        }
        // Lots équivalents : on prend dans le paquet le moins entamé (mélange des nuances).
        return this.packRank(a) - this.packRank(b);
      });

    if (candidates.length === 0) {
      // Stock épuisé. On pose la lame QUAND MÊME : un plan troué n'aide personne, alors
      // qu'un plan complet dit exactement combien de lames il manque et où elles vont.
      const all = this.batchesForWidth(width);
      const wanted = all.find((b) => b.length + 1e-6 >= length)
        ?? all.slice().sort((a, b) => b.length - a.length)[0];
      const id = wanted?.id ?? 'unknown';
      this.shortage.set(id, (this.shortage.get(id) ?? 0) + 1);
      const pk = this.packOf(id);
      const n = (this.missingByPack.get(pk) ?? 0) + 1;
      this.missingByPack.set(pk, n);
      return {
        batchId: id, fromOffcut: false, isMissing: true,
        isCut: wanted ? length < wanted.length - 1e-6 : false,
        offcutLength: 0, provided: length, ok: true,
        plankNo: ++this.plankSeq, packPlankNo: 0, pieceIndex: 0,
      };
    }

    const b = candidates[0];
    const packPlankNo = this.takeFrom(b);
    const plankNo = ++this.plankSeq; // nouvelle lame physique

    const provided = Math.min(length, b.length);
    const rest = b.length - length - this.jointGap;
    const isCut = length < b.length - 1e-6;
    if (isCut) {
      this.cuts++;
      if (rest >= this.minCut) {
        this.offcuts.push({
          batchId: b.id, width: b.width, length: rest, plankNo, packPlankNo, pieceIndex: 1,
        });
      }
    }
    return {
      batchId: b.id,
      fromOffcut: false,
      isMissing: false,
      isCut,
      offcutLength: rest >= this.minCut ? rest : 0,
      provided,
      ok: provided + 1e-6 >= length || provided > 0,
      plankNo,
      packPlankNo,
      pieceIndex: 0,
    };
  }

  usage() {
    return [...this.batchById.keys()].map((id) => ({
      batchId: id,
      used: (this.available.get(id) ?? 0) - (this.remaining.get(id) ?? 0),
      available: this.available.get(id) ?? 0,
    }));
  }

  shortageList() {
    return [...this.shortage.entries()].map(([batchId, missing]) => ({ batchId, missing }));
  }
}
