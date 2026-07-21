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

## Calepinage — décalage des joints

### Banc de mesure — `tools/bench-layout.ts`

    npx esbuild tools/bench-layout.ts --bundle --platform=node --format=cjs \
      --outfile=_b.cjs && node _b.cjs --full   # 120 simulations

**Ne jamais toucher à l'algorithme sans passer ce banc avant/après.** Un calepinage
CONFORME n'est pas forcément BEAU : le banc mesure donc les deux.

| Métrique | Ce qu'elle attrape |
|---|---|
| `viol1Pct` | joints sous le décalage minimal vs rangée voisine — la règle dure |
| `flush1` | joints à moins d'1 cm de la voisine — alignement franc |
| `align2Pct` | joints alignés avec la rangée n±2 — **joint en « H »** (NWFA) |
| `repeat2Pct` | rangée qui reproduit la n−2 → **périodicité**, l'appareil « en brique » |
| `staircase` | ≥3 rangées dont les joints dérivent d'un pas constant → **effet escalier** |
| `medGap` | écart médian au joint voisin : plus haut = plus aéré |
| `wastePct`, `cuts`, `underMinCut` | le coût matière de tout ça |

### La cause racine : `near` était TOUJOURS VIDE

Les plages de matière étaient calculées **case par case** (une case = une longueur
nominale). `run.end` ne dépassait donc jamais le bout de la CASE, et `rowMaxX` — censé
être le mur du fond — valait la fin de la case courante. Or un joint n'était enregistré
que si `endX < rowMaxX` : condition FAUSSE pour toute lame remplissant sa case. **Aucun
joint n'était mémorisé, `jointsByRow` restait vide, la contrainte de décalage ne
s'appliquait jamais.** Avec un stock uniforme, toutes les rangées sortaient identiques.

→ `planRow` clippe désormais la rangée ENTIÈRE (`band` de `bb.minX` à `bb.maxX`) une seule
fois. Un joint = une fin de lame qui ne ferme pas sa plage.

### Les autres correctifs, tous validés au banc

- `fixJoint` était derrière le `??` : appelé seulement quand la lame entière manquait,
  c.-à-d. jamais quand il fallait couper. Calculé avant, il décide entre lame et coupe.
- `fixJoint` ne testait que « pile à ±minOffset d'un joint » ; ces points tombent souvent
  dans la plage interdite d'un AUTRE joint → aucun candidat. Il teste aussi `len`,
  `minCut`, `maxLen`.
- `fixJoint` reçoit la rangée n±2 (`far`) : sans elle, dès la voisine satisfaite il ne
  coupait plus et la rangée reproduisait la n−2. **Deux rangs de priorité, jamais
  mélangés** : n±1 est une RÈGLE, n±2 une PRÉFÉRENCE. Les traiter à égalité faisait
  sacrifier la première (viol1 remontait à 14,5 %).
- Terme **anti-escalier** dans `score` : pénalise le décalage qui reproduit celui de la
  rangée précédente, signe compris (`driftByRow`, médiane par rangée).
- `room` (cellule) et `avail` (matière continue restante) séparés.

Poids réglés par **balayage de 30 configurations × 12 simulations**, pas à la main :
`H_JOINT_MIN = 10` (valeur NWFA — elle gagne aussi empiriquement), pénalité escalier
−120, pénalité n±2 −300.

### Résultat mesuré — 120 simulations

| | avant | après |
|---|---|---|
| joints fautifs | **52,0 %** | **5,6 %** |
| joints collés (<1 cm) | 77,9 | 2,3 |
| joints en « H » (n±2) | 52,2 % | 7,9 % |
| rangées périodiques | 43,5 % | 0,5 % |
| écart médian | 21,9 cm | 39,3 cm |
| chute perdue | 3,1 % | 3,7 % |
| coupes | 40,5 | 70,8 |
| bouts sous `minCut` | 3,4 | 1,9 |

Casser des joints alignés avec un stock à longueurs rondes SUPPOSE de couper : la hausse
des coupes est l'arbitrage, pas un effet de bord.

### Essayé, mesuré, ABANDONNÉ

