# Calepinage parquet — notes de développement

Mémoire de travail. À lire avant de toucher au rendu des murs/cloisons ou à la géométrie.
App : React + Vite + TypeScript, rendu Canvas 2D. Store Zustand (`src/store/useStore.ts`).
Déploiement : GitHub Pages via GitHub Actions (push sur `main`) → https://dahnmills.github.io/calepinage/

---

## Règles métier NON négociables (validées par l'utilisateur, après plusieurs allers-retours)

### Cloisons (partitions) — cotées par la FACE, jamais par l'axe

- Le tracé d'une cloison = **une FACE**, pas l'axe centré. L'épaisseur part d'**un seul côté**.
  `align: 'center'` est **interdit** (l'épaisseur à cheval ±½ sur le trait = rejet catégorique).
- Une longueur tracée de 290 = **290 sur la face**. On n'ajoute ni ne soustrait jamais une
  demi-épaisseur ni l'épaisseur d'un bras perpendiculaire.
- Cloison en **L** : les dimensions **extérieures = les longueurs tracées**. Un L de 60×30
  encombre **60×30** ; l'épaisseur du bras perpendiculaire rentre DANS le creux, ne déborde pas.
  L'intérieur d'un bras au coin = longueur − épaisseur.
- Côté de l'épaisseur = **déduit automatiquement de l'aire signée** de la polyligne (vers le
  concave/creux), donc correct quel que soit le sens de tracé. Une cloison droite (aire ≈ 0)
  garde le réglage `left`/`right` (bouton dans l'outil Cloison).
- Coins : **onglet plein soudé**. Le remblai d'angle PASSE PAR le sommet V (arête partagée
  avec chaque bras) → l'union donne **1 seul tracé** au lieu de morceaux. Angle très aigu →
  chanfrein plafonné (`miterLimit = 3`).

**Pourquoi :** l'utilisateur raisonne comme un vrai mur maçonné, pas comme une polyligne
épaissie au centre. Toute cote qui tombe sur 296.7 / 289.2 / 67 au lieu de 290 / 60 est un bug.

Implémentation : `partitionRects` dans `src/model/geometry.ts` (rectangles d'arête sans
rallonge + remblai d'onglet par sommet + choix du côté par aire signée).

### Murs extérieurs (périmètre)

- `drawExteriorWalls` dans `src/render/CanvasView.tsx`. `poly` = nu **intérieur**, l'épaisseur
  part vers l'extérieur.
- Bande = **différence(anneau extérieur en onglet, nu intérieur)** via `polygon-clipping`.
  Une seule région pleine par construction → pas de décrochage entre murs. Onglet plafonné
  (`miterLimit = 3`), chanfrein au-delà (angles aigus).

### Sommets dupliqués — toujours dédoublonner

L'outil de tracé génère parfois des **sommets consécutifs identiques** (double-clic / accroche).
Arête de longueur 0 → direction indéfinie → normales fausses → coins qui décrochent.
Helper `dedupePoints` (`src/model/geometry.ts`), appliqué :
- au rendu des murs (`drawExteriorWalls`) et dans `partitionRects` ;
- à la source : `closeRoom`, `closePartition`, `loadInto` (`src/store/useStore.ts`).

**Tout nouveau code consommant `room.points` ou `partition.points` doit passer par `dedupePoints`.**

---

## Garde-fou anti-page-blanche

- `src/ui/ErrorBoundary.tsx` enveloppe `CanvasView` dans `App.tsx` : un crash de rendu montre
  le message exact + boutons Réessayer/Recharger, au lieu d'une page blanche muette.
- La boucle de dessin (grand `useEffect` de `CanvasView`) est en **try/catch** : une frame qui
  échoue est logguée (`[calepinage] échec de rendu…`) sans tuer l'app.

Note : un warning React « Cannot update ConfigPanel while rendering CanvasView » existe
(setState-in-render) mais est bénin ; pas la cause d'un crash fatal observé.

---

## Méthode de test géométrie (à réutiliser)

Scripts Node jetables qui importent `polygon-clipping` : les lancer **depuis le dossier
projet** (`node ./_wtest.mjs` puis `rm`), pas depuis le scratchpad, sinon `node_modules` ne
résout pas. Vérifier systématiquement AVANT de livrer :
- `union.length === 1` (soudure propre, pas de morceaux) ;
- l'**encombrement (bbox)** = les longueurs tracées (pas de débord d'épaisseur) ;
- `tsc --noEmit` + `npm run build` verts.

Pour reproduire un bug précis : demander le JSON (bouton 💾 Exporter) et rejouer la forme
exacte au lieu de deviner.

---

## Historique des correctifs (commits clés)

- Murs : dédoublonnage des sommets (fin des coins qui décrochent).
- Murs : bande = différence(anneau extérieur, nu intérieur) — jonctions pleines.
- Cloisons : emprise = longueur tracée exacte (fin de la rallonge ½ épaisseur aux jonctions).
- Cloisons : trace = FACE (fin du centrage axe) + onglet plein soudé (remblai par sommet V).
- Cloisons : épaisseur vers le creux du L (dimensions ext = longueurs tracées, côté par aire signée).
- Garde-fou ErrorBoundary + try/catch sur la boucle de rendu.

---

## Points ouverts / à surveiller

- Page blanche signalée par l'utilisateur en dessinant une cloison : **non reproductible** en
  session fraîche (tracé, saisie de valeur, L, terminaison OK). Garde-fou posé ; si ça revient,
  l'erreur sera visible → récupérer le message exact.
- Warning setState-in-render (ConfigPanel↔CanvasView) : à nettoyer un jour (bénin).
- Cloisons existantes enregistrées en `align: 'center'` : `partitionRects` recalcule le côté
  depuis la géométrie, donc elles s'affichent correctement sans migration.
