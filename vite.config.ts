import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Chemins relatifs : l'app marche à la racine comme dans un sous-dossier
  // (GitHub Pages sert depuis /<nom-du-repo>/).
  base: './',
  plugins: [react()],
})