- **Anticipation à 2 crans** dans `leavesAWay` : 5,6 % → 5,7 %, et plus de chute. Inutile.
- **Ramener la 1ᵉʳᵉ lame sur une trame décalée** (pour faire vivre `offsetMode`) : les
  joints fautifs remontaient à ~23 % et les bouts sous `minCut` de 13 à 18.

### Recherche locale par rangée

`planRun` découpe une plage ENTIÈRE sur une **copie** du stock (`Inventory.availableCounts`,
qui rend les longueurs AVEC leur nombre — sans les comptes, une simulation réutiliserait dix
fois la dernière lame de 160). On tire `RUN_ATTEMPTS = 12` découpages, on note la plage
entière (`scoreRun`) et on garde la meilleure. C'est le « racking » du poseur : présenter la
rangée à sec avant de clouer.

Sans exploration, les 12 essais rendaient le MÊME découpage (le tirage ne départageait que
les ex æquo). `chooseLength` tire donc au sort parmi les choix dont la note est à moins de
`EXPLORE_MARGIN = 30` du meilleur — marge très inférieure à la pénalité de faute (−1000),
donc un choix fautif ne peut jamais entrer dans le tirage.

Gain réel mais modeste : 5,6 % → 5,2 % de joints fautifs sur 120 simulations.

### Un plan doit TOUJOURS être posable

Règle posée par l'utilisateur : « il faut toujours que ce soit faisable, le parquet je dois
le poser ». Un plan « conforme mais impossible » n'a aucune valeur.

**Objectif max-min, jamais de relâchement du seuil.** Abaisser `minJointOffset` par paliers
dès qu'il coince a été implémenté et MESURÉ : c'est pire (11,3 % de joints sous la valeur
demandée contre 5,2 %), car toute la rangée se rabat sur le seuil dégradé, y compris là où
la valeur demandée passait. On garde donc la cible et on classe les découpages par :
1. le moins de fautes, 2. le PLUS GRAND écart minimal, 3. la note.
Là où c'est faisable on obtient la valeur demandée ; ailleurs, le meilleur écart possible.

**Lames fantômes de 8 mm — corrigé.** `planRun` bouclait tant que `x < runEnd - 1e-3` : un
reliquat de 0,8 cm (la dilatation périmétrique) donnait une lame de 0,8 cm en bout de plage.
Invisible comme lame, mais elle créait un FAUX joint collé à celui de la rangée voisine —
c'est ce que l'utilisateur voyait. La boucle s'arrête maintenant dans la tolérance de coupe,
et un talon plus court que `minCut` est absorbé dans la lame précédente.
Effet : plus AUCUNE lame sous `minCut` sur 120 simulations (3,4 en moyenne avant), et les
joints collés passent de 21 à 4 sur le plan réel `(3)`.

`JOINT_PENALTY = 60` : coût d'un joint de plus dans une plage. Moins de joints = décalage
plus facile à tenir. Valeur retenue au banc sur 600 simulations, meilleure sur TOUS les
indicateurs à la fois.

### La limite qui reste : le stock

Sur le plan réel `(4)`, en ne faisant varier QUE `minJointOffset` :

| minJointOffset | joints fautifs |
|---|---|
| 15 cm | 0,4 % |
| 20 cm | 4,2 % |
| **24 cm** (= 2 × largeur, valeur DTU) | **9,1 %** |
| **30 cm** (valeur fabricant, réglage actuel) | **23,3 %** |
| 35 cm | 49,6 % |

Le stock est dominé par des lames COURTES (81 × 60 cm, 57 × 80, 55 × 90 ; 2 × 120 seulement).
Dans une plage de 304 cm cela fait 4 joints par rangée. Or 4 joints voisins interdisent
chacun ±30 cm, soit 240 cm d'exclusion sur 304 cm utiles. La contrainte est sur-spécifiée
pour ce stock : c'est le réglage (24 cm) ou le stock (lames plus longues) qu'il faut
corriger, pas l'algorithme.

### Réparation ciblée des joints collés

Quand un joint reste trop près de la rangée voisine, relancer des tirages au hasard ne sert
à rien : ils cherchent partout sauf là où ça coince. `repairRun` déplace CE joint en
rééquilibrant les deux lames qui l'encadrent — la longueur totale des deux est conservée,
donc rien en amont ni en aval n'est touché.

