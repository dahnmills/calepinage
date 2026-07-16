import type { LayoutResult, Pack, LayoutConfig } from '../model/types';
import { packIdOf } from '../model/stock';

/** Ouvre une fenêtre imprimable (→ PDF via le navigateur) avec le plan et le récapitulatif. */
export function printReport(result: LayoutResult, packs: Pack[], config: LayoutConfig) {
  const canvas = document.querySelector('canvas');
  const img = canvas ? canvas.toDataURL('image/png') : '';
  const s = result.stats;
  // Un lot s'identifie « paquet:LxL:aspect » : ses dimensions se lisent dans son identifiant.
  const name = (id: string) => {
    const dims = id.split(':')[1];
    return dims ? `${dims.replace('x', '×')} cm` : id;
  };
  const marge = config.wastePurchasePct;

  const packName = (id: string) => packs.find((p) => p.id === packIdOf(id))?.name ?? '—';

  const usageRows = s.batchUsage
    .filter((u) => u.used > 0)
    .map((u) => {
      const buy = Math.ceil(u.used * (1 + marge / 100));
      return `<tr><td>${name(u.batchId)}</td><td>${packName(u.batchId)}</td><td>${u.used}</td><td><b>${buy}</b></td></tr>`;
    })
    .join('');

  const cutRows = result.cutList
    .map((c) => {
      const bout = c.isCut ? `${c.requestedLength} cm` : '—';
      const refend = c.isRipped ? `${c.requestedWidth} cm <small>(sur ${c.nominalWidth})</small>` : '—';
      return `<tr><td><b>${c.label || c.index}</b></td><td>${name(c.batchId)}</td><td>${bout}</td><td>${refend}</td><td>${c.fromOffcut ? 'chute' : 'neuve'}</td></tr>`;
    })
    .join('');

  const spaceRows = s.spaces.length > 1
    ? `<h2>Pièces (${s.spaces.length})</h2><table><thead><tr><th>Pièce</th><th>Surface</th><th>Lames</th></tr></thead><tbody>${
      s.spaces.map((x) => `<tr><td>${x.name}</td><td>${x.areaM2} m²</td><td>${x.excluded ? 'non posée' : x.planks}</td></tr>`).join('')
    }</tbody></table>${s.excludedAreaM2 > 0 ? `<p class="sub">${s.excludedAreaM2} m² exclus du parquet.</p>` : ''}`
    : '';

  // Bordereau de numérotation : on l'emporte sur le chantier pour marquer les lames.
  const sheetRows = result.packSheets.map((sh) => {
    const pack = packs.find((p) => p.id === sh.packId);
    const planks = sh.planks
      .map((p) => `<span class="pl"><b>${sh.packNo}·${p.no}</b> ${p.length}</span>`)
      .join('');
    return `<div class="sheet"><h3>Paquet ${sh.packNo} <small>${pack?.name ?? ''} · ${sh.planks.length} lames</small></h3><div class="pls">${planks}</div></div>`;
  }).join('');

  const shortage = s.shortage.length
    ? `<p class="warn">⚠ Stock insuffisant : ${s.shortage.map((x) => `${x.missing} lame(s) ${name(x.batchId)}`).join(', ')}</p>`
    : '';

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Calepinage parquet — plan de pose</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; color: #0f172a; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  img { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; }
  .grid div { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; }
  .grid span { display: block; font-size: 11px; color: #64748b; }
  .grid b { font-size: 15px; }
  h2 { font-size: 14px; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 4px 8px; text-align: left; }
  th { background: #f1f5f9; }
  .sheet { margin-bottom: 10px; }
  .sheet h3 { font-size: 12px; margin: 6px 0 4px; }
  .sheet h3 small { font-weight: 400; color: #64748b; }
  .pls { display: flex; flex-wrap: wrap; gap: 4px; }
  .pl { border: 1px solid #e2e8f0; border-radius: 4px; padding: 1px 5px; font-size: 11px; }
  .pl b { color: #1d4ed8; }
  .warn { background: #fef3c7; border: 1px solid #fcd34d; padding: 8px; border-radius: 6px; font-size: 12px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media print { body { margin: 0; } button { display: none; } }
</style></head><body>
  <h1>Plan de pose — calepinage parquet</h1>
  <div class="sub">Motif : ${config.patternId} · orientation ${config.orientationDeg}° · décalage ${config.offsetMode} · dilatation ${config.expansionGap} cm · généré le ${new Date().toLocaleDateString('fr-FR')}</div>
  ${shortage}
  ${img ? `<img src="${img}" alt="plan de pose">` : ''}
  <div class="grid">
    <div><span>Surface pièce</span><b>${s.roomAreaM2} m²</b></div>
    <div><span>Surface posée</span><b>${s.laidAreaM2} m²</b></div>
    <div><span>Lames neuves</span><b>${s.newPlanksUsed}</b></div>
    <div><span>Coupes en bout</span><b>${s.cuts}</b></div>
    <div><span>Refends (longueur)</span><b>${s.ripCuts}</b></div>
    <div><span>Chutes réutilisées</span><b>${s.offcutsReused}</b></div>
    <div><span>Déchet</span><b>${s.wasteAreaM2} m² (${s.wastePct} %)</b></div>
    <div><span>Surface à commander</span><b>${(s.roomAreaM2 * (1 + marge / 100)).toFixed(2)} m²</b></div>
    <div><span>Marge d'achat</span><b>${marge} %</b></div>
    <div><span>Périmètre</span><b>${s.perimeterM} m</b></div>
    <div><span>Plinthes${s.doorCount ? ` (${s.doorCount} porte(s))` : ''}</span><b>${s.plintheM} m</b></div>
    ${s.partitionM > 0 ? `<div><span>Cloisons</span><b>${s.partitionM} m</b></div>` : ''}
  </div>
  ${result.packSheets.length ? `<h2>Numérotation des lames</h2>
  <p class="sub">Numérotez les lames au crayon en ouvrant chaque paquet, dans cet ordre : la lame <b>2·7</b> du plan est la 7ᵉ lame du paquet 2.</p>
  ${sheetRows}` : ''}
  <div class="two">
    <div>
      ${spaceRows}
      <h2>Achat conseillé</h2>
      <table><thead><tr><th>Lame</th><th>Paquet</th><th>Posées</th><th>À prévoir</th></tr></thead><tbody>${usageRows}</tbody></table>
    </div>
    <div>
      <h2>Liste de découpe (${result.cutList.length})</h2>
      <table><thead><tr><th>Lame</th><th>Lot</th><th>Coupe en bout</th><th>Refend</th><th>Origine</th></tr></thead><tbody>${cutRows}</tbody></table>
    </div>
  </div>
  <script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
