# Validation du plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doter le calepinage d'une couche de validation qui certifie la qualité du plan — un verdict global et un surlignage cliquable des défauts, pour un usage autonome par un non-expert.

**Architecture:** Un module pur `src/model/validate.ts` prend `(room, result, config)` et rend un `Diagnostic[]`. Cette liste unique (approche A du spec) alimente le bandeau + la liste de `ResultsPanel` et le surlignage + le zoom de `CanvasView`. Le store porte `diagnostics` (calculé dans `run()`) et `focusedDiagnostic` (écrit au clic, lu pour recadrer).

**Tech Stack:** TypeScript, React, Zustand, Canvas 2D. Tests = scripts Node jetables compilés par esbuild (méthode DEV_NOTES), plus le banc `tools/bench-layout.ts`.

## Global Constraints

- Aucune dépendance nouvelle. Rastérisation en TS pur.
- Réutiliser `pointInPolygon(pt, poly)` et `polygonBBox(poly): BBox` de `src/model/geometry.ts` ; ne pas utiliser `polygon-clipping` (plante sur ces géométries).
- `Diagnostic.region` est en **repère pièce** (mêmes coordonnées que `room.points`, `result.placed[].rect`).
- Tout script de test jetable se lance **depuis le dossier projet** (`node ./_x.cjs` puis `rm`), jamais depuis le scratchpad (résolution `node_modules`).
- Vérif finale de chaque tâche touchant du code : `npx tsc --noEmit` vert.
- Le seuil « vrai trou » = 3 érosions à 0,5 cm (~3 cm d'épaisseur mini), aligné sur le jeu de dilatation. Constante nommée interne.
- Le banc doit garder le nombre de **trous** (`kind === 'hole'`) = 0 sur 120 simulations
  + les 3 JSON réels de `~/Downloads/calepinage-2026-07-20*.json`. (Correction en cours
  d'exécution : la contrainte visait d'abord `error` count = 0, mais les stocks SYNTHÉTIQUES
  du banc sont volontairement petits et produisent légitimement des `missing` — stock
  insuffisant, un vrai diagnostic, pas un défaut. L'invariant réel est « aucun trou
  inventé ». Sur les 3 plans réels, stock adéquat, `error` = 0 reste vrai.)

---

## File Structure

- **Create** `src/model/validate.ts` — `Diagnostic`, `validatePlan()`, helpers `coverageHoles()`, `jointDiagnostics()`, `ripDiagnostics()`. Pur, sans React.
- **Modify** `src/store/useStore.ts` — champs `diagnostics: Diagnostic[]` et `focusedDiagnostic: Diagnostic | null`, action `focusDiagnostic()`, calcul dans `run()`.
- **Modify** `src/ui/ResultsPanel.tsx` — bandeau de verdict + liste cliquable en tête.
- **Modify** `src/render/CanvasView.tsx` — dessin du surlignage + recadrage sur `focusedDiagnostic`, prop `showChecks`.
- **Modify** `src/App.tsx` — case d'en-tête « Vérifications » (ON par défaut), passe `showChecks` à `CanvasView`.
- **Modify** `src/App.css` — classe `.verdict-ok` (verte) ; réutilise `.alert`/`.note` pour le reste.
- **Modify** `tools/bench-layout.ts` — colonne `errors` via `validatePlan`.

---

### Task 1: Modèle `Diagnostic` et squelette `validatePlan`

**Files:**
- Create: `src/model/validate.ts`
- Test: script jetable `_v1.cjs` (à supprimer après)

**Interfaces:**
- Consumes: `Room`, `LayoutResult`, `LayoutConfig` de `src/model/types.ts`.
- Produces: `interface Diagnostic { severity: 'error'|'warn'|'info'; kind: string; message: string; region?: { x: number; y: number; w: number; h: number }; count?: number }` et `function validatePlan(room: Room, result: LayoutResult, config: LayoutConfig): Diagnostic[]`.

- [ ] **Step 1: Write the failing test**

Créer `_v1.ts` à la racine :
```ts
import { validatePlan, type Diagnostic } from './src/model/validate';
const room: any = { points: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}], holes: [], partitions: [], spaceTags: [] };
const result: any = { placed: [], spaces: [], stats: { missingPlanks: 0, narrowRips: 0, stagger: { below: 0, target: 30 } } };
const config: any = { expansionGap: 0.8, minJointOffset: 30, minCutLength: 25, minRipWidth: 5 };
const d: Diagnostic[] = validatePlan(room, result, config);
console.log(Array.isArray(d) ? 'OK array' : 'FAIL', d.length);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild _v1.ts --bundle --platform=node --format=cjs --outfile=_v1.cjs && node ./_v1.cjs`
Expected: FAIL — esbuild « Could not resolve './src/model/validate' » (le module n'existe pas).

- [ ] **Step 3: Write minimal implementation**

Créer `src/model/validate.ts` :
```ts
import type { LayoutConfig, LayoutResult, Room } from './types';

export interface Diagnostic {
  severity: 'error' | 'warn' | 'info';
  kind: string;
  message: string;
  /** Zone du défaut en repère PIÈCE, pour surligner et recadrer. */
  region?: { x: number; y: number; w: number; h: number };
  count?: number;
}

/**
 * Certifie la qualité d'un plan calepiné. Question sur le RÉSULTAT, indépendante du motif :
 * marche sur n'importe quel plan, comme le banc de mesure.
 */
export function validatePlan(_room: Room, _result: LayoutResult, _config: LayoutConfig): Diagnostic[] {
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./_v1.cjs`
Expected: `OK array 0`

- [ ] **Step 5: Commit**

```bash
rm -f _v1.ts _v1.cjs
git add src/model/validate.ts
git commit -m "feat(validate): squelette validatePlan + type Diagnostic"
```

---

### Task 2: Diagnostics dérivés des stats (sans rastérisation)

Les compteurs existent déjà dans `result.stats` — on les traduit en diagnostics.

**Files:**
- Modify: `src/model/validate.ts`
- Test: script jetable `_v2.cjs`

**Interfaces:**
- Consumes: `result.stats.missingPlanks: number`, `result.stats.narrowRips: number`, `result.stats.stagger: { below: number; target: number }`, `config.minRipWidth: number`.
- Produces: `validatePlan` renvoie désormais les diagnostics `missing`, `rip-narrow`, `joint-offset` selon ces compteurs.

- [ ] **Step 1: Write the failing test**

Créer `_v2.ts` :
```ts
import { validatePlan } from './src/model/validate';
const room: any = { points: [], holes: [], partitions: [], spaceTags: [] };
const config: any = { expansionGap: 0.8, minJointOffset: 30, minCutLength: 25, minRipWidth: 5 };
const result: any = { placed: [], spaces: [], stats: { missingPlanks: 2, narrowRips: 3, stagger: { below: 4, target: 30 } } };
const d = validatePlan(room, result, config);
const kinds = d.map((x) => `${x.kind}:${x.severity}:${x.count}`).sort();
console.log(kinds.join(' | '));
// attendu : joint-offset:info:4 | missing:error:2 | rip-narrow:warn:3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild _v2.ts --bundle --platform=node --format=cjs --outfile=_v2.cjs && node ./_v2.cjs`
Expected: ligne vide (aucun diagnostic) — FAIL.

- [ ] **Step 3: Write minimal implementation**

Remplacer le corps de `validatePlan` dans `src/model/validate.ts` :
```ts
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
  return out;
}
```
(retirer le `_result` inutilisé de la signature ; garder `_room`, `_config` renommés selon usage.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./_v2.cjs`
Expected: `joint-offset:info:4 | missing:error:2 | rip-narrow:warn:3`

- [ ] **Step 5: Commit**

```bash
rm -f _v2.ts _v2.cjs
git add src/model/validate.ts
git commit -m "feat(validate): diagnostics missing / rip-narrow / joint-offset depuis les stats"
```

---

### Task 3: Détection de trous par rastérisation

Capacité neuve : portage de la rastérisation jetable en fonction réelle.

**Files:**
- Modify: `src/model/validate.ts`
- Test: script jetable `_v3.cjs`

**Interfaces:**
- Consumes: `result.spaces: { outer: Point[]; holes: Point[][]; excluded: boolean }[]`, `result.placed: { pieces: Point[][] }[]`, `pointInPolygon(pt, poly)` de `./geometry`.
- Produces: `coverageHoles(result: LayoutResult): Diagnostic[]` (kind `hole`, severity `error`, `region` = bbox du vide), appelé par `validatePlan`.

- [ ] **Step 1: Write the failing test**

Créer `_v3.ts` — un sol 100×100, une seule lame qui ne couvre que la moitié → trou de 50×100 :
```ts
import { validatePlan } from './src/model/validate';
const sq = (x0:number,y0:number,x1:number,y1:number) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
const room: any = { points: sq(0,0,100,100), holes: [], partitions: [], spaceTags: [] };
const config: any = { expansionGap: 0.8, minJointOffset: 30, minCutLength: 25, minRipWidth: 5 };
const result: any = {
  spaces: [{ outer: sq(0,0,100,100), holes: [], excluded: false }],
  placed: [{ pieces: [sq(0,0,50,100)] }], // couvre x 0..50 seulement
  stats: { missingPlanks: 0, narrowRips: 0, stagger: { below: 0, target: 30 } },
};
const holes = validatePlan(room, result, config).filter((d) => d.kind === 'hole');
console.log('trous:', holes.length, '| region:', JSON.stringify(holes[0]?.region));
// attendu : 1 trou, region ~ {x:50, y:0, w:50, h:100} (a quelques cm pres, erosion)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild _v3.ts --bundle --platform=node --format=cjs --outfile=_v3.cjs && node ./_v3.cjs`
Expected: `trous: 0` — FAIL (pas encore de détection).

- [ ] **Step 3: Write minimal implementation**

Ajouter dans `src/model/validate.ts` (import en tête : `import { pointInPolygon } from './geometry';`) :
```ts
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
```
Puis, dans `validatePlan`, avant `return out;` :
```ts
  out.push(...coverageHoles(result));
```
Ajouter l'import de `Point` : `import type { LayoutConfig, LayoutResult, Point, Room } from './types';`

- [ ] **Step 4: Run test to verify it passes**

Run: `node ./_v3.cjs`
Expected: `trous: 1 | region: {"x":...,"y":...,"w":...,"h":...}` avec `x`≈50, `w`≈50 (± quelques cm).

- [ ] **Step 5: Commit**

```bash
rm -f _v3.ts _v3.cjs
git add src/model/validate.ts
git commit -m "feat(validate): detection de trous par rasterisation + erosion"
```

---

### Task 4: Vérifier sur les JSON réels + garde-fou érosion

Confirmer 0 trou sur les 3 plans réels, et que le seuil d'érosion ignore le jeu de dilatation.

**Files:**
- Test: script jetable `_v4.cjs` (aucune modif de code attendue si Task 3 correcte)

**Interfaces:**
- Consumes: `computeLayout` de `src/model/layout.ts`, `flattenPacks` de `src/model/stock.ts`, `validatePlan`.

- [ ] **Step 1: Write the verification script**

Créer `_v4.ts` :
```ts
import { computeLayout } from './src/model/layout';
import { flattenPacks } from './src/model/stock';
import { validatePlan } from './src/model/validate';
const fs = require('fs');
for (const f of ['', '(3)', '(4)']) {
  const path = `/Users/jeremydahan/Downloads/calepinage-2026-07-20${f ? ' ' + f : ''}.json`;
  if (!fs.existsSync(path)) continue;
  const d = JSON.parse(fs.readFileSync(path, 'utf8'));
  const cfg = { minRipWidth: 5, avoidSamePlank: true, ...d.config };
  const r = computeLayout(d.room, flattenPacks(d.packs), cfg);
  const diags = validatePlan(d.room, r, cfg);
  const holes = diags.filter((x) => x.kind === 'hole');
  console.log(`${path.split('/').pop()} : trous ${holes.length} | errors ${diags.filter((x)=>x.severity==='error').length}`);
}
```

- [ ] **Step 2: Run and confirm 0 holes**

Run: `npx esbuild _v4.ts --bundle --platform=node --format=cjs --outfile=_v4.cjs && node ./_v4.cjs`
Expected: chaque ligne `trous 0 | errors 0`. Si un trou apparaît, ERODE est trop faible → NE PAS baisser le seuil sans vérifier qu'il s'agit d'un vrai vide (rejouer la rastérisation 0,5 cm de DEV_NOTES).

- [ ] **Step 3: Cleanup + commit (doc only)**

```bash
rm -f _v4.ts _v4.cjs
git commit --allow-empty -m "test(validate): 0 trou confirme sur les 3 plans reels"
```

---

### Task 5: Banc — colonne `errors` anti-régression

**Files:**
- Modify: `tools/bench-layout.ts`

**Interfaces:**
- Consumes: `validatePlan` de `../src/model/validate`.
- Produces: métriques `holes: number` (garde-fou, doit rester 0) et `errors: number`
  (informatif) dans `Metrics`, affichées en colonnes.

CORRECTION vs version initiale : le garde-fou porte sur les **trous**, pas sur toutes les
erreurs. Les stocks synthétiques du banc sont volontairement petits → ils produisent
légitimement des `missing` (stock insuffisant), qui sont des erreurs réelles mais pas des
défauts d'algorithme. `holes` doit rester 0 partout ; `errors` peut être > 0 sur les cas
synthétiques sous-dimensionnés, et vaut 0 sur les 3 plans réels.

- [ ] **Step 1: Add the metrics**

Dans `tools/bench-layout.ts`, ajouter à `interface Metrics` :
```ts
  /** Diagnostics de type 'hole' (sol non couvert). Garde-fou : doit rester à 0. */
  holes: number;
  /** Diagnostics de gravité error, tous types confondus. Informatif : les stocks
   * synthétiques du banc produisent des 'missing' légitimes (stock insuffisant). */
  errors: number;
```
En tête du fichier, importer : `import { validatePlan } from '../src/model/validate';`
Dans `measure()`, après `const res: any = computeLayout(...)` :
```ts
  const diags = validatePlan(room, res, config);
  const holes = diags.filter((d) => d.kind === 'hole').length;
  const errors = diags.filter((d) => d.severity === 'error').length;
```
Dans l'objet retourné, ajouter `holes,` et `errors,`.
Dans le tableau `cols`, ajouter `'holes'` puis `'errors'` en premier après `'joints'`.

- [ ] **Step 2: Run the bench**

Run: `npx esbuild tools/bench-layout.ts --bundle --platform=node --format=cjs --outfile=_b.cjs && node _b.cjs --full`
Expected: colonne `holes` à **0** sur toutes les lignes ET en moyenne. La colonne `errors`
peut être > 0 (cas synthétiques à stock insuffisant) — c'est normal, ne PAS y toucher.
Si `holes` est > 0 où que ce soit → STOP, BLOCKED (vraie régression de trou).

- [ ] **Step 3: Commit**

```bash
rm -f _b.cjs
git add tools/bench-layout.ts
git commit -m "test(bench): colonnes holes (garde-fou anti-trou) + errors (informatif)"
```

---

### Task 6: Store — `diagnostics` et `focusedDiagnostic`

**Files:**
- Modify: `src/store/useStore.ts`

**Interfaces:**
- Consumes: `validatePlan`, `Diagnostic` de `../model/validate`.
- Produces: état `diagnostics: Diagnostic[]`, `focusedDiagnostic: Diagnostic | null`, action `focusDiagnostic(d: Diagnostic | null): void`. `run()` remplit `diagnostics` ; tout endroit qui remet `result: null` remet aussi `diagnostics: []` et `focusedDiagnostic: null`.

- [ ] **Step 1: Extend the store interface**

Dans l'interface du store (près de `result: LayoutResult | null;`) ajouter :
```ts
  diagnostics: Diagnostic[];
  focusedDiagnostic: Diagnostic | null;
  focusDiagnostic: (d: Diagnostic | null) => void;
```
Import en tête : `import { validatePlan, type Diagnostic } from '../model/validate';`

- [ ] **Step 2: Initialise and wire run()**

À l'initialisation de l'état (près de `result: null,`) ajouter `diagnostics: [], focusedDiagnostic: null,`.
Remplacer `run()` :
```ts
  run: () => {
    const { room, packs, config } = get();
    const result = computeLayout(room, flattenPacks(packs), config);
    set({ result, diagnostics: validatePlan(room, result, config), focusedDiagnostic: null });
  },
  focusDiagnostic: (d) => set({ focusedDiagnostic: d }),
```

- [ ] **Step 3: Reset alongside result**

Repérer chaque `set({ ... result: null ... })` (lignes ~189, 200, 206, 215, 232, 237, 241 et suivantes) et ajouter dans le même objet `diagnostics: [], focusedDiagnostic: null` **uniquement là où `result: null` est déjà présent**. Pour `loadInto` (ligne ~215) idem.

- [ ] **Step 4: Verify compile**

Run: `npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 5: Commit**

```bash
git add src/store/useStore.ts
git commit -m "feat(store): diagnostics + focusedDiagnostic, calcul dans run()"
```

---

### Task 7: `ResultsPanel` — bandeau de verdict + liste cliquable

**Files:**
- Modify: `src/ui/ResultsPanel.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `diagnostics`, `focusDiagnostic` du store.
- Produces: rendu du verdict et de la liste ; clic → `focusDiagnostic(d)`.

- [ ] **Step 1: Add verdict CSS**

Dans `src/App.css`, après le bloc `.note { … }` :
```css
/* Verdict d'un plan sain. */
.verdict-ok {
  background: #dcfce7;
  border: 1px solid #86efac;
  color: #166534;
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 10px;
}
/* Liste des diagnostics : chaque ligne mène au défaut sur le plan. */
.diag-list { list-style: none; margin: 0 0 10px; padding: 0; }
.diag-list li {
  display: flex; gap: 6px; align-items: baseline;
  padding: 4px 6px; border-radius: 5px; cursor: pointer; font-size: 12px;
}
.diag-list li:hover { background: #f1f5f9; }
.diag-list li.error { color: #92400e; }
.diag-list li.warn { color: #9a3412; }
.diag-list li.info { color: #334155; }
```

- [ ] **Step 2: Render verdict + list**

Dans `src/ui/ResultsPanel.tsx`, ajouter au `useStore` destructuring : `diagnostics, focusDiagnostic`.
Juste après `<h2>Résultats</h2>`, insérer :
```tsx
      {(() => {
        const errs = diagnostics.filter((d) => d.severity === 'error').length;
        const others = diagnostics.length - errs;
        if (diagnostics.length === 0) {
          return <div className="verdict-ok">✓ Plan posable</div>;
        }
        const cls = errs > 0 ? 'alert' : 'note';
        const label = errs > 0
          ? `${errs} erreur(s) à corriger${others ? ` · ${others} à vérifier` : ''}`
          : `Posable — ${others} point(s) à vérifier`;
        return (
          <>
            <div className={cls}><b>{label}</b></div>
            <ul className="diag-list">
              {diagnostics.map((d, i) => (
                <li key={i} className={d.severity}
                    onClick={() => d.region && focusDiagnostic(d)}
                    title={d.region ? 'Cliquer pour voir sur le plan' : undefined}>
                  <span>{d.severity === 'error' ? '⛔' : d.severity === 'warn' ? '⚠' : 'ℹ'}</span>
                  <span>{d.message}</span>
                </li>
              ))}
            </ul>
          </>
        );
      })()}
```
Note : le composant retourne tôt quand `!result`. Ce bloc est APRÈS ce garde, donc `diagnostics` est non vide seulement si un calcul a eu lieu — cohérent.

- [ ] **Step 3: Verify compile + build**

Run: `npx tsc --noEmit && npm run build`
Expected: verts.

- [ ] **Step 4: Commit**

```bash
git add src/ui/ResultsPanel.tsx src/App.css
git commit -m "feat(ui): verdict de plan + liste de diagnostics cliquable"
```

---

### Task 8: `CanvasView` — surlignage + recadrage

**Files:**
- Modify: `src/render/CanvasView.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `diagnostics`, `focusedDiagnostic`, `focusDiagnostic` du store ; nouvelle prop `showChecks: boolean`.
- Produces: dessin des régions ; effet qui recadre sur `focusedDiagnostic`.

- [ ] **Step 1: Add the header toggle**

Dans `src/App.tsx` : ajouter `const [showChecks, setShowChecks] = useState(true);` près de `showGaps`.
Ajouter une case dans `.header-toggles` (copier le bloc de `showGaps`, libellé « Vérifications ») liée à `showChecks`/`setShowChecks`.
Passer la prop : `<CanvasView highlightCuts={highlightCuts} showNumbers={showNumbers} showGaps={showGaps} showChecks={showChecks} />`.

- [ ] **Step 2: Accept the prop**

Dans `src/render/CanvasView.tsx`, à la signature du composant, ajouter `showChecks` :
```ts
export default function CanvasView({ highlightCuts, showNumbers, showGaps, showChecks }: { highlightCuts: boolean; showNumbers: boolean; showGaps: boolean; showChecks: boolean }) {
```
Ajouter au `useStore` destructuring : `diagnostics, focusedDiagnostic`.

- [ ] **Step 3: Draw the highlights**

À la fin de la grande boucle de rendu (`useEffect`), juste avant le `} catch (err) {`, ajouter :
```ts
    if (showChecks) {
      for (const d of diagnostics) {
        if (!d.region) continue;
        const a = worldToScreen({ x: d.region.x, y: d.region.y }, view);
        const b = worldToScreen({ x: d.region.x + d.region.w, y: d.region.y + d.region.h }, view);
        const col = d.severity === 'error' ? '#dc2626' : d.severity === 'warn' ? '#d97706' : '#eab308';
        ctx.save();
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
```
Ajouter `diagnostics`, `showChecks` au tableau de dépendances du `useEffect` de rendu.

- [ ] **Step 4: Focus effect**

Après le `useEffect` de rendu, ajouter :
```ts
  useEffect(() => {
    const d = focusedDiagnostic;
    if (!d?.region) return;
    const pad = 80;
    const w = Math.max(d.region.w, 20), h = Math.max(d.region.h, 20);
    const scale = Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h);
    setView({ scale, ox: d.region.x - pad / scale, oy: d.region.y - pad / scale });
  }, [focusedDiagnostic, size]);
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: verts.

- [ ] **Step 6: Commit**

```bash
git add src/render/CanvasView.tsx src/App.tsx
git commit -m "feat(ui): surlignage des diagnostics sur le plan + recadrage au clic"
```

---

### Task 9: Régionaliser les joints collés + morceaux courts (finition)

Ajoute deux diagnostics porteurs de `region` : joint collé (< 6 cm) et morceau sous la coupe mini. Ils enrichissent le surlignage au-delà des seuls trous.

**Files:**
- Modify: `src/model/validate.ts`
- Test: script jetable `_v9.cjs`

**Interfaces:**
- Consumes: `result.placed[].rect: Point[]`, `result.placed[].usedLength: number`, `config.orientationDeg`, `config.minJointOffset`, `config.minCutLength`.
- Produces: diagnostics `joint-flush` (warn) et `piece-short` (info) avec `region`.

- [ ] **Step 1: Write the failing test**

Créer `_v9.ts` — deux lames voisines dont les joints coïncident (< 6 cm) :
```ts
import { validatePlan } from './src/model/validate';
const rect = (x0:number,y0:number,x1:number,y1:number) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
// orientation 0 : lames horizontales, rangées empilées en y. Joints en x.
const room: any = { points: rect(0,0,200,24), holes: [], partitions: [], spaceTags: [] };
const config: any = { orientationDeg: 0, expansionGap: 0, minJointOffset: 30, minCutLength: 25, minRipWidth: 5 };
const result: any = {
  spaces: [{ outer: rect(0,0,200,24), holes: [], excluded: false }],
  placed: [
    { rect: rect(0,0,100,12), usedLength: 100 }, { rect: rect(100,0,200,12), usedLength: 100 }, // rangée 1, joint x=100
    { rect: rect(0,12,101,24), usedLength: 101 }, { rect: rect(101,12,200,24), usedLength: 99 }, // rangée 2, joint x=101 → 1 cm de la voisine
  ],
  stats: { missingPlanks: 0, narrowRips: 0, stagger: { below: 0, target: 30 } },
};
const flush = validatePlan(room, result, config).filter((d) => d.kind === 'joint-flush');
console.log('joints colles:', flush.length, '| region?', !!flush[0]?.region);
// attendu : au moins 1, region definie
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx esbuild _v9.ts --bundle --platform=node --format=cjs --outfile=_v9.cjs && node ./_v9.cjs`
Expected: `joints colles: 0` — FAIL.

- [ ] **Step 3: Implement joint + short-piece diagnostics**

Ajouter dans `src/model/validate.ts` une fonction `jointDiagnostics(result, config)` qui :
```ts
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
```
Et un diagnostic morceaux courts, agrégé (pas de région, `info`) :
```ts
function shortPieceDiagnostics(result: LayoutResult, config: LayoutConfig): Diagnostic[] {
  const minCut = config.minCutLength ?? 0;
  if (minCut <= 0) return [];
  const n = result.placed.filter((p) => p.usedLength > 0.05 && p.usedLength < minCut - 0.05).length;
  return n > 0
    ? [{ severity: 'info', kind: 'piece-short', count: n, message: `${n} morceau(x) sous ${minCut} cm.` }]
    : [];
}
```
Dans `validatePlan`, avant `return out;` :
```ts
  out.push(...jointDiagnostics(result, config));
  out.push(...shortPieceDiagnostics(result, config));
```
Trier la sortie par gravité pour l'affichage : `const order = { error: 0, warn: 1, info: 2 }; out.sort((a, b) => order[a.severity] - order[b.severity]);` juste avant le `return`.

- [ ] **Step 4: Run to verify it passes**

Run: `node ./_v9.cjs`
Expected: `joints colles: 1 | region? true` (ou plus).

- [ ] **Step 5: Full bench + real plans (no regression)**

Run: `npx esbuild tools/bench-layout.ts --bundle --platform=node --format=cjs --outfile=_b.cjs && node _b.cjs --full`
Expected: colonne `errors` toujours 0. `npx tsc --noEmit && npm run build` verts.

- [ ] **Step 6: Commit**

```bash
rm -f _v9.ts _v9.cjs _b.cjs
git add src/model/validate.ts
git commit -m "feat(validate): joints colles regionalises + morceaux courts, tri par gravite"
```

---

### Task 10: Vérification visuelle + déploiement

**Files:** aucun (vérif) ; DEV_NOTES.

- [ ] **Step 1: Build and run the app**

Run: `npm run dev` puis charger un des JSON réels (bouton Importer), lancer le calepinage.
Expected : bandeau vert « ✓ Plan posable » (ou orange avec la liste), zéro cadre rouge de trou sur les 3 plans. Cliquer un diagnostic recadre le plan dessus.

- [ ] **Step 2: Document in DEV_NOTES**

Ajouter à `DEV_NOTES.md` une section « Validation du plan » : le module `validate.ts`, les gravités, la rastérisation de trous (constantes `STEP`/`ERODE`), et que le banc garde `errors = 0`.

- [ ] **Step 3: Commit + push**

```bash
git add DEV_NOTES.md
git commit -m "doc: validation du plan dans DEV_NOTES"
git push origin main
```

---

## Self-Review

**Spec coverage :**
- Modèle `Diagnostic` → Task 1 ✓
- Contrôles depuis stats (missing/rip/joint-offset) → Task 2 ✓
- Détection de trous (rastérisation) → Task 3, vérifiée Task 4 ✓
- Banc anti-régression `errors` → Task 5 ✓
- Store `diagnostics`/`focusedDiagnostic` → Task 6 ✓
- Bandeau + liste → Task 7 ✓
- Surlignage + clic-zoom → Task 8 ✓
- Joints collés régionalisés + morceaux courts → Task 9 ✓
- `samePlank` / `bandMax` en `info` : **partiellement couvert** — le spec les liste ; ils existent dans le banc mais ne sont pas encore dans `result.stats`. Décision : hors de ce plan (nécessiterait de les exposer dans `LayoutStats` d'abord). Noté comme suite possible, pas un manque bloquant — le cœur « confiance » (trous, refends, joints, lames manquantes) est couvert.
- Vérif visuelle → Task 10 ✓

**Placeholder scan :** aucun TBD/TODO ; chaque step de code montre le code complet.

**Type consistency :** `Diagnostic` défini Task 1, réutilisé partout ; `validatePlan(room, result, config)` stable ; `focusDiagnostic(d)` / `focusedDiagnostic` cohérents entre store (T6), ResultsPanel (T7), CanvasView (T8) ; `region: {x,y,w,h}` uniforme.

**Écart au spec assumé :** `samePlank` et `bandMax` (info) ne sont pas branchés faute d'être dans `LayoutStats` ; ajoutés plus tard si besoin. Tout le reste est couvert.