Deux garde-fous, tous deux issus de la mesure :
- **Ne réparer QUE sous `REPAIR_BELOW = 6` cm.** Réparer aussi les joints juste sous la
  règle dégrade l'ensemble (5 % → 10 % de joints sous la cible) : le déplacement modifie la
  lame suivante, donc les joints que la rangée d'après devra éviter.
- **N'accepter la réparation que si elle n'aggrave rien** (`violations <=` ET `minGap >`).

Balayage sur 720 simulations : joints collés **1,87 → 0,33** (−82 %) pour +0,16 point de
joints sous la cible, sans chute ni coupe supplémentaire.

`RUN_ATTEMPTS_HARD = 60` : effort supplémentaire uniquement sur les plages où la contrainte
ne passe pas du premier coup.

### État mesuré — 120 simulations

| | avant tout | maintenant |
|---|---|---|
| joints fautifs | 52,0 % | **5,2 %** |
| joints collés | 77,9 | **0,3** |
| joints en « H » (n±2) | 52,2 % | **6,6 %** |
| rangées périodiques | 43,5 % | **0,2 %** |
| lames sous `minCut` | 3,4 | **0** |
| écart médian | 21,9 cm | **40 cm** |
| chute perdue | 3,1 % | 3,4 % |

### Restitution à l'utilisateur

`LayoutStats.stagger` (calculé dans `staggerStats`, `layout.ts` — vrai pour n'importe quel
motif) : écart minimal, médian, nombre de joints sous la cible, et la valeur conseillée
`2 × largeur de lame`. Affiché dans le panneau Résultats, en alerte si le minimum passe
sous 6 cm. **Un plan silencieusement dégradé est pire qu'un plan qui annonce ce qu'il
tient** : le décalage demandé n'est pas toujours atteignable, l'utilisateur doit le savoir.

Le `ConfigPanel` propose la valeur DTU en un clic quand le réglage la dépasse.

### Refends inposables, provenance des lames, `prevDrift` unidirectionnel

**`prevDrift` ne lisait qu'un côté** (`straight.ts`) alors que `near` lit les deux. Avec une
ligne de départ, la passe `up()` remonte en y décroissant : sa voisine déjà tracée est de
l'autre côté. `prevDrift` valait donc `Infinity` sur TOUTE la moitié `up()`, et les gardes
`Number.isFinite(prevDrift)` y désarmaient silencieusement l'anti-escalier. Corrigé en
lisant les deux voisines. Effet mesuré : escalier 3,4 → 1,7.

**Filets de refend inposables.** Aucune largeur minimale n'existait : `isRipped` était
seulement CONSTATÉ après clip. Le banc mesurait 0,2 cm de large sur les deux plans réels —
une bande qui casse à la scie. Deux mécanismes :
- `balanceEdges` décale la trame (au demi-millimètre, sur une période) pour que les DEUX
  rives soient posables. Existait sans ligne de départ ; avec une ligne de départ, la trame
  était ancrée telle quelle et la dernière rangée recevait ce qui restait.
- `layout.ts` ÉCARTE du plan les lames dont la largeur visible reste sous `minRipWidth` :
  elles tombent en rive, sous la plinthe et dans le jeu de dilatation. Les annoncer
  reviendrait à demander de scier une bande de 2 mm. Comptées dans `stats.droppedSlivers`.

**Provenance des lames.** `Inventory.request` servait les chutes en best-fit sans savoir
d'où elles venaient : la chute de la rangée N est MÉCANIQUEMENT le meilleur ajustement pour
la rangée N+1, donc les morceaux A et B d'une même lame finissaient systématiquement côte à
côte (même veinage, même teinte). `takeExact` et `request` acceptent désormais un ensemble
`avoid` de `plankNo`, alimenté par les rangées voisines.

### Rives : jamais de vide, jamais de filet inposable

Deux garde-fous distincts, tous deux issus d'écarts signalés en capture.

