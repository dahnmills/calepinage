import { useState } from 'react';
import ImportStock from './ImportStock';
import { useStore } from '../store/useStore';
import { TEXTURE_LIST } from '../model/textures';
import { areaOf, byLength, duplicateNumbers, planksIn } from '../model/stock';
import type { Pack, TextureId } from '../model/types';
import NumberField from './NumberField';

/** Ajout groupé : personne ne saisit quarante lames une par une. */
function AddPlanks({ pack }: { pack: Pack }) {
  const addPlanks = useStore((s) => s.addPlanks);
  const [length, setLength] = useState(120);
  const [count, setCount] = useState(1);

  return (
    <div className="add-planks">
      <NumberField value={count} min={1} step={1} onChange={setCount} suffix="lame(s)" />
      <span className="muted">de</span>
      <NumberField value={length} min={1} step={1} onChange={setLength} suffix="cm" />
      <button onClick={() => addPlanks(pack.id, length, count)}>+ Ajouter</button>
    </div>
  );
}

export default function StockDialog({ onClose }: { onClose: () => void }) {
  const {
    packs, addPack, updatePack, removePack, duplicatePack,
    updatePlank, removePlank, setPackWidth, renumberPack,
  } = useStore();

  const [importing, setImporting] = useState(false);

  const totalPlanks = packs.reduce((s, p) => s + planksIn(p), 0);
  const totalM2 = packs.reduce((s, p) => s + areaOf(p), 0);

  if (importing) return <ImportStock onDone={() => setImporting(false)} />;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Stock de lames</h2>
          <div className="mh-actions">
            <button onClick={() => setImporting(true)}>⤒ Importer un inventaire</button>
            <button onClick={onClose} title="Fermer">✕</button>
          </div>
        </header>

        <p className="muted modal-intro">
          Chaque lame est unique et porte <b>son</b> numéro — celui que vous inscrivez au crayon
          dessus. La lame <b>2·7</b> du plan est la lame n° <b>7</b> du paquet <b>2</b>.
        </p>

        <div className="modal-body">
          {packs.map((pack) => {
            const dupes = duplicateNumbers(pack);
            return (
              <section className="pack" key={pack.id}>
                <div className="pack-head">
                  <input
                    className="pack-name"
                    value={pack.name}
                    onChange={(e) => updatePack(pack.id, { name: e.target.value })}
                  />
                  <label title="Appliquée à toutes les lames du paquet">
                    Largeur
                    <NumberField
                      value={pack.defaultWidth} min={1} step={0.5} suffix="cm"
                      onChange={(v) => setPackWidth(pack.id, v)}
                    />
                  </label>
                  <button onClick={() => renumberPack(pack.id)} title="Renuméroter les lames de 1 à N">
                    1…N
                  </button>
                  <button onClick={() => duplicatePack(pack.id)} title="Dupliquer">⧉</button>
                  <button onClick={() => removePack(pack.id)} title="Supprimer ce paquet">
                    ✕
                  </button>
                </div>

                <div className="pack-sum muted">
                  {planksIn(pack)} lames · {areaOf(pack).toFixed(2)} m²
                  {byLength(pack).length > 0 && ' · '}
                  {byLength(pack).map((g) => `${g.count}×${g.length} cm`).join(' · ')}
                </div>

                {pack.planks.length === 0 && (
                  <p className="muted pack-empty">Paquet vide — ajoutez vos lames ci-dessous.</p>
                )}

                {pack.planks.length > 0 && (
                  <table className="pack-table">
                    <thead>
                      <tr>
                        <th title="Numéro inscrit sur cette lame">N° de la lame</th>
                        <th>Longueur</th>
                        <th>Aspect</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {pack.planks.map((p) => (
                        <tr key={p.id} className={dupes.includes(p.no) ? 'dupe' : undefined}>
                          <td className="plank-no">
                            <NumberField
                              value={p.no} min={1} step={1}
                              onChange={(v) => updatePlank(pack.id, p.id, { no: Math.round(v) })}
                            />
                          </td>
                          <td>
                            <NumberField
                              value={p.length} min={1} step={1} suffix="cm"
                              onChange={(v) => updatePlank(pack.id, p.id, { length: v })}
                            />
                          </td>
                          <td>
                            <select
                              value={p.texture}
                              onChange={(e) => updatePlank(pack.id, p.id, { texture: e.target.value as TextureId })}
                            >
                              {TEXTURE_LIST.map((t) => (
                                <option key={t.id} value={t.id}>{t.label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <button
                              className="icon-btn"
                              onClick={() => removePlank(pack.id, p.id)}
                              title="Retirer cette lame"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {dupes.length > 0 && (
                  <div className="alert">
                    ⚠ Numéro{dupes.length > 1 ? 's' : ''} porté{dupes.length > 1 ? 's' : ''} par
                    plusieurs lames : {dupes.join(', ')}. Chaque lame doit être unique.
                  </div>
                )}

                <AddPlanks pack={pack} />
              </section>
            );
          })}

          <button className="add-btn" onClick={addPack}>+ Ajouter un paquet</button>
        </div>

        <footer className="modal-foot">
          <div className="stock-total">
            <span>{totalPlanks} lames · {totalM2.toFixed(2)} m² au total</span>
          </div>
          <button className="primary" onClick={onClose}>Terminer</button>
        </footer>
      </div>
    </div>
  );
}
