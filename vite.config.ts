import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Empreinte de la version déployée, injectée à la compilation.
 *
 * Sans repère visible dans l'app, impossible de distinguer « pas encore déployé » de
 * « déployé, mais ce réglage-là ne change rien » — on teste alors le mauvais bouton et
 * on en conclut de travers. Le commit court et la date de compilation lèvent le doute.
 */
function buildStamp(): string {
  let sha = 'local'
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    // Un artefact compilé depuis un dossier modifié n'est PAS ce commit : on le signale.
    if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) sha += '+'
  } catch {
    // Pas de dépôt git (archive, CI sans historique) : l'empreinte reste « local ».
  }
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${sha} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// https://vite.dev/config/
export default defineConfig({
  // Chemins relatifs : l'app marche à la racine comme dans un sous-dossier
  // (GitHub Pages sert depuis /<nom-du-repo>/).
  base: './',
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  plugins: [react()],
})
