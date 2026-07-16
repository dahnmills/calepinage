// Import d'un inventaire existant. On accepte ce que les gens ont réellement sous la main :
// du JSON (plusieurs formes), un CSV, ou une simple liste collée depuis un tableur.
// Le principe : ne jamais refuser un fichier compréhensible, et dire précisément ce qui
// a été compris.
import type { Pack, Plank, TextureId } from './types';
import { TEXTURE_LIST } from './textures';

export interface ImportResult {
  packs: Pack[];
  /** Ce qui a été ignoré, ligne par ligne : l'utilisateur doit pouvoir vérifier. */
  warnings: string[];
}

let seq = 0;
const uid = () => `i${Date.now().toString(36)}${seq++}`;

const TEXTURES = new Set(TEXTURE_LIST.map((t) => t.id));
const asTexture = (v: unknown): TextureId => {
  const s = String(v ?? '').trim().toLowerCase();
  return (TEXTURES.has(s as TextureId) ? s : 'chene-clair') as TextureId;
};

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(',', '.').replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** Une lame lue, avant regroupement en paquets. */
interface RawPlank {
  pack: string;
  no: number | null;
  length: number;
  width: number | null;
  texture: TextureId;
  /** Répétition : « 12 lames de 120 » donne 12 lames identiques. */
  count: number;
}

