import { useStore, type Tool } from '../store/useStore';
import type { WallAlign } from '../model/types';

/**
 * Barre unique et flottante. Les outils portent leur aide en infobulle : une seconde barre
 * d'aide permanente masquait le plan et gênait plus qu'elle n'aidait. Seuls les réglages sur
 * lesquels on agit vraiment restent visibles, à droite, en forme compacte.
 */
const TOOLS: { id: Tool; icon: string; label: string; hint: string }[] = [
  { id: 'edit', icon: '⬈', label: 'Sélection', hint: 'Cliquer une cloison ou une porte pour la régler · glisser les sommets · Suppr pour retirer' },
  { id: 'draw', icon: '✎', label: 'Murs', hint: 'Tracer le périmètre (mesure intérieure) · taper une longueur + Entrée · double-clic pour fermer' },
  { id: 'wall', icon: '▤', label: 'Cloison', hint: 'Tracer une cloison · s’accroche aux murs et aux angles · double-clic pour terminer' },
  { id: 'door', icon: '🚪', label: 'Porte', hint: 'Cliquer un mur ou une cloison pour y poser une porte' },
  { id: 'hole', icon: '⬚', label: 'Zone exclue', hint: 'Trémie, îlot, cheminée : poser les sommets, puis fermer la zone' },
  { id: 'space', icon: '▦', label: 'Pièces', hint: 'Cliquer une pièce pour la nommer ou l’exclure du parquet' },
  { id: 'measure', icon: '↔', label: 'Mesurer', hint: 'Deux clics pour coter · Maj = cote bien droite · s’accroche aux murs' },
  { id: 'startline', icon: '⇥', label: 'Départ', hint: 'Poser la ligne de départ · clic droit ou Tab pour inverser le sens' },
];

export default function Toolbar() {
  const {
    tool, setTool, drawing, undoDrawPoint, closeRoom, closeHole, closePartition,
    clearRoom, setRoomPoints, editor, setEditor, setConfig, config, room,
    measures, clearMeasures, undo, redo, past, future,
  } = useStore();

  const presetRect = () => {
    setRoomPoints([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }]);
    setTool('edit');
  };

  /** Réglages de l'outil actif, en ligne dans la barre. Rien d'inutile n'y figure. */
  const options = () => {
    switch (tool) {
      case 'draw':
        return (
          <>
            {room.points.length === 0 && drawing.length === 0 && (
              <button onClick={presetRect} title="Partir d’un rectangle de 400 × 300 cm">
                Rectangle
              </button>
            )}
            <button onClick={undoDrawPoint} disabled={drawing.length === 0} title="Retirer le dernier point">
              ↩ Point
            </button>
            <button className="primary" onClick={closeRoom} disabled={drawing.length < 3}>
              Fermer la pièce
            </button>
          </>
        );
      case 'wall':
        return (
          <>
            <span className="tb-thick" title="Épaisseur de la cloison, en cm (valeur libre)">
              Épaisseur
              <input
                type="number" min={1} step={0.5} list="wall-th" value={editor.wallThickness}
                onChange={(e) => { const v = +e.target.value; if (v > 0) setEditor({ wallThickness: v }); }}
                style={{ width: 58 }}
              />cm
            </span>
            <datalist id="wall-th">
              <option value={5} /><option value={7} /><option value={10} />
              <option value={13} /><option value={20} />
            </datalist>
            <select
              value={editor.wallAlign}
              onChange={(e) => setEditor({ wallAlign: e.target.value as WallAlign })}
              title="Centrée : le tracé est l’axe du mur. Face : le tracé est une face, l’épaisseur part d’un seul côté."
            >
              <option value="center">Axe</option>
              <option value="left">Face gauche</option>
              <option value="right">Face droite</option>
            </select>
            <button onClick={undoDrawPoint} disabled={drawing.length === 0} title="Retirer le dernier point">
              ↩ Point
            </button>
            <button className="primary" onClick={closePartition} disabled={drawing.length < 2}>
              Terminer
            </button>
          </>
        );
      case 'hole':
        return (
          <>
            <button onClick={undoDrawPoint} disabled={drawing.length === 0} title="Retirer le dernier point">
              ↩ Point
            </button>
            <button className="primary" onClick={closeHole} disabled={drawing.length < 3}>
              Fermer la zone
            </button>
          </>
        );
      case 'measure':
        return measures.length > 0 ? (
          <button onClick={clearMeasures} title="Retirer toutes les cotes">
            Effacer les cotes ({measures.length})
          </button>
        ) : null;
      case 'startline':
        return (
          <>
            <button onClick={() => setConfig({ startFlip: !config.startFlip })} title="Inverser le côté posé en premier">
              ⇄ Sens
            </button>
            {config.startLine && (
              <button onClick={() => setConfig({ startLine: null })} title="Retirer la ligne de départ">
                Retirer
              </button>
            )}
          </>
        );
      case 'edit':
        return room.points.length > 0 ? (
          <button onClick={() => { clearRoom(); setTool('draw'); }} title="Repartir d’un tracé vierge">
            Redessiner
          </button>
        ) : null;
      default:
        return null;
    }
  };

  const opts = options();
  const snappable = tool === 'draw' || tool === 'edit' || tool === 'hole' || tool === 'wall';

  return (
    <div className="float-bar">
      <div className="float-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn${tool === t.id ? ' active' : ''}`}
            onClick={() => setTool(t.id)}
            title={`${t.label} — ${t.hint}`}
          >
            {t.icon}
          </button>
        ))}

        {opts && <span className="fo-sep" />}
        {opts}

        {snappable && (
          <>
            <span className="fo-sep" />
            <button
              className={`tool-btn${editor.snapGrid ? ' on' : ''}`}
              onClick={() => setEditor({ snapGrid: !editor.snapGrid })}
              title="Aimanter à la grille"
            >
              ⌗
            </button>
            <button
              className={`tool-btn${editor.snapAngle ? ' on' : ''}`}
              onClick={() => setEditor({ snapAngle: !editor.snapAngle })}
              title="Contraindre l’angle"
            >
              ∠
            </button>
            <select
              className="grid-step"
              value={editor.gridStep}
              onChange={(e) => setEditor({ gridStep: +e.target.value })}
              title="Pas de grille et de tracé (cm)"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </>
        )}

        <span className="fo-sep" />
        <button className="tool-btn" onClick={undo} disabled={past.length === 0} title="Annuler (Cmd+Z)">↶</button>
        <button className="tool-btn" onClick={redo} disabled={future.length === 0} title="Rétablir (Cmd+Maj+Z)">↷</button>
      </div>
    </div>
  );
}
