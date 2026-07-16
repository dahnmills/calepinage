import { generateStraight, type PatternInput } from './straight';
import type { PlacedPlank } from '../types';

export interface PatternDef {
  id: string;
  label: string;
  generate: (input: PatternInput) => PlacedPlank[];
}

/** Registry extensible des motifs de pose. */
export const PATTERNS: PatternDef[] = [
  { id: 'straight', label: 'Pose droite (coupe décalée)', generate: generateStraight },
  // À venir : bâtons rompus, point de Hongrie…
];

export function getPattern(id: string): PatternDef {
  return PATTERNS.find((p) => p.id === id) ?? PATTERNS[0];
}
