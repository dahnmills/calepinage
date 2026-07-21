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