/** Reconnaît les en-têtes usuels, en français comme en anglais. */
function columnOf(header: string): keyof RawPlank | 'ignore' {
  const h = header.trim().toLowerCase().replace(/[°"']/g, '');
  if (/^(no|n|num|numero|numéro|lame|id)$/.test(h)) return 'no';
  if (/^(long|longueur|length|len|l)$/.test(h)) return 'length';
  if (/^(larg|largeur|width|w)$/.test(h)) return 'width';
  if (/^(paquet|pack|lot|colis|carton)$/.test(h)) return 'pack';
  if (/^(aspect|texture|teinte|couleur|finition)$/.test(h)) return 'texture';
  if (/^(qte|qté|quantite|quantité|quantity|count|nb|nombre)$/.test(h)) return 'count';
  return 'ignore';
}

/** Assemble les lames lues en paquets, en réglant les collisions de numéros. */
function assemble(raws: RawPlank[], warnings: string[], defaultWidth: number): Pack[] {
  const byPack = new Map<string, Plank[]>();
  const usedNos = new Map<string, Set<number>>();

  for (const r of raws) {
    const planks = byPack.get(r.pack) ?? [];
    const taken = usedNos.get(r.pack) ?? new Set<number>();

    for (let i = 0; i < r.count; i++) {
      // Numéro demandé pour la 1ʳᵉ lame seulement : une répétition ne peut pas le partager.
      let no = r.no != null && i === 0 ? r.no : NaN;
      if (!Number.isFinite(no) || taken.has(no)) {
        if (r.no != null && i === 0 && taken.has(r.no)) {
          warnings.push(`Paquet « ${r.pack} » : le n° ${r.no} était déjà pris, lame renumérotée.`);
        }
        no = 1;
        while (taken.has(no)) no++;
      }
      taken.add(no);
      planks.push({
        id: uid(),
        no,
        length: r.length,
        width: r.width ?? defaultWidth,
        texture: r.texture,
      });
    }
    byPack.set(r.pack, planks);
    usedNos.set(r.pack, taken);
  }

  return [...byPack.entries()].map(([name, planks]) => ({
    id: uid(),
    name,
    defaultWidth: planks[0]?.width ?? defaultWidth,
    planks: planks.sort((a, b) => a.no - b.no),
  }));
}

/** Lit un objet quelconque comme une lame (ou un groupe de lames identiques). */
function rawFromObject(o: Record<string, unknown>, fallbackPack: string): RawPlank | null {
  const get = (...keys: string[]) => {
    for (const k of Object.keys(o)) {
      if (keys.includes(k.trim().toLowerCase())) return o[k];
    }
    return undefined;
  };
  const length = num(get('length', 'longueur', 'long', 'len', 'l'));
  if (length == null || length <= 0) return null;
  return {
    pack: String(get('pack', 'paquet', 'lot', 'colis') ?? fallbackPack).trim() || fallbackPack,
    no: num(get('no', 'n', 'num', 'numero', 'numéro', 'lame', 'id')),
    length,
    width: num(get('width', 'largeur', 'larg', 'w')),
    texture: asTexture(get('texture', 'aspect', 'teinte', 'couleur')),
    count: Math.max(1, Math.round(num(get('count', 'qte', 'qté', 'quantite', 'quantité', 'quantity', 'nb')) ?? 1)),
  };
}

function fromJson(data: unknown, warnings: string[], defaultWidth: number): Pack[] | null {
  // Forme native : le projet complet, ou juste ses paquets.
  const root = data as Record<string, unknown>;
  const maybePacks = Array.isArray(data) ? data : (root?.packs as unknown);

  if (Array.isArray(maybePacks) && maybePacks.some((p) => p && typeof p === 'object' && 'planks' in p)) {
    const packs: Pack[] = [];
    for (const p of maybePacks as Record<string, unknown>[]) {
      const planks = (p.planks as Record<string, unknown>[] | undefined) ?? [];
      const raws: RawPlank[] = [];
      for (const pl of planks) {
        const r = rawFromObject(pl, String(p.name ?? 'Paquet'));
        if (r) raws.push({ ...r, pack: String(p.name ?? 'Paquet') });
      }
      packs.push(...assemble(raws, warnings, num(p.defaultWidth) ?? defaultWidth));
    }
    return packs.length ? packs : null;
  }

  // Forme plate : une liste de lames, chacune pouvant nommer son paquet.
  if (Array.isArray(data)) {
    const raws: RawPlank[] = [];
    data.forEach((row, i) => {
      if (!row || typeof row !== 'object') { warnings.push(`Ligne ${i + 1} ignorée.`); return; }
      const r = rawFromObject(row as Record<string, unknown>, 'Paquet 1');
      if (r) raws.push(r); else warnings.push(`Ligne ${i + 1} : longueur illisible, ignorée.`);
    });
    return raws.length ? assemble(raws, warnings, defaultWidth) : null;
  }
  return null;
}

function fromDelimited(text: string, warnings: string[], defaultWidth: number): Pack[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const split = (l: string) => l.split(/[\t;,|]/).map((c) => c.trim());
  const first = split(lines[0]);
  const cols = first.map(columnOf);
  const hasHeader = cols.some((c) => c !== 'ignore') && first.every((c) => num(c) == null || columnOf(c) !== 'ignore');

  const raws: RawPlank[] = [];
  const body = hasHeader ? lines.slice(1) : lines;

  body.forEach((line, i) => {
    const cells = split(line);
    const rec: Record<string, unknown> = {};
    if (hasHeader) {
      cols.forEach((c, k) => { if (c !== 'ignore') rec[c] = cells[k]; });
    } else {
      // Sans en-tête : « longueur », ou « nombre × longueur », ou « n°, longueur ».
      const nums = cells.map(num).filter((n): n is number => n != null);
      if (nums.length === 1) rec.length = nums[0];
      else if (nums.length >= 2) { rec.no = nums[0]; rec.length = nums[1]; if (nums[2]) rec.width = nums[2]; }
      const m = line.match(/^\s*(\d+)\s*[x×*]\s*(\d+(?:[.,]\d+)?)/i);
      if (m) { rec.count = m[1]; rec.length = m[2]; delete rec.no; }
    }
    const r = rawFromObject(rec, 'Paquet 1');
    if (r) raws.push(r);
    else warnings.push(`Ligne ${i + (hasHeader ? 2 : 1)} : « ${line.slice(0, 40)} » ignorée.`);
  });

  return raws.length ? assemble(raws, warnings, defaultWidth) : null;
}

/**
 * Lit un inventaire : JSON (projet, liste de paquets, ou liste de lames) ou texte tabulé /
 * CSV. `defaultWidth` sert aux lames dont la largeur n'est pas précisée.
 */
export function parseInventory(text: string, defaultWidth = 20): ImportResult {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { packs: [], warnings: ['Rien à importer.'] };

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const packs = fromJson(JSON.parse(trimmed), warnings, defaultWidth);
      if (packs?.length) return { packs, warnings };
      warnings.push('JSON lu, mais aucune lame reconnue (il faut au moins une longueur).');
      return { packs: [], warnings };
    } catch {
      warnings.push('JSON invalide : tentative de lecture en tableau.');
    }
  }

  const packs = fromDelimited(trimmed, warnings, defaultWidth);
  if (packs?.length) return { packs, warnings };
  return { packs: [], warnings: [...warnings, 'Aucune lame reconnue.'] };
}