**`solveEdges` recale la trame pour qu'aucune rive ne tombe dans la ZONE MORTE.** Une rive
est acceptable si elle disparaît dans le jeu de dilatation (≤ `expansionGap`, la lame va
jusqu'au mur) OU si elle est assez large pour être sciée (≥ `minRipWidth`). Entre les deux :
trop grande pour être cachée (vide visible — le « 1,7 cm inacceptable »), trop petite pour
une coupe propre. `solveEdges` cherche le PLUS PETIT décalage qui sort les deux rives de
cette zone. C'est de la FAISABILITÉ, donc appliqué même sans `optimizeStart` — un vide n'est
pas une préférence. Avant, l'équilibrage était conditionné à `optimizeStart` (que
l'utilisateur avait désactivé), la trame restait ancrée sur la ligne de départ et la rive
opposée tombait à 0,8 cm.

**`sliverMax = gap + 0.1`** (`layout.ts`) : on n'écarte du plan QUE ce qui tient dans le jeu
de dilatation. Un `Math.max(gap, 1)` avait été essayé — il écartait une rive de 0,8 cm quand
le jeu n'en faisait que 0,75, laissant un vide sur une pièce en L (deux niveaux de mur haut
à distance non multiple de la trame : `solveEdges` global ne peut pas régler les deux à la
fois). Règle absolue : au-dessus du jeu, la lame est POSÉE, fût-elle fine (comptée dans
`narrowRips`). Un filet fin est laid ; un vide est un plan faux.

État sur les trois plans réels : zéro trou, refend le plus étroit 6,8 à 7,8 cm, aucune
rangée fine résiduelle, aucun morceau sous `minCut`.

### Un calepinage ne doit JAMAIS laisser un trou — règle absolue

Trois manières d'y arriver ont été commises puis corrigées. À ne pas refaire.

1. **Écarter un filet trop large.** Les filets sous `minRipWidth` étaient tous retirés du
   plan, « puisque la plinthe les couvre ». Vrai pour 3 mm, FAUX pour 2,7 cm : il restait un
   vide visible contre le mur. On n'écarte plus que ce qui tient dans le **jeu de
   dilatation** (`max(expansionGap, 1)` cm) ; au-delà la lame est POSÉE et comptée dans
   `stats.narrowRips`, pour que le poseur sache ce qu'il devra tailler.

2. **S'arrêter au bout du découpage prévu.** La boucle de pose parcourait `bestLens` avec un
   `for`. Or la simulation raisonne sur une COPIE du stock : à la pose, `request` peut
   fournir moins (chute plus courte, lot épuisé), le découpage se décale et la plage se
   terminait AVANT le mur. Trous mesurés jusqu'à 24 × 27 cm contre le mur du fond.
   → La boucle tourne maintenant **jusqu'à couvrir la plage**, avec un `fallback()` soumis
   aux mêmes règles que le choix normal (ne pas dépasser, ne pas laisser de reliquat
   inposable).

3. **Boucher le trou avec un confetti.** Le rattrapage a d'abord produit des morceaux de
   3,4 cm — aussi inposables que le vide qu'ils comblaient. Deux gardes :
   - avant de poser, si le reste APRÈS cette lame serait < `minCut`, on **allonge** la lame
     jusqu'au mur ;
   - si le stock fournit moins que demandé et que le reliquat tomberait sous `minCut`, on
     **raccourcit** cette lame pour que la suivante fasse au moins `minCut`.

   Résultat : plus AUCUN morceau sous `minCut` sur les trois plans réels (la plus courte
   vaut exactement `minCut`), et zéro trou.

