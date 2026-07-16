// Ligne de départ : repère de pose partagé avec `layout.ts`, aimantation sur les murs
// et prévisualisation des rangées avant calcul.
import type { LayoutConfig, PlankBatch, Point, Room } from './types';
import { dominantWidth } from './layout';
import { offsetPolygon, polygonBBox, rotate } from './geometry';

/** Repère de pose : x = axe des lames, y = axe des rangées (mêmes conventions que layout.ts). */
export interface PoseFrame {
  toPose: (p: Point) => Point;
  fromPose: (p: Point) => Point;
  /** BBox de la zone de pose dans le repère de pose. */
  bb: { minX: number; minY: number; maxX: number; maxY: number };
  /** Polygone réellement parqueté (murs + dilatation retirés), repère PIÈCE. */
  layPoly: Point[];
  poseWidth: number;
  rowStep: number;
}

/**
 * Retrait entre le tracé des murs et la zone posée. Le tracé étant le nu intérieur,
 * seul le jeu de dilatation sépare le mur de la première lame.
 */
export function layInset(config: LayoutConfig): number {
  return config.expansionGap ?? 0;
}

export function poseFrame(room: Room, batches: PlankBatch[], config: LayoutConfig): PoseFrame | null {
  if (room.points.length < 3 || batches.length === 0) return null;
  const inset = layInset(config);
  const layPoly = inset > 0 ? offsetPolygon(room.points, inset) : room.points;
  const box = polygonBBox(layPoly);
  const center: Point = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const toPose = (p: Point): Point => {
    const r = rotate(p, -config.orientationDeg, center);
    return { x: r.x - center.x, y: r.y - center.y };
  };
  const fromPose = (p: Point): Point =>
    rotate({ x: p.x + center.x, y: p.y + center.y }, config.orientationDeg, center);

  const poseWidth = dominantWidth(batches);
  return {
    toPose,
    fromPose,
    bb: polygonBBox(layPoly.map(toPose)),
    layPoly,
    poseWidth,
    rowStep: poseWidth + (config.jointGap ?? 0),
  };
}

export interface GhostRow {
  /** Rectangle de la rangée, repère PIÈCE. */
  rect: Point[];
  /** Rang dans l'ordre de pose (1 = première rangée posée). */
  order: number;
}

/**
 * Rangées telles qu'elles seront posées depuis `startLine`, dans l'ordre de pose.
 * `startFlip` inverse le côté par lequel on commence (même règle que `generateStraight`).
 */
export function ghostRows(frame: PoseFrame, startLine: Point, startFlip: boolean, maxRows = 200): GhostRow[] {
  const { bb, rowStep, poseWidth, fromPose } = frame;
  const startY = frame.toPose(startLine).y;
  const rectAt = (y: number): Point[] =>
    [
      { x: bb.minX, y },
      { x: bb.maxX, y },
      { x: bb.maxX, y: y + poseWidth },
      { x: bb.minX, y: y + poseWidth },
    ].map(fromPose);

  const down: number[] = [];
  for (let y = startY; y < bb.maxY && down.length < maxRows; y += rowStep) down.push(y);
  const up: number[] = [];
  for (let y = startY - rowStep; y + poseWidth > bb.minY && up.length < maxRows; y -= rowStep) up.push(y);

  const ordered = startFlip ? [...up, ...down] : [...down, ...up];
  return ordered.map((y, i) => ({ rect: rectAt(y), order: i + 1 }));
}

/**
 * Sens de pose (vecteur unitaire, repère PIÈCE) : direction dans laquelle les rangées
 * s'enchaînent depuis la ligne de départ.
 */
export function poseDirection(frame: PoseFrame, startFlip: boolean): Point {
  const o = frame.fromPose({ x: 0, y: 0 });
  const d = frame.fromPose({ x: 0, y: startFlip ? -1 : 1 });
  return { x: d.x - o.x, y: d.y - o.y };
}
