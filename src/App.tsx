import { useState } from 'react';
import CanvasView from './render/CanvasView';
import ErrorBoundary from './ui/ErrorBoundary';
import Toolbar from './ui/Toolbar';
import StockPanel from './ui/StockPanel';
import ConfigPanel from './ui/ConfigPanel';
import ResultsPanel from './ui/ResultsPanel';
import { useStore } from './store/useStore';
import { printReport } from './export/printPlan';
import { exportProject, importProject } from './store/persist';
import './App.css';

function exportPNG() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'calepinage.png';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

export default function App() {
  const [highlightCuts, setHighlightCuts] = useState(false);
  const [showNumbers, setShowNumbers] = useState(true);
  const [showGaps, setShowGaps] = useState(true);
  // Les panneaux se replient : sur un plan large, on veut tout l'écran pour le dessin.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const { run, result, packs, config, room, measures, newProject, loadInto } = useStore();

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          🪵 Calepinage parquet
          {/* Repère de version : permet de vérifier CE QUI tourne avant de conclure
              qu'un correctif n'a rien changé. */}
          <span className="build-stamp" title="Version déployée (commit · compilation)">
            {__BUILD__}
          </span>
        </h1>

        <div className="header-toggles">
          <label className="cut-toggle">
            <input
              type="checkbox" checked={showNumbers}
              onChange={(e) => setShowNumbers(e.target.checked)}
            />
            Numéroter
          </label>
          <label className="cut-toggle">
            <input
              type="checkbox" checked={highlightCuts}
              onChange={(e) => setHighlightCuts(e.target.checked)}
            />
            Surligner les découpes
          </label>
          <label className="cut-toggle" title="Cotes automatiques entre cloisons et murs (face à face)">
            <input
              type="checkbox" checked={showGaps}
              onChange={(e) => setShowGaps(e.target.checked)}
            />
            Cotes des cloisons
          </label>

          <span className="hd-sep" />

          <button className="primary" onClick={run}>▶ Calepiner</button>
          <button onClick={exportPNG} title="Exporter le plan en PNG">⤓ PNG</button>
          <button
            onClick={() => result && printReport(result, packs, config)}
            disabled={!result}
            title="Plan de pose imprimable"
          >
            🖨 Plan
          </button>

          <span className="hd-sep" />

          <button
            onClick={() => exportProject({ room, packs, config, measures })}
            title="Enregistrer le plan (murs, cloisons, portes, stock…) dans un fichier .json"
          >
            💾 Exporter
          </button>
          <label className="file-btn" title="Ouvrir un plan enregistré (.json)">
            📂 Importer
            <input
              type="file" accept="application/json,.json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try { loadInto(await importProject(f)); } catch (err) { alert(String(err)); }
              }}
            />
          </label>
          <button
            onClick={() => { if (confirm('Effacer le plan en cours et repartir de zéro ?')) newProject(); }}
            title="Nouveau projet (efface le plan en cours)"
          >
            ✕ Nouveau
          </button>
        </div>
      </header>

      <div className="app-body">
        {leftOpen && (
          <aside className="side left">
            <StockPanel />
            <ConfigPanel />
          </aside>
        )}

        <main className="center">
          <div className="canvas-wrap">
            <ErrorBoundary>
              <CanvasView highlightCuts={highlightCuts} showNumbers={showNumbers} showGaps={showGaps} />
            </ErrorBoundary>
            <Toolbar />

            {/* La languette ne bouge pas : elle bascule le panneau, ouvert comme fermé. */}
            <button
              className="side-open left"
              onClick={() => setLeftOpen((v) => !v)}
              title={leftOpen ? 'Replier le stock et la configuration' : 'Stock et configuration'}
            >
              {leftOpen ? '‹' : '›'}
            </button>
            <button
              className="side-open right"
              onClick={() => setRightOpen((v) => !v)}
              title={rightOpen ? 'Replier les résultats' : 'Résultats'}
            >
              {rightOpen ? '›' : '‹'}
            </button>
          </div>
        </main>

        {rightOpen && (
          <aside className="side right">
            <ResultsPanel />
          </aside>
        )}
      </div>
    </div>
  );
}
