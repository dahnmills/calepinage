import { useStore } from '../store/useStore';
import { PATTERNS } from '../model/patterns';
import NumberField from './NumberField';
import type { OffsetMode } from '../model/types';

/** Angle (mod 180) de la plus longue arête de la pièce : sens de pose "dans la longueur". */
function longestEdgeAngle(points: { x: number; y: number }[]): number {
  let best = 0, bestLen = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > bestLen) { bestLen = l; best = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI; }
  }
  return ((best % 180) + 180) % 180;
}

const OFFSETS: { id: OffsetMode; label: string }[] = [
  { id: '0', label: 'Aligné (0)' },
  { id: '1/2', label: 'Demi (1/2)' },
  { id: '1/3', label: 'Tiers (1/3)' },
  { id: 'random', label: 'Aléatoire' },
];

export default function ConfigPanel() {
  const { config, setConfig, room } = useStore();

  return (
    <section className="panel">
      <h2>Configuration de pose</h2>

      <label className="field">
        <span>Motif</span>
        <select
          value={config.patternId}
          onChange={(e) => setConfig({ patternId: e.target.value })}
        >
          {PATTERNS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Décalage rangées</span>
        <select
          value={config.offsetMode}
          onChange={(e) => setConfig({ offsetMode: e.target.value as OffsetMode })}
        >
          {OFFSETS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Orientation : {config.orientationDeg}°</span>
        <input
          type="range" min={0} max={180} step={5} value={config.orientationDeg}
          onChange={(e) => setConfig({ orientationDeg: +e.target.value })}
        />
      </label>

      <button
        className="advice-btn"
        onClick={() => setConfig({ orientationDeg: Math.round(longestEdgeAngle(room.points)) })}
        title="Poser les lames dans la longueur de la pièce"
      >
        ↳ Sens conseillé (dans la longueur)
      </button>

      {config.startLine && (
        <div className="field">
          <span>Ligne de départ : x {config.startLine.x} · y {config.startLine.y} cm</span>
          <button
            className="advice-btn"
            onClick={() => setConfig({ startFlip: !config.startFlip })}
            title="Choisit le côté de la ligne posé en premier (l'autre côté se pose ensuite, fausse languette)"
          >
            ⇄ Inverser le sens de pose
          </button>
        </div>
      )}

      <label className="field">
        <span>Jeu de joint (cm)</span>
        <NumberField min={0} step={0.1} value={config.jointGap} onChange={(v) => setConfig({ jointGap: v })} />
      </label>

      <label className="field">
        <span>Épaisseur murs extérieurs (cm)</span>
        <NumberField min={0} step={0.5} value={config.exteriorWallThickness} onChange={(v) => setConfig({ exteriorWallThickness: v })} />
      </label>

      <label className="field">
        <span>Jeu de dilatation périmétrique (cm)</span>
        <NumberField min={0} step={0.1} value={config.expansionGap} onChange={(v) => setConfig({ expansionGap: v })} />
      </label>

      <label className="field">
        <span>Décalage mini des joints (cm)</span>
        <NumberField
          min={0} step={1} value={config.minJointOffset} onChange={(v) => setConfig({ minJointOffset: v })}
          title="Écart minimal entre les joints de deux rangées voisines. Des joints alignés sont laids et affaiblissent le plancher : 30 cm est l'usage."
        />
      </label>

      <label className="field">
        <span>Longueur mini de coupe (cm)</span>
        <NumberField min={0} step={0.5} value={config.minCutLength} onChange={(v) => setConfig({ minCutLength: v })} />
      </label>

      <label className="field checkbox">
        <input
          type="checkbox" checked={config.optimizeStart}
          onChange={(e) => setConfig({ optimizeStart: e.target.checked })}
        />
        <span>Optimiser le point de départ (rives équilibrées)</span>
      </label>

      <label className="field">
        <span>Tolérance de coupe (cm)</span>
        <NumberField
          min={0} step={0.1} value={config.cutTolerance} onChange={(v) => setConfig({ cutTolerance: v })}
          title="En deçà, on ne coupe pas : la lame est posée pleine et mord d'autant sur le jeu de dilatation."
        />
      </label>

      <label className="field checkbox">
        <input
          type="checkbox" checked={config.mixLengths}
          onChange={(e) => setConfig({ mixLengths: e.target.checked })}
        />
        <span title="Une lame courte du paquet est posée entière plutôt que de couper une longue. Sans ça, les longueurs courtes ne servent jamais et dorment en stock.">
          Utiliser toutes les longueurs du paquet
        </span>
      </label>

      <label className="field checkbox">
        <input
          type="checkbox" checked={config.mixPacks}
          onChange={(e) => setConfig({ mixPacks: e.target.checked })}
        />
        <span title="Règle de l'art : on pioche en alternance dans les paquets ouverts. Les nuances varient d'un paquet à l'autre ; les répartir évite les plages plus claires ou plus foncées.">
          Mélanger les paquets (répartir les nuances)
        </span>
      </label>

      <label className="field checkbox">
        <input
          type="checkbox" checked={config.preferShort}
          onChange={(e) => setConfig({ preferShort: e.target.checked })}
        />
        <span title="Pour un besoin de 78 cm, entame une lame de 80 plutôt que d'en couper une de 120. Moins de coupes et un peu moins de déchet, mais plus de lames consommées : une longue coupée laisse une chute réutilisable.">
          Couper dans la lame la plus courte (moins de coupes)
        </span>
      </label>

      <label className="field checkbox">
        <input
          type="checkbox" checked={config.reuseOffcuts}
          onChange={(e) => setConfig({ reuseOffcuts: e.target.checked })}
        />
        <span>Réutiliser les chutes</span>
      </label>

      {config.offsetMode === 'random' && (
        <label className="field">
          <span>Graine (aléatoire)</span>
          <NumberField min={0} step={1} value={config.seed} onChange={(v) => setConfig({ seed: Math.round(v) })} />
        </label>
      )}
    </section>
  );
}
