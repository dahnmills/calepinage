import type { PlacedPlank, Point } from '../model/types';
import { PALETTES, variantFor } from '../model/textures';

export interface View {
  scale: number; // px par cm
  ox: number; // décalage monde (cm)
  oy: number;
}

export const worldToScreen = (p: Point, v: View): Point => ({
  x: (p.x - v.ox) * v.scale,
  y: (p.y - v.oy) * v.scale,
});

export const screenToWorld = (p: Point, v: View): Point => ({
  x: p.x / v.scale + v.ox,
  y: p.y / v.scale + v.oy,
});

function pathPoly(ctx: CanvasRenderingContext2D, poly: Point[], v: View) {
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
}

/** Trace un chemin couvrant tous les morceaux d'une lame (union visible). */
function pathPieces(ctx: CanvasRenderingContext2D, pieces: Point[][], v: View) {
  ctx.beginPath();
  for (const poly of pieces) {
    poly.forEach((p, i) => {
      const s = worldToScreen(p, v);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }
}

/**
 * Dessine une lame texturée + veinage. Remplissage des morceaux (portion ∩ pièce),
 * puis les JOINTS ne tracent que le rectangle nominal (pas les coutures de triangulation),
 * en restant clippé à la surface visible.
 */
export function drawPlank(
  ctx: CanvasRenderingContext2D,
  pl: PlacedPlank,
  v: View,
  highlightCuts: boolean,
  showNumbers: boolean,
) {
  if (pl.pieces.length === 0) return;
  const palette = PALETTES[pl.texture];
  const color = variantFor(palette, pl.id);

  // Remplissage (une seule couleur pour toute la lame).
  pathPieces(ctx, pl.pieces, v);
  ctx.fillStyle = pl.isMissing ? '#fee2e2' : color;
  ctx.fill();

  ctx.save();
  // On limite tout le reste (veinage + joints) à la surface visible de la lame.
  pathPieces(ctx, pl.pieces, v);
  ctx.clip();

  // Veinage : lignes dans le sens du grain, centrées sur le rectangle nominal.
  let cx = 0, cy = 0;
  for (const p of pl.rect) { const s = worldToScreen(p, v); cx += s.x; cy += s.y; }
  cx /= pl.rect.length; cy /= pl.rect.length;
  const gx = pl.grain.x, gy = pl.grain.y;
  const px = -gy, py = gx; // perpendiculaire au grain
  const span = pl.width * v.scale;
  const len = pl.length * v.scale;
  ctx.strokeStyle = palette.grain;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 1;
  for (let k = -3; k <= 3; k++) {
    const off = (k / 6) * span;
    ctx.beginPath();
    ctx.moveTo(cx + px * off - gx * len, cy + py * off - gy * len);
    ctx.lineTo(cx + px * off + gx * len, cy + py * off + gy * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Joints : uniquement le contour du rectangle nominal (clippé à la surface).
  pathPoly(ctx, pl.rect, v);
  ctx.strokeStyle = highlightCuts && pl.isCut ? 'rgba(220,40,40,0.9)' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = highlightCuts && pl.isCut ? 1.5 : 1;
  ctx.stroke();

  // Lame posée faute de stock : hachurée. La pièce est calepinée entièrement, mais on voit
  // d'un coup d'œil ce qu'il reste à acheter.
  if (pl.isMissing) {
    const bb = pl.pieces.flat().map((p) => worldToScreen(p, v));
    const minX = Math.min(...bb.map((p) => p.x)), maxX = Math.max(...bb.map((p) => p.x));
    const minY = Math.min(...bb.map((p) => p.y)), maxY = Math.max(...bb.map((p) => p.y));
    ctx.strokeStyle = 'rgba(220,38,38,0.55)';
    ctx.lineWidth = 1.5;
    for (let x = minX - (maxY - minY); x < maxX; x += 8) {
      ctx.beginPath();
      ctx.moveTo(x, minY);
      ctx.lineTo(x + (maxY - minY), maxY);
      ctx.stroke();
    }
  }

  // Refend (coupe en longueur) : liseré violet sur la surface conservée, pour le distinguer
  // de la coupe en bout (rouge). Une lame peut porter les deux.
  if (highlightCuts && pl.isRipped) {
    pathPieces(ctx, pl.pieces, v);
    ctx.strokeStyle = 'rgba(124,58,237,0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Libellé lame/morceau : placé dans le plus grand morceau visible, dimensionné sur la
  // place réellement disponible (sinon les coupes courtes — celles suffixées A/B — muettes).
  if (showNumbers && pl.label) drawPlankLabel(ctx, pl, v);
  ctx.restore();
}

/** Aire (valeur absolue) d'un polygone à l'écran. */
function screenArea(poly: Point[], v: View): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = worldToScreen(poly[i], v), q = worldToScreen(poly[(i + 1) % poly.length], v);
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Écrit le libellé (« 12 », « 9-A ») dans le plus grand morceau visible de la lame,
 * orienté dans le sens du grain. La place disponible est mesurée sur le morceau lui-même :
 * une coupe courte reste lisible tant qu'il y a la place d'écrire.
 */
function drawPlankLabel(ctx: CanvasRenderingContext2D, pl: PlacedPlank, v: View) {
  let piece = pl.pieces[0];
  if (pl.pieces.length > 1) {
    let bestA = -1;
    for (const pc of pl.pieces) {
      const a = screenArea(pc, v);
      if (a > bestA) { bestA = a; piece = pc; }
    }
  }
  const pts = piece.map((p) => worldToScreen(p, v));
  if (pts.length < 3) return;

  // Étendues le long du grain et perpendiculairement (repère écran).
  const gx = pl.grain.x, gy = pl.grain.y;
  const px = -gy, py = gx;
  let minU = Infinity, maxU = -Infinity, minW = Infinity, maxW = -Infinity;
  for (const p of pts) {
    const u = p.x * gx + p.y * gy;
    const w = p.x * px + p.y * py;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (w < minW) minW = w; if (w > maxW) maxW = w;
  }
  const alongPx = maxU - minU, acrossPx = maxW - minW;
  if (acrossPx < 8) return; // rangée trop fine à l'écran

  const size = Math.max(7, Math.min(13, acrossPx * 0.5));
  ctx.globalAlpha = 1;
  ctx.font = `600 ${size}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (ctx.measureText(pl.label).width + 3 > alongPx) return; // pas la place d'écrire

  // Centre du morceau (et non du rectangle nominal) : le libellé reste dans la matière.
  const cu = (minU + maxU) / 2, cw = (minW + maxW) / 2;
  const cx = cu * gx + cw * px;
  const cy = cu * gy + cw * py;

  ctx.save();
  ctx.translate(cx, cy);
  // Aligné sur le grain, mais jamais à l'envers.
  ctx.rotate(Math.atan2(gy, gx) + (gx < 0 ? Math.PI : 0));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeText(pl.label, 0, 0); // halo : lisible sur bois foncé comme clair
  ctx.fillStyle = 'rgba(23,32,48,0.95)';
  ctx.fillText(pl.label, 0, 0);
  ctx.restore();
}

/** Grille métrique : lignes fines au pas `step`, lignes fortes tous les 100 cm. */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  v: View,
  w: number,
  h: number,
  step: number,
) {
  const stepPx = step * v.scale;
  if (stepPx < 5) return; // trop dense : on masque
  const tl = screenToWorld({ x: 0, y: 0 }, v);
  const br = screenToWorld({ x: w, y: h }, v);

  const line = (fromWorld: number, vertical: boolean, strong: boolean) => {
    ctx.beginPath();
    ctx.strokeStyle = strong ? '#cbd5e1' : '#e9edf2';
    ctx.lineWidth = 1;
    if (vertical) {
      const s = worldToScreen({ x: fromWorld, y: 0 }, v).x;
      ctx.moveTo(s, 0); ctx.lineTo(s, h);
    } else {
      const s = worldToScreen({ x: 0, y: fromWorld }, v).y;
      ctx.moveTo(0, s); ctx.lineTo(w, s);
    }
    ctx.stroke();
  };

  const x0 = Math.floor(tl.x / step) * step;
  for (let x = x0; x <= br.x; x += step) line(x, true, Math.abs(x % 100) < 1e-6);
  const y0 = Math.floor(tl.y / step) * step;
  for (let y = y0; y <= br.y; y += step) line(y, false, Math.abs(y % 100) < 1e-6);
}

export function drawRoomOutline(ctx: CanvasRenderingContext2D, poly: Point[], v: View) {
  if (poly.length < 2) return;
  pathPoly(ctx, poly, v);
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Tracé en cours + sommets + cotes. */
export function drawDrawing(ctx: CanvasRenderingContext2D, pts: Point[], v: View) {
  if (pts.length === 0) return;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#2563eb';
  for (const p of pts) {
    const s = worldToScreen(p, v);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Cotes des segments.
  ctx.fillStyle = '#1e3a8a';
  ctx.font = '12px system-ui';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const m = worldToScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v);
    ctx.fillText(`${Math.round(len)} cm`, m.x + 4, m.y - 4);
  }
}
