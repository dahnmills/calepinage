import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { parseInventory } from '../model/importStock';
import { areaOf, byLength, planksIn } from '../model/stock';

const EXAMPLE = `paquet;no;longueur;largeur
Paquet 1;1;120;20
Paquet 1;2;90;20
Paquet 2;1;120;20`;

/** Import d'un inventaire existant : on montre ce qui a été compris avant d'écrire quoi que ce soit. */
export default function ImportStock({ onDone }: { onDone: () => void }) {
  const { packs, setPacks } = useStore();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');

  // L'aperçu se recalcule à chaque frappe : rien n'est écrit tant qu'on n'a pas validé.
  const parsed = useMemo(() => parseInventory(text), [text]);
  const total = parsed.packs.reduce((s, p) => s + planksIn(p), 0);

  const readFile = async (f: File) => setText(await f.text());

  const apply = () => {
    setPacks(mode === 'replace' ? parsed.packs : [...packs, ...parsed.packs]);
    onDone();
  };

  return (
    <div className="modal-backdrop" onClick={onDone}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Importer un inventaire</h2>
          <button onClick={onDone} title="Fermer">✕</button>
        </header>

        <p className="muted modal-intro">
          Collez votre listing ou déposez un fichier — <b>JSON</b> ou <b>CSV</b> (séparateur
          <code>;</code> <code>,</code> ou tabulation). Colonnes reconnues : paquet, n°, longueur,
          largeur, aspect, quantité — dans n'importe quel ordre. Sans largeur, 20 cm est appliqué.
        </p>

        <div className="modal-body">
          <div className="imp-actions">
            <label className="file-btn">
              📂 Choisir un fichier
              <input
                type="file" accept=".json,.csv,.txt,.tsv,text/*,application/json"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) readFile(f); }}
              />
            </label>
            <button onClick={() => setText(EXAMPLE)}>Voir un exemple</button>
          </div>

          <textarea
            className="imp-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onDrop={(e) => {
              const f = e.dataTransfer.files?.[0];
              if (f) { e.preventDefault(); readFile(f); }
            }}
            placeholder={'Collez ici votre inventaire…\n\n120\n120\n90\n\nou\n\npaquet;no;longueur\nPaquet 1;1;120'}
            spellCheck={false}
          />

          {text.trim() && (
            <div className={total > 0 ? 'imp-preview ok' : 'imp-preview ko'}>
              {total > 0 ? (
                <>
                  <b>{total} lame(s)</b> dans {parsed.packs.length} paquet(s) :
                  <ul>
                    {parsed.packs.map((p) => (
                      <li key={p.id}>
                        <b>{p.name}</b> — {planksIn(p)} lames · {areaOf(p).toFixed(2)} m² ·{' '}
                        {byLength(p).map((g) => `${g.count}×${g.length}`).join(' · ')}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <b>Aucune lame reconnue.</b>
              )}

              {parsed.warnings.length > 0 && (
                <details className="imp-warn">
                  <summary>{parsed.warnings.length} avertissement(s)</summary>
                  <ul>
                    {parsed.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <label className="cut-toggle">
            <input
              type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')}
            />
            Remplacer le stock
          </label>
          <label className="cut-toggle">
            <input
              type="radio" checked={mode === 'append'} onChange={() => setMode('append')}
            />
            Ajouter au stock
          </label>
          <button className="primary" onClick={apply} disabled={total === 0}>
            Importer {total > 0 ? `${total} lame(s)` : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}
