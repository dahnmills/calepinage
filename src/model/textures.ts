import type { TextureId } from './types';

export interface WoodPalette {
  id: TextureId;
  label: string;
  base: string;
  /** Teintes de variation par lame (pioche pseudo-aléatoire). */
  variants: string[];
  grain: string;
}

export const PALETTES: Record<TextureId, WoodPalette> = {
  'chene-clair': {
    id: 'chene-clair', label: 'Chêne clair', base: '#d8b98a',
    variants: ['#e0c191', '#d2b07f', '#dcbd8c', '#cca877'], grain: '#b8985f',
  },
  'chene-moyen': {
    id: 'chene-moyen', label: 'Chêne moyen', base: '#b58a5a',
    variants: ['#bd9163', '#ac8052', '#c0955f', '#a67a4e'], grain: '#8f6a3f',
  },
  gris: {
    id: 'gris', label: 'Gris', base: '#9a9791',
    variants: ['#a29f99', '#918e88', '#a6a39d', '#8b8882'], grain: '#787570',
  },
  'noyer-fonce': {
    id: 'noyer-fonce', label: 'Noyer foncé', base: '#5c4433',
    variants: ['#654b39', '#523c2d', '#6b4f3b', '#4a3628'], grain: '#3a2b20',
  },
};

export const TEXTURE_LIST = Object.values(PALETTES);

/** Choisit une teinte stable d'après un identifiant (hash simple). */
export function variantFor(palette: WoodPalette, key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % palette.variants.length;
  return palette.variants[idx];
}
