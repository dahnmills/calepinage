# Calepinage parquet

Outil web local pour calculer et visualiser la pose de parquet à partir d'un **stock de
lames** et d'un **plan de pièce dessiné**. React + Vite + TypeScript, rendu Canvas 2D.

## Lancer

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # build de production dans dist/
```

## Fonctionnalités (v1)

- **Stock de lames** : lots `longueur × largeur × quantité`, texture par lot
  (chêne clair/moyen, gris, noyer foncé).
- **Éditeur de plan (type conception intérieure)** :
  - grille métrique + magnétisme (pas réglable 5/10/25/50 cm), contrainte d'angle (15°).
  - tracé des murs au clic **ou saisie de la longueur au clavier** (boîte de mesure :
    tapez `400` + Entrée pour un mur exact), angle contraint affiché en direct.
  - mode **Édition** : sommets déplaçables (aimantés), **cotes cliquables et éditables**
    (tapez la longueur d'un mur), double-clic sur un mur pour ajouter un sommet, `Suppr`
    pour en retirer.
  - presets rectangle / pièce en L.
- **Motif** : pose droite à coupe décalée — décalage `0`, `1/2`, `1/3` ou aléatoire.
- **Orientation** réglable (0–180°), jeu de joint, longueur mini de coupe.
- **Optimisation** : stock fini, réutilisation des chutes (best-fit) pour limiter
  découpes et déchets.
- **Résultats** : surface posée, lames neuves, chutes réutilisées, nb de découpes,
  déchet (m² et %), consommation par lot, liste de découpe, **alerte si stock insuffisant**.
- **Rendu** : zoom molette + pan, textures bois procédurales, surbrillance des découpes,
  export PNG.

## Architecture

- `src/model/` : logique pure — `geometry.ts` (clip lame ∩ pièce, convexe & concave),
  `inventory.ts` (stock + pool de chutes), `layout.ts` (orchestrateur),
  `patterns/` (registry de motifs, extensible), `textures.ts`.
- `src/render/` : `CanvasView.tsx` (vue), `draw.ts` (primitives).
- `src/ui/` : panneaux Stock / Config / Résultats, barre d'outils.
- `src/store/useStore.ts` : état global (zustand).

## Extensions prévues

Motifs bâtons rompus / point de Hongrie (registry déjà en place), import d'image de fond
à l'échelle, plusieurs pièces, export PDF, mélange de largeurs.