**Le banc doit vérifier la COUVERTURE.** `uncoveredM2` a été ajouté, mais il inclut le jeu
périphérique et reste donc trop grossier pour attraper un trou de 20 cm². Le contrôle qui a
réellement servi est une **rastérisation à 0,5 cm avec 3 érosions** (ne garde que les vides
de plus de 3 cm d'épaisseur, donc ni le jeu de dilatation ni les filets de rive). À refaire
sur les JSON réels après toute modification de la boucle de pose.

### Seuils — sources vérifiées

| Contrainte | Valeur | Statut |
|---|---|---|
| Largeur mini rangée de rive | **5 cm** | Quick-Step, *Installation Guide* p. 4 : « the width of the first and last row should be at least 5 cm ». **Aucun NF DTU ne fixe cette valeur** — le « 5 cm du DTU » qui circule est une invention. |
| Longueur mini pièce en bout | **20 cm** | Quick-Step p. 4 (« more than 20 cm ») + Pergo (8"). Aucun NF DTU. |
| Décalage mini joints | **max(2 × largeur, 30 cm)** | 2 × largeur = **NF DTU 51.11 §5.2** (seul chiffre normatif FR) ; 30 cm = Quick-Step / Pergo. Deux règles distinctes, prendre le max. |
| Équilibrage des rives | si reste < largeur mini, répartir sur les deux rives | EGGER : « cut the first row so both the first and last rows are of a similar width ». Le SEUIL exact n'est donné par aucune source — déduit. |

### État mesuré — 120 simulations, banc identique des deux côtés

| | avant | après |
|---|---|---|
| morceaux d'une même lame voisins | 2,2 | **0** |
| refend le plus étroit | 8,5 cm (**0,2 cm** sur les plans réels) | **9,1 cm** (6,8 et 7,8 sur les réels) |
| effet escalier | 3,4 | **1,7** |
| joints en « H » | 7,0 % | **7,5 %** |
| joints sous la cible | 5,2 % | 6,1 % |
| chute perdue | 3,4 % | 4,5 % |
| coupes | 68,5 | 97,1 |

Le coût est réel et concentré sur `avoidSamePlank` : mesuré isolément, ce seul réglage vaut
+0,9 pt de joints fautifs, +1,1 pt de chute et +41 % de coupes. D'où le **réglage** dans
l'UI plutôt qu'une règle en dur.

### Ce que le banc ne reproduit PAS

`bandMax` (plus longue série de rangées consécutives portant un joint au même endroit) reste
à **1,2** avant comme après, sur 120 simulations et sur les deux plans réels. **La bande
d'une dizaine de rangées observée en capture n'a jamais été reproduite.** Le correctif
`prevDrift` est un vrai bug corrigé, mais rien ne prouve qu'il en était la cause. Piste
restante : la capture pouvait précéder le déploiement. À revérifier sur un plan recalculé.

### Ce qui RESTE ouvert
### Règles de l'art — sources

- **NF DTU 51.2 §6e / 51.11 §5.2 (coupe perdue)** : décalage ≥ **2 × la LARGEUR de lame**,
  et non une constante. Pour 12 cm de large → 24 cm. Plancher de 10 cm si le stock
  contient des lames < 40 cm. → `minJointOffset` devrait avoir pour défaut
  `max(2 × largeur, 30)` et non 30 en dur.
- **NWFA** (guidelines 2025) converge sur la même formule `2 × largeur`, et proscrit
  explicitement les joints en « H » et les « equal end-joint offsets in sequential rows ».
- **Quick-Step / Pergo** : ≥ 30 cm, plus exigeant que le DTU. La notice fabricant prime
  (garantie) → garder 30 cm comme plancher par défaut est défendable.
- **DTU 51.11** : avec un stock multi-longueurs, la pose par défaut est la **coupe
  perdue** — un motif régulier au tiers n'a alors aucune base. Le **1/2 (« coupe de
  pierre », DTU 51.2 §6d)** est lui normatif : décalage d'une demi-longueur à 3 mm près,
  rangées n et n+2 alignées à 2 mm près. Il suppose des lames toutes identiques.
- Aucune valeur normative française pour la longueur minimale de lame ; Pergo impose 8"
  (≈ 20 cm). Le « 30 cm » courant est un usage — ne pas l'afficher comme normatif.

---

## Validation du plan

### Module `validate.ts` — structure

Le module `src/model/validate.ts` exporte `validatePlan(room, result, config): Diagnostic[]`
qui contrôle un plan posé (géométrie + layout) et retourne une liste de diagnostics.

Trois **niveaux de sévérité** :
- **`error`** : le plan est FAUX (trou, lame manquante, refend inposable). Ne pas poser.
- **`warn`** : posable mais coupe DÉLICATE (refend fin < 6 cm, joint collé trop proche du mur,
  joint collé entre deux rangées non contiguës). À relire avant de poser.
- **`info`** : esthétique ou confort (décalage sous la cible annoncée, morceaux trop courts,
  bande de joints alignée sur 3+ rangées). À connaître.

Chaque `Diagnostic` carry un **type** (`missing` / `rip` / `stagger` / etc.), une **sévérité**,
un **message** (texte UI), et une **région** (`region: {x, y, w, h}` en coordonnées du plan
pièce par pièce) pour le surlignage et le zoom sur clic.

### Détection de trous — rastérisation

Contrairement aux contrôles de joints ou de dimensions (calculés depuis les stats), les trous
sont détectés par **rastérisation raster** de la géométrie de couverture :
- **`STEP = 0.5` cm** : résolution de la grille (un pixel = 0,5 × 0,5 cm).
- **`ERODE = 3` érosions** : applique une opération morphologique pour n'accepter que les vides
  d'au moins 3 cm d'épaisseur (filtre les joints, le jeu de dilatation, ne garde que les trous
  vrais). Codé en Python, appelé via `child_process.spawn`.

Cas d'usage : `polygon-clipping` plante sur certaines géométries dégénérées (cloisons fines,
L-shaped rooms complexes, accumulation d'erreurs flottantes) ; la rastérisation est plus
robuste. Mesures sur JSON réels : zéro faux positif, détection 100 % des trous > 20 cm².
Les coordonnées de la région sont en **coordonnées de la pièce** (pas d'offset cloisons) pour
l'affichage sur canevas.

### Garde-fou `joint-flush` — régionalisation

Le contrôle « joint collé » (< 0,6 cm du mur) était FAUX en chambre L : il signalait un joint
collé À UN MUR alors qu'il était en fait à distance correcte du mur OPPOSÉ (donc recalage légitime
d'une sous-plage). Solution : **chaque rangée est limitée à sa bande de hauteur** (`rowH`).
Une rangée n'échange un `flush` avec sa voisine que si elle se chevauchent en Y :
`rowH + 0.6` (au lieu d'un test global).

**Impact mesuré** : suppression des faux positifs sur plans L-shaped sans dégradation des
vrais positifs.

### Banc anti-régression — `tools/bench-layout.ts`

Le banc tourne 120 simulations (`--full`) sur un stock synthétique. **Garde-fou absolu** :
`holes = 0` sur TOUS les plans. Le benchmark retourne une colonne `errors` (nombre de
diagnostics non-`info`) pour tracer les régressions.

Sur cas synthétiques sans stock (forçage de `missing`), `errors > 0` est légitime et attendu :
c'est le plan qui le demande, pas une régression du code. Le banc PASSE si `holes = 0` et
si `errors` ne dégradent pas le trend historique.

Mettre à jour après toute modification de la pose ou de la géométrie :

    npx esbuild tools/bench-layout.ts --bundle --platform=node \
      --outfile=_b.cjs && node _b.cjs --full

### UI — verdict et navigation

**Banneau de verdict** (`ResultsPanel`) : bandeau vert « ✓ Plan posable » si aucun `error` /
`warn`, orange avec compte des diagnostics par sévérité sinon. Cliquable pour ouvrir la liste.

**Liste diagnostics** : chaque ligne affiche type + message + sévérité. Un clic sur un
diagnostic appelle `focusDiagnostic(d)` → store + CanvasView.

**Surlignage sur canevas** (`CanvasView`) :
- Dashed rectangle (`strokeDasharray: '2,2'`) autour de la région du diagnostic.
- Couleur par sévérité (red pour error, orange pour warn, blue pour info).
- Clic sur le rectangle `focusDiagnostic(d)` et **recentre le canevas** (`view` passe à
  center + zoom × 1,5).

**Header checkbox** (`CanvasView`, onglet Rendu) : case « Vérifications » (activée par défaut)
qui toggle l'affichage des dashed rectangles. Permet de lire le plan sans annotation.

---

## Cotes automatiques (orange, face à face)

- Affichées **aussi après le calepinage**. Elles étaient masquées par un `!result` : or
  c'est justement une fois les lames posées qu'on relit le plan et qu'on vérifie ses
  écarts. Seule la case « Cotes des cloisons » (`showGaps`) les régit.
- **Corrigeables au chiffre.** Cliquer une cote orange (outil Édition) ouvre une saisie :
  la cloison mesurée se translate le long du rayon de la cote jusqu'à ce que l'écart net
  vaille exactement la valeur tapée. Le rayon va de la face vers l'obstacle, donc avancer
  de `dist − cible` referme l'écart d'autant (`commitGapEdit` → `moveWholePartition`).
  Toute la cloison bouge, un L garde sa forme. C'est la seule façon d'obtenir 117 pile :
  au glissement souris, le pas minimal vaut `1 / view.scale` cm.
- `drawPartitionGaps` remplit `gapLabels` (position écran, écart, cloison, direction) —
  même mécanique que `edgeLabels` pour les cotes de murs.
- La cloison de synthèse qui donne les cotes vives AVANT le 2ᵉ point s'appuie sur
  `perpToNearestSupport` : périmètre **et** faces de cloisons. Limité au périmètre, partir
  d'une cloison ne produisait aucune cote vive.

---

## Aimants (accroche) — règles

- Les guides d'accroche du tracé ET de la mesure sont les **faces** des cloisons
  (`partitionRects`), jamais le tracé (`partition.points`). Le tracé n'est qu'UNE face :
  s'y limiter interdit d'ancrer de l'autre côté, et la cloison démarrée là est alors trop
  courte de l'épaisseur traversée.
- Le seuil d'accroche se mesure **en pixels écran**, pas en cm. Un plancher en cm ne
  rétrécit pas au zoom : zoomer n'apporte alors aucune précision et l'aimant happe tout ce
  qui passe (bug « je vise 117, la face est à 119,8, ça colle sur la face »).
  Mesure : `min(8 / view.scale, 25)` cm, `guideThreshold: 0`.
  Tracé : `guideThreshold: 2` cm — juste de quoi absorber un décroché millimétrique.
- **Résolution de travail = le dixième de cm.** `cursorCm` était arrondi au **cm entier**
  alors que le clic partait du curseur **brut** : l'aperçu ne pouvait tomber que sur des
  positions entières (la cote sautait de ~1 cm, valeurs intermédiaires inatteignables) et
  la valeur lue ne correspondait pas à celle enregistrée (173,6 à l'écran → 173,5 posé).
  Aperçu, valeur affichée et clic passent maintenant tous par **`measurePoint()`**, avec
  la même entrée arrondie au dixième (`tenth()`). Ne jamais court-circuiter ce chemin.
- **Viser à la souris est borné par le pixel** : le pas minimal vaut `1 / view.scale` cm.
  Dézoomé (~1 px/cm), les valeurs au dixième sont inatteignables quel que soit le soin.
  D'où la **saisie clavier de la cote** (`measureLen`) : taper une longueur + Entrée pose
  le 2ᵉ point à la distance exacte, dans la direction visée. C'est la seule voie fiable.
- Les raccourcis de zoom **restent actifs pendant un tracé ou une mesure** — c'est là qu'on
  a besoin de viser fin. Seul `0` (ajuster la vue) est neutralisé pendant une saisie
  chiffrée, car il collerait au « 0 » de « 40 ».
- **Alt maintenu = aucun aimant** (état `freeSnap`), pour la mesure comme pour le tracé :
  le point se pose pile sous le curseur, sans recalage de cote. Suivi au `mousemove`
  (`e.altKey`) + `keydown`/`keyup` + `blur` (sinon l'aimant reste coupé après un
  changement d'onglet).

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
- Cotes auto face à face : fin du désalignement rectangle/segment (voir ci-dessous).

### Piège : `partitionRects` n'est PAS indexable par segment

`partitionRects` renvoie, à la suite, les rectangles d'arête **et** les remblais d'onglet
(2 par sommet interne). Indexer son résultat avec un compteur « un rect par segment » se
désynchronise dès la 1ʳᵉ cloison en L, et toutes les cloisons suivantes tapent dans un
remblai (triangle à 3 points → face `[2],[3]` = NaN). Symptôme : cotes auto absentes sur
certaines cloisons, aberrantes sur d'autres.

→ Utiliser **`partitionEdgeRects(cloison)`** (`src/model/geometry.ts`) : renvoie
`{ pts, align, rects }` avec exactement un rect par segment, sur les points **dédoublonnés**
(parcourir `pts`, jamais `partition.points` brut).

---

## Points ouverts / à surveiller

- Page blanche signalée par l'utilisateur en dessinant une cloison : **non reproductible** en
  session fraîche (tracé, saisie de valeur, L, terminaison OK). Garde-fou posé ; si ça revient,
  l'erreur sera visible → récupérer le message exact.
- Warning setState-in-render (ConfigPanel↔CanvasView) : à nettoyer un jour (bénin).
- Cloisons existantes enregistrées en `align: 'center'` : `partitionRects` recalcule le côté
  depuis la géométrie, donc elles s'affichent correctement sans migration.
