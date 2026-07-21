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
