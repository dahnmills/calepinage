import { useState } from 'react';
import { useStore } from '../store/useStore';
import { areaOf, flattenPacks, planksIn } from '../model/stock';
import StockDialog from './StockDialog';

/** Résumé du stock : le détail se règle dans la modale, où il y a la place. */
export default function StockPanel() {
  const packs = useStore((s) => s.packs);
  const [open, setOpen] = useState(false);

  const batches = flattenPacks(packs);
  const totalPlanks = batches.reduce((s, b) => s + b.quantity, 0);
  const totalM2 = packs.reduce((s, p) => s + areaOf(p), 0);
  const lengths = [...new Set(batches.map((b) => b.length))].sort((a, b) => b - a);

  return (
    <section className="panel">
      <h2>Stock de lames</h2>

      {totalPlanks === 0 ? (
        <p className="muted">Aucune lame en stock.</p>
      ) : (
        <>
          <div className="stock-summary">
            <div><span className="k">Lames</span><b>{totalPlanks}</b></div>
            <div><span className="k">Surface</span><b>{totalM2.toFixed(2)} m²</b></div>
          </div>
          <ul className="pack-list">
            {packs.map((p) => (
              <li key={p.id}>
                <b>{p.name}</b>
                <span className="muted">{planksIn(p)} lames</span>
              </li>
            ))}
          </ul>
          <p className="muted">Longueurs : {lengths.join(' · ')} cm</p>
        </>
      )}

      <button className="add-btn" onClick={() => setOpen(true)}>⚙ Configurer le stock</button>
      {open && <StockDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
