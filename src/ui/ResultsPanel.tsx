import { useStore } from '../store/useStore';
import { packIdOf } from '../model/stock';

export default function ResultsPanel() {
  const { result, packs, config } = useStore();
  if (!result) {
    return (
      <section className="panel">
        <h2>Résultats</h2>
        <p className="muted">Lance le calepinage pour voir les statistiques.</p>
      </section>
    );
  }

  const { stats } = result;
  const packOf = (batchId: string) => packs.find((p) => p.id === packIdOf(batchId));
  // Un lot s'identifie « paquet:LxL:aspect » : ses dimensions se lisent dans son identifiant.
  const batchName = (id: string) => id.split(':')[1]?.replace('x', '×') ?? id;


  return (
    <section className="panel">
      <h2>Résultats</h2>

      {stats.missingPlanks > 0 && (
        <div className="alert">
          ⚠ <b>{stats.missingPlanks} lame(s) manquante(s)</b> — la pièce est calepinée en entier,
          mais ces lames (hachurées en rouge sur le plan) restent à acheter :{' '}
          {stats.shortage.map((s) => `${s.missing} × ${batchName(s.batchId)}`).join(', ')}.
        </div>
      )}

      {stats.narrowRips > 0 && (
        <div className="alert">
          ⚠ <b>{stats.narrowRips} lame(s) à refendre sous {config.minRipWidth} cm</b> de large.
          Elles sont bien posées — les retirer laisserait un vide contre le mur — mais ce sont
          des coupes délicates. Décaler la ligne de départ ou l'orientation les fait souvent
          disparaître.
        </div>
      )}

      {stats.droppedSlivers > 0 && (
        <div className="note">
          <b>{stats.droppedSlivers} filet(s) écarté(s)</b> — moins d'un centimètre de large,
          entièrement absorbés par le jeu de dilatation et la plinthe. Rien à couper.
        </div>
      )}

      {stats.stagger.total > 0 && (
        <div className={stats.stagger.min < 6 ? 'alert' : 'note'}>
          <b>Décalage des joints obtenu</b> — minimum <b>{stats.stagger.min} cm</b>,
          médiane {stats.stagger.median} cm, sur {stats.stagger.total} joints.
          {' '}Refend le plus étroit : <b>{stats.minRipWidth} cm</b>.
          {stats.stagger.below > 0 && (
            <>
              {' '}<b>{stats.stagger.below}</b> joint(s) sous les {stats.stagger.target} cm demandés.
            </>
          )}
          {stats.stagger.below > stats.stagger.total * 0.15 && stats.stagger.recommended > 0
            && stats.stagger.target > stats.stagger.recommended && (
            <>
              {' '}Ce seuil est hors d'atteinte avec ce stock : viser trop haut ne rend pas le
              plancher plus propre, cela déplace le problème sur quelques joints franchement
              collés. Le NF DTU 51.2 demande <b>{stats.stagger.recommended} cm</b>
              {' '}(2 × la largeur de lame) — abaisser le réglage donnera un meilleur résultat réel.
            </>
          )}
        </div>
      )}

      {stats.spaces.length > 1 && (
        <>
          <h3>Pièces ({stats.spaces.length})</h3>
          <table className="stock-table">
            <thead><tr><th>Pièce</th><th>Surface</th><th>Lames</th></tr></thead>
            <tbody>
              {stats.spaces.map((s) => (
                <tr key={s.index} className={s.excluded ? 'row-off' : undefined}>
                  <td>{s.name}</td>
                  <td>{s.areaM2} m²</td>
                  <td>{s.excluded ? <span className="muted">non posée</span> : s.planks}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Chaque pièce est calepinée pour elle-même : aucune lame ne court sous une cloison.
            {stats.excludedAreaM2 > 0 && ` ${stats.excludedAreaM2} m² exclus du parquet.`}
          </p>
        </>
      )}

      <div className="stats-grid">
        <div><span className="k">Surface totale</span><b>{stats.roomAreaM2} m²</b></div>
        <div><span className="k">Surface posée</span><b>{stats.laidAreaM2} m²</b></div>
        <div><span className="k">Lames posées</span><b>{stats.planksPlaced}</b></div>
        <div><span className="k">Lames neuves</span><b>{stats.newPlanksUsed}</b></div>
        <div><span className="k">Chutes réutilisées</span><b>{stats.offcutsReused}</b></div>
        <div><span className="k">Coupes en bout</span><b>{stats.cuts}</b></div>
        <div><span className="k">Refends (en longueur)</span><b>{stats.ripCuts}</b></div>
        {stats.missingPlanks > 0 && (
          <div><span className="k">Lames à acheter</span><b className="warn-num">{stats.missingPlanks}</b></div>
        )}
        <div><span className="k">Déchet</span><b>{stats.wasteAreaM2} m²</b></div>
        <div><span className="k">% déchet</span><b>{stats.wastePct} %</b></div>
        <div><span className="k">Périmètre</span><b>{stats.perimeterM} m</b></div>
        <div><span className="k">Plinthes {stats.doorCount > 0 ? `(${stats.doorCount} porte${stats.doorCount > 1 ? 's' : ''})` : ''}</span><b>{stats.plintheM} m</b></div>
        {stats.partitionM > 0 && (
          <div><span className="k">Cloisons</span><b>{stats.partitionM} m</b></div>
        )}
      </div>

      <h3>Consommation par longueur</h3>
      <table className="stock-table">
        <thead><tr><th>Lame</th><th>Paquet</th><th>Utilisées</th><th>Dispo</th></tr></thead>
        <tbody>
          {stats.batchUsage.filter((u) => u.available > 0 || u.used > 0).map((u) => (
            <tr key={u.batchId}>
              <td>{batchName(u.batchId)}</td>
              <td className="muted">{packOf(u.batchId)?.name ?? '—'}</td>
              <td>{u.used}</td>
              <td>{u.available}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>À prévoir (marge {config.wastePurchasePct} %)</h3>
      <table className="stock-table">
        <thead><tr><th>Lame</th><th>Posées</th><th>À prévoir</th></tr></thead>
        <tbody>
          {stats.batchUsage.filter((u) => u.used > 0).map((u) => (
            <tr key={u.batchId}>
              <td>{batchName(u.batchId)}</td>
              <td>{u.used}</td>
              <td><b>{Math.ceil(u.used * (1 + config.wastePurchasePct / 100))}</b></td>
            </tr>
          ))}
        </tbody>
      </table>

      {result.packSheets.length > 0 && (
        <>
          <h3>Numérotation des lames</h3>
          <p className="muted">
            Ouvrez chaque paquet et numérotez les lames au crayon dans cet ordre : la lame
            <b> 2·7</b> du plan est la 7ᵉ lame du paquet 2.
          </p>
          {result.packSheets.map((sh) => {
            const pack = packs.find((p) => p.id === sh.packId);
            return (
              <div key={sh.packId} className="pack-sheet">
                <div className="ps-head">
                  <b>Paquet {sh.packNo}</b>
                  <span className="muted">{pack?.name} · {sh.planks.length} lames</span>
                </div>
                <div className="ps-list">
                  {sh.planks.map((p) => (
                    <span key={p.no} className="ps-plank">
                      <b>{sh.packNo}·{p.no}</b> {p.length}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {result.cutList.length > 0 && (
        <>
          <h3>Liste de découpe ({result.cutList.length})</h3>
          <div className="cut-list">
            {result.cutList.map((c) => (
              <div key={c.index} className="cut-row">
                <b>Lame {c.label || c.index}</b> · {batchName(c.batchId)} ·{' '}
                {c.isCut && <>coupe {c.requestedLength} cm</>}
                {c.isCut && c.isRipped && ' + '}
                {c.isRipped && (
                  <span className="rip">
                    refend {c.requestedWidth} cm <span className="muted">(sur {c.nominalWidth})</span>
                  </span>
                )}
                {c.fromOffcut ? ' · (chute)' : ''}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
