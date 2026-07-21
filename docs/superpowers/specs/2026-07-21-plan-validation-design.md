# Validation du plan — auto-certification de la qualité

**Date :** 2026-07-21
**Statut :** design validé, en attente de relecture avant plan d'implémentation

## Contexte

L'outil de calepinage doit devenir **utilisable en autonomie par une seconde personne**
(Elsa), sans l'auteur derrière. Le point de blocage identifié : **faire confiance au
résultat**. Un plan sort, mais rien ne dit à l'utilisateur s'il est posable — y a-t-il un
trou, un joint fautif, un refend impossible ?

Cette session a montré le problème en creux : il a fallu un expert et une **rastérisation
jetable** pour découvrir des trous contre le mur que l'application ne signalait pas. Elsa ne
peut pas faire ça. Le plan doit **certifier sa propre qualité**.

Résultat attendu : un utilisateur non expert sait d'un coup d'œil si le plan est posable, et
voit OÙ sont les problèmes s'il y en a.

## Décisions de cadrage (validées avec l'utilisateur)

- **Objectif** : outil fini pour un usage autonome par Elsa (pas juste le chantier courant,
  pas encore un produit diffusable).
- **Friction n°1** : faire confiance au résultat.
- **Forme** : verdict global EN HAUT **et** surlignage des problèmes SUR le plan, avec
  clic → zoom sur le défaut.
- **Architecture** : couche de validation dédiée (approche A), indépendante du motif de pose.
- **Surlignage** : ON par défaut (une case permet de masquer).

## Architecture — approche A : couche de validation dédiée

Le diagnostic est une question sur le **résultat**, indépendante du motif qui l'a produit —
comme le banc de mesure et la rastérisation, qui marchent sur n'importe quel plan. Un module
`src/model/validate.ts` tourne après `computeLayout` et rend une liste typée de diagnostics.
Cette liste unique alimente les DEUX vues.

```
computeLayout → result ─┐
room, config ───────────┼→ validatePlan() → Diagnostic[]
                        │      ├→ ResultsPanel : bandeau de verdict + liste cliquable
                        └      └→ CanvasView : surlignage + zoom sur le défaut
```

`validatePlan` est mémoïsé et recalculé quand `result` change ; le tableau est stocké près
de `result` dans le store (`useStore`).

Approches écartées :
- **B (étendre `LayoutStats` au fil de l'eau)** : la logique « est-ce grave ? » se
  disperserait dans l'UI, pas de région pour surligner, et la détection de trous n'a pas sa
  place dans des stats agrégées. Ne tient pas la promesse « les deux ».
- **C (validation dans le moteur)** : couple le diagnostic au motif, à refaire pour chaque
  motif futur ; les trous se voient sur le résultat global, pas rangée par rangée.

## Modèle de données

```ts
interface Diagnostic {
  severity: 'error' | 'warn' | 'info';
  kind: string;                              // 'hole', 'joint-flush', 'rip-narrow'…
  message: string;                           // « Trou de 24×27 cm contre le mur »
  region?: { x: number; y: number; w: number; h: number }; // repère PIÈCE
  count?: number;                            // regroupe les défauts du même type
}

function validatePlan(room: Room, result: LayoutResult, config: LayoutConfig): Diagnostic[];
```

`region` est en repère pièce (pas repère de pose) pour piloter directement le surlignage et
le zoom.

## Contrôles et gravités

| Contrôle | Gravité | Source |
|---|---|---|
| **Trou** (sol non couvert au-delà du jeu de dilatation) | `error` | **nouveau** (rastérisation) |
| Lame manquante (stock insuffisant) | `error` | `stats.missingPlanks` (existe) |
| Refend sous la largeur mini, posé | `warn` | `stats.narrowRips` (existe) |
| Joint collé à la rangée voisine (< 6 cm) | `warn` | calcul stagger, à régionaliser |
| Joint sous le décalage demandé | `info` | `stats.stagger.below` (existe) |
| Morceau sous la coupe mini | `info` | à ajouter |
| Deux morceaux d'une même lame côte à côte | `info` | `samePlank`, à exposer |
| Bande de joints alignés (≥ 5 rangées consécutives) | `info` | `bandMax`, à exposer |

Sémantique des gravités :
- `error` = le plan est **faux** (trou, lame manquante) → on ne pose pas.
- `warn` = posable mais **coupe délicate** à prévoir.
- `info` = esthétique / confort, à l'appréciation du poseur.

Choix assumé : « joint sous le décalage demandé » est `info`, pas `error`. Avec un stock de
lames courtes, le décalage demandé n'est pas toujours atteignable (documenté dans
DEV_NOTES) ; en faire une erreur bloquerait des plans par ailleurs corrects.

Le **verdict** en découle mécaniquement :
- aucun diagnostic → 🟢 « Plan posable ✓ » ;
- que des `warn`/`info` → 🟠 « Posable — N points à vérifier » ;
- au moins un `error` → 🔴 « N erreur(s) à corriger ».

## Détection de trous (capacité neuve)

Seul contrôle sans code existant. Portage en fonction réelle de la rastérisation utilisée
comme script jetable cette session. `coverageHoles(result)` :

1. Rastériser à **0,5 cm** : deux grilles booléennes — `sol` (pièces non exclues, trous
   déduits) et `posé` (union des lames posées).
2. `manque = sol AND NOT posé`.
3. **Éroder 3× à 0,5 cm** (~1,5 cm de marge de chaque côté) : élimine tout ce qui fait moins
   de ~3 cm d'épaisseur → écarte le jeu de dilatation périphérique et les filets de rive
   légitimes. Ne restent que les VRAIS vides.
4. Composantes connexes → un `Diagnostic` `hole` par vide, avec sa bbox (`region`) et son
   aire dans le message.

Détails :
- **Coût** négligeable : une pièce de 8×5 m à 0,5 cm ≈ 160 000 cellules, deux passes + 3
  érosions, quelques ms — sans commune mesure avec `computeLayout`. Lancé une seule fois.
- **Rastérisation et pas `polygon-clipping`** : ce dernier PLANTE sur ces géométries (lames
  clippées, cloisons en L) — constaté cette session. La rastérisation est robuste, et le
  seuil d'érosion définit proprement « qu'est-ce qu'un vrai trou », ce que le clipping exact
  ne sait pas faire (il compterait le jeu de 0,75 cm comme un trou).
- **Réutilise** `pointInPolygon` (`src/model/geometry.ts`) et `result.spaces` : la fonction
  reste petite (~60 lignes) et ne dépend que du résultat, pas du moteur.
- Le seuil d'érosion est une **constante nommée** interne, alignée sur le jeu de dilatation.
  Pas exposé à l'utilisateur.

## UI

### Bandeau de verdict + liste — `ResultsPanel`

En tête du panneau, un bandeau coloré selon le pire diagnostic (vert / orange / rouge).
Dessous, la liste groupée par type, une ligne par groupe : « ⚠ 1 trou contre le mur »,
« 4 refends fins »… Chaque ligne est **cliquable**. Réutilise les styles `.alert` / `.note`
existants ; ajoute une classe verte pour le cas sain.

### Surlignage sur le plan — `CanvasView`

Nouvelle fonction de dessin appelée en fin de boucle de rendu, qui parcourt les diagnostics
porteurs d'une `region` :
- trou → cerné rouge + hachures ;
- joint collé → segment orange ;
- refend fin → contour jaune.

Régi par une case « Vérifications » dans l'en-tête (comme « Cotes des cloisons »).
**ON par défaut** ; la case permet de masquer.

### Clic → zoom

Cliquer une ligne de la liste recadre le canvas sur la `region` du diagnostic. Réutilise
`zoomAt` / la logique de `fit` déjà présentes. État partagé `focusedDiagnostic` **dans le
store** (`useStore`), là où vit déjà `result` — `ResultsPanel` l'écrit au clic, `CanvasView`
le lit pour recadrer. Cohérent avec le reste de l'app, pas de remontée d'état ad hoc.

## Réutilisation de l'existant

- `pointInPolygon`, `polygonBBox` (`src/model/geometry.ts`)
- `result.spaces`, `result.placed`, `result.stats` (`stagger`, `narrowRips`, `missingPlanks`)
- `zoomAt`, `worldToScreen`, `roundRect`, structure de cases d'en-tête, styles `.alert`/`.note`
- Le banc `tools/bench-layout.ts` et ses métriques (`bandMax`, `samePlank`, `uncoveredM2`)

Neuf à écrire : `src/model/validate.ts`, une fonction de dessin dans `CanvasView`, le
bandeau + liste dans `ResultsPanel`, l'état `focusedDiagnostic`, une case d'en-tête.

## Tests et vérification

- **Banc** (`tools/bench-layout.ts`) : ajouter un appel à `validatePlan` et vérifier que le
  nombre de diagnostics `error` reste **0** sur les 120 simulations + les 3 JSON réels.
  Garde-fou anti-régression permanent : si un futur changement rouvre un trou, le banc le
  voit.
- **Tests ciblés de `validate.ts`** (scripts Node jetables, méthode DEV_NOTES) :
  - plan sain → 0 diagnostic ;
  - plan avec trou fabriqué (retirer une lame) → 1 `error` `hole`, bbox correcte ;
  - rive dans la zone morte → 1 `warn` `rip-narrow` ;
  - seuil d'érosion : un filet de rive de 0,8 cm ne compte PAS comme trou, un vide de 3 cm oui.
- **Vérif visuelle** dans l'app sur les 3 plans réels, empreinte de version à l'appui :
  bandeau et surlignage doivent coïncider avec la rastérisation de cette session (0 trou).
- **Non-régression** : `tsc --noEmit` + `npm run build` verts, banc 120 sims sans dégradation
  des métriques existantes.

## Hors périmètre (YAGNI)

- Onboarding / tutoriel de traçage (friction différente, non retenue).
- Refonte des réglages (autre friction).
- Export PDF d'une fiche de contrôle (envisagé, non retenu à ce tour).
- Correction AUTOMATIQUE des défauts : ici on DÉTECTE et on SIGNALE ; corriger reste piloté
  par l'utilisateur via les réglages.
