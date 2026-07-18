import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import { useStore } from '../store/useStore';
import { polygonBBox, pointInPolygon, segmentRect, offsetPolygon } from '../model/geometry';
import { ghostRows, poseDirection, poseFrame, type GhostRow, type PoseFrame } from '../model/startline';
import { detectSpaces, spaceCentroid, type Space } from '../model/spaces';
import { flattenPacks, packIdOf } from '../model/stock';
import { doorCenter, doorHost, type DoorHost } from '../model/doors';
import NumberField from '../ui/NumberField';
import { drawGrid, drawPlank, drawRoomOutline, screenToWorld, worldToScreen, type View } from './draw';
import {
  snapDrawPoint, snapToGrid, nearestVertex, nearestEdge, projectToSegment, dist, angleDeg, sub,
  type Guide, type SnapResult,
} from './roomEditing';
import type { Point, Door as DoorT, Partition, Room, WallAlign } from '../model/types';

interface DrawPreview extends SnapResult { hasLast: boolean }
interface EdgeLabel { edgeIndex: number; sx: number; sy: number; length: number }
interface LenEdit { edgeIndex: number; value: string; sx: number; sy: number }
/** Position de la ligne le long du mur auquel elle est aimantée (cotes du plan). */
interface StartWall {
  index: number;
  /** Distance depuis le 1ᵉʳ sommet de l'appui (cm) et longueur totale de l'appui (cm). */
  along: number;
  edgeLen: number;
  a: Point;
  b: Point;
  /** « Mur 3 » ou « Cloison 2 » : sur quoi la ligne s'appuie. */
  label: string;
}
/** Ligne de départ en cours de pose ou déjà posée. */
interface StartLineState {
  point: Point;
  orientationDeg: number;
  preview: boolean;
  wall: StartWall | null;
}

export default function CanvasView({ highlightCuts, showNumbers }: { highlightCuts: boolean; showNumbers: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const {
    tool, room, drawing, result, editor, selectedVertex, config, packs, measures, measureStart,
    addDrawPoint, undoDrawPoint, closeRoom, closeHole, closePartition, clearRoom, setTool,
    moveVertex, insertVertex, deleteVertex, setEdgeLength, selectVertex, addDoor, setConfig,
    removePartition, updatePartition, movePartitionPoint, moveWholePartition, setPartitionLength,
    removeDoor, updateDoor,
    startMeasure, finishMeasure, cancelMeasure, removeMeasure,
    tagSpace,
    snapshot, undo, redo,
  } = useStore();
  const isDrawing = tool === 'draw' || tool === 'hole' || tool === 'wall';
  // Le moteur raisonne en lots de lames ; le stock, lui, se saisit en paquets.
  const batches = useMemo(() => flattenPacks(packs), [packs]);

  // Les pièces sont connues dès qu'il y a des murs : on n'attend pas le calepinage pour
  // les montrer, les nommer ou les exclure.
  const spaces = useMemo(
    () => detectSpaces(room, config.exteriorWallThickness ?? 0),
    [room, config.exteriorWallThickness],
  );
  const [pickedSpace, setPickedSpace] = useState<{ index: number; point: Point } | null>(null);
  const [hoverDoor, setHoverDoor] = useState(false);

  /**
   * Géométrie sur laquelle le tracé s'accroche. Le périmètre n'est pas un guide pour
   * lui-même, mais il l'est pour tout ce qu'on pose ensuite : cloisons, zones, cotes.
   */
  const guides = useMemo<Guide[]>(() => {
    if (tool === 'draw') return [];
    const g: Guide[] = [];
    if (room.points.length >= 2) g.push({ pts: room.points, closed: true });
    for (const w of room.partitions ?? []) g.push({ pts: w.points, closed: false });
    return g;
  }, [tool, room.points, room.partitions]);

  const [view, setView] = useState<View>({ scale: 1.1, ox: -90, oy: -70 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [preview, setPreview] = useState<DrawPreview | null>(null);
  const [override, setOverride] = useState<{ len: string; ang: string }>({ len: '', ang: '' });
  const [lenEdit, setLenEdit] = useState<LenEdit | null>(null);
  const [hoverVertex, setHoverVertex] = useState<number>(-1);
  const [cursorCm, setCursorCm] = useState<Point | null>(null);
  /** Distance tapée au clavier pour poser la ligne de départ à une cote exacte sur le mur. */
  const [alongInput, setAlongInput] = useState('');
  /** Cote verrouillée sur l'axe (0° / 90°) : garantit une mesure bien droite. */
  const [axisLock, setAxisLock] = useState(false);
  const [pickedPlank, setPickedPlank] = useState<
    {
      label: string; length: number; nominalLength: number; width: number;
      usedWidth: number; isRipped: boolean;
      batch: string; pack: string; fromOffcut: boolean; isCut: boolean; sx: number; sy: number;
    } | null
  >(null);

  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const spaceDown = useRef(false);
  const draggingVertex = useRef<number>(-1);
  const draggingPart = useRef<{ pi: number; ki: number } | null>(null);
  const draggingStart = useRef(false);
  /** Porte en cours de glissement : elle coulisse le long de son mur ou de sa cloison. */
  const draggingDoor = useRef<number>(-1);
  /** Cloison déplacée en bloc : index + position du curseur au début du glissement. */
  const draggingWholePart = useRef<{ index: number; from: Point } | null>(null);
  const [selectedEl, setSelectedEl] = useState<{ type: 'partition' | 'door'; index: number } | null>(null);
  const rawWorld = useRef<Point>({ x: 0, y: 0 });
  const edgeLabels = useRef<EdgeLabel[]>([]);
  const fittedRef = useRef(false);

  const vThreshPx = 12;
  const vThresh = () => vThreshPx / view.scale;

  /**
   * Point d'une cote. L'accroche aux murs doit porter plus loin que celle du tracé :
   * sinon la grille happe le point juste avant le mur et la cote s'arrête dans le vide.
   * `axisLock` force la cote à l'horizontale / la verticale exacte (0° ou 90°).
   */
  const snapMeasure = useCallback(
    (raw: Point): SnapResult => {
      const wallSnap = (vThreshPx * 2.2) / view.scale;
      const base = snapDrawPoint({
        points: measureStart ? [measureStart] : [],
        raw, gridStep: editor.gridStep, snapGrid: editor.snapGrid && !axisLock,
        snapAngle: editor.snapAngle && !axisLock, angleStep: editor.angleStep,
        vertexThreshold: wallSnap,
        guides,
      });
      if (!measureStart || !axisLock) return base;
      // Axe verrouillé : on projette sur l'horizontale ou la verticale, celle dont on est
      // le plus proche, en gardant l'accroche au mur le long de cet axe.
      const dx = Math.abs(raw.x - measureStart.x), dy = Math.abs(raw.y - measureStart.y);
      const p = dx >= dy
        ? { x: base.point.x, y: measureStart.y }
        : { x: measureStart.x, y: base.point.y };
      return { ...base, point: p, angle: dx >= dy ? 0 : 90 };
    },
    [measureStart, editor, view.scale, guides, axisLock],
  );

  // --- Ligne de départ ---
  // Repère de pose pour une orientation donnée (partagé avec le calcul de calepinage).
  const frameFor = useCallback(
    (orientationDeg: number) => poseFrame(room, batches, { ...config, orientationDeg }),
    [room, batches, config],
  );

  /**
   * Aimante la ligne de départ : sur le bord de pose le plus proche (cas courant — on
   * démarre le long d'un mur, les lames sont alors parallèles à ce mur), sinon à la grille.
   * `alongOverride` : distance saisie au clavier le long du mur survolé.
   */
  const snapStart = useCallback(
    (w: Point, alongOverride?: number): StartLineState => {
      const gap = config.expansionGap ?? 0;
      const reach = (vThreshPx * 3) / view.scale;

      // Tous les appuis possibles : les murs du périmètre ET les cloisons. On démarre
      // aussi bien le long d'une cloison que d'un mur — c'est même le cas d'une chambre.
      type Cand = { a: Point; b: Point; d: number; point: Point; inset: number; label: string };
      let best: Cand | null = null;
      const consider = (a: Point, b: Point, inset: number, label: string) => {
        const pr = projectToSegment(a, b, w);
        if (pr.d > reach || (best && pr.d >= best.d)) return;
        best = { a, b, d: pr.d, point: pr.point, inset, label };
      };

      const n = room.points.length;
      for (let i = 0; i < n && n >= 3; i++) {
        consider(room.points[i], room.points[(i + 1) % n], gap, `Mur ${i + 1}`);
      }
      (room.partitions ?? []).forEach((part, pi) => {
        for (let i = 0; i < part.points.length - 1; i++) {
          // Le parquet démarre au NU de la cloison, pas sur son axe.
          consider(part.points[i], part.points[i + 1], part.thickness / 2 + gap, `Cloison ${pi + 1}`);
        }
      });

      if (best) {
        const { a, b, inset, label } = best as Cand;
        const edgeLen = dist(a, b) || 1;
        const u = { x: (b.x - a.x) / edgeLen, y: (b.y - a.y) / edgeLen };
        const nrm = { x: -u.y, y: u.x };
        const along = alongOverride != null
          ? Math.max(0, Math.min(edgeLen, alongOverride))
          : projectToSegment(a, b, w).t * edgeLen;

        // On décale du côté où se trouve le curseur : la ligne se pose dans la pièce visée.
        const side = Math.sign((w.x - a.x) * nrm.x + (w.y - a.y) * nrm.y) || 1;
        const base = { x: a.x + u.x * along, y: a.y + u.y * along };
        const point = { x: base.x + nrm.x * inset * side, y: base.y + nrm.y * inset * side };
        const deg = ((Math.round(angleDeg(sub(b, a))) % 180) + 180) % 180;

        return {
          point: { x: Math.round(point.x), y: Math.round(point.y) },
          orientationDeg: deg,
          preview: true,
          wall: { index: 0, along, edgeLen, a, b, label },
        };
      }

      // Loin de tout appui : la ligne suit le curseur au centimètre. La grille la ferait
      // sauter par pas de 10 cm, ce qui rend le geste heurté pour rien.
      return {
        point: { x: Math.round(w.x), y: Math.round(w.y) },
        orientationDeg: config.orientationDeg,
        preview: true,
        wall: null,
      };
    },
    [room.points, room.partitions, config.orientationDeg, config.expansionGap, view.scale],
  );

  // Ligne affichée : aperçu sous le curseur pendant la pose, sinon la ligne validée.
  const startShown = useMemo<StartLineState | null>(() => {
    if (tool === 'startline' && cursorCm) {
      const typed = alongInput ? parseFloat(alongInput) : undefined;
      return snapStart(cursorCm, Number.isFinite(typed) ? typed : undefined);
    }
    if (config.startLine) {
      const s = snapStart(config.startLine);
      return { ...s, point: config.startLine, orientationDeg: config.orientationDeg, preview: false };
    }
    return null;
  }, [tool, cursorCm, alongInput, snapStart, config.startLine, config.orientationDeg]);

  // Rangées telles qu'elles seront posées (masquées une fois le calepinage calculé).
  const startGhost = useMemo<{ frame: PoseFrame; rows: GhostRow[] } | null>(() => {
    if (!startShown || result) return null;
    const frame = frameFor(startShown.orientationDeg);
    if (!frame) return null;
    return { frame, rows: ghostRows(frame, startShown.point, config.startFlip) };
  }, [startShown, result, frameFor, config.startFlip]);

  useEffect(() => { setAlongInput(''); }, [tool]);

  /** Valide la ligne de départ affichée (clic ou Entrée). */
  const commitStartLine = useCallback(() => {
    if (!startShown) return;
    // Aimantée sur un mur : les lames se posent parallèlement à ce mur.
    setConfig({ startLine: startShown.point, orientationDeg: startShown.orientationDeg });
    setAlongInput('');
    setTool('edit');
  }, [startShown, setConfig, setTool]);

  // --- Ajustement de la vue ---
  const fit = useCallback(() => {
    const pts = drawing.length >= 2 ? drawing : room.points;
    if (pts.length < 2) return;
    const bb = polygonBBox(pts);
    const w = Math.max(bb.maxX - bb.minX, 10);
    const h = Math.max(bb.maxY - bb.minY, 10);
    const pad = 60;
    const scale = Math.min((size.w - pad * 2) / w, (size.h - pad * 2) / h);
    setView({ scale, ox: bb.minX - pad / scale, oy: bb.minY - pad / scale });
  }, [room.points, drawing, size]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!fittedRef.current && size.w > 0 && room.points.length >= 3) { fit(); fittedRef.current = true; }
  }, [size, fit, room.points.length]);

  // --- Rendu ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, size.w, size.h);

    if (editor.showGrid && (isDrawing || tool === 'edit')) {
      drawGrid(ctx, view, size.w, size.h, editor.gridStep);
    }

    // Le tracé est le nu intérieur : le sol va jusqu'au trait, le mur pousse vers l'extérieur.
    const extT = config.exteriorWallThickness ?? 0;
    const floorPoly = room.points;

    if (room.points.length >= 3 && !result) fillRoom(ctx, floorPoly, view);
    if (result) for (const pl of result.placed) drawPlank(ctx, pl, view, highlightCuts, showNumbers);
    // Pièces : les exclues sont hachurées (aucun parquet), toutes portent nom et surface.
    for (const sp of spaces) if (sp.excluded) drawExcludedSpace(ctx, sp, view);
    if (result || tool === 'space') {
      for (const sp of spaces) drawSpaceLabel(ctx, sp, view, tool === 'space' && pickedSpace?.index === sp.index);
    }

    // Murs extérieurs épais (bande centrée sur le tracé).
    if (room.points.length >= 3 && extT > 0) drawExteriorWalls(ctx, room.points, extT, view);
    else if (room.points.length >= 2) drawRoomOutline(ctx, room.points, view);

    // Zones exclues.
    for (const h of room.holes ?? []) drawHole(ctx, h, view);
    // Cloisons : bornées au sol, pour qu'elles se raccordent au mur au lieu de le traverser.
    if (room.partitions?.length) {
      ctx.save();
      if (floorPoly.length >= 3) {
        ctx.beginPath();
        floorPoly.forEach((p, i) => {
          const s = worldToScreen(p, view);
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.clip();
      }
      // Toutes les cloisons fusionnées en une seule forme : les jonctions (T, L, croix)
      // se soudent, sans couture ni contour interne à l'endroit où deux cloisons se touchent.
      drawPartitionsUnion(ctx, room.partitions, view);
      ctx.restore();
    }
    // Portes / ouvertures (murs du périmètre et cloisons).
    for (const d of room.doors ?? []) {
      const host = doorHost(room, d, extT);
      if (host) drawDoor(ctx, host, d, view);
    }
    // Ligne de départ : rangées fantômes (avant calcul) + ligne et flèches de sens.
    if (startGhost) drawGhostRows(ctx, startGhost.rows, view);
    if (startShown) {
      const frame = startGhost?.frame ?? frameFor(startShown.orientationDeg);
      const dir = frame ? poseDirection(frame, config.startFlip) : { x: 0, y: 1 };
      drawStartLine(ctx, startShown, dir, view);
    }

    edgeLabels.current = [];
    // Cotes permanentes des murs : le tracé étant le nu intérieur, la cote affichée est
    // bien la longueur mesurée dans la pièce.
    if (room.points.length >= 2) drawDims(ctx, room.points, view, edgeLabels.current);
    // Cotes des cloisons intérieures : chaque segment porte sa longueur, comme les murs.
    for (const w of room.partitions ?? []) drawPartitionDims(ctx, w.points, view);
    // Sommets manipulables (édition seule).
    if (tool === 'edit' && room.points.length >= 2) {
      drawVertices(ctx, room.points, view, hoverVertex, selectedVertex);
      drawPartitionHandles(ctx, room.partitions ?? [], view);
    }
    if (tool === 'edit') drawSelection(ctx, room, selectedEl, view, extT);
    if (isDrawing) {
      drawDrawState(ctx, drawing, preview, view);
      if (preview) drawSnapMark(ctx, preview, view);
    }

    // Cotes posées, puis celle en cours de pose (second point sous le curseur).
    for (const m of measures) drawMeasure(ctx, m.a, m.b, view, false);
    if (tool === 'measure' && cursorCm) {
      const snap = snapMeasure(cursorCm);
      if (measureStart) drawMeasure(ctx, measureStart, snap.point, view, true);
      drawSnapMark(ctx, snap, view);
    }
  }, [size, view, result, room, drawing, highlightCuts, showNumbers, tool, isDrawing, editor, config, preview, hoverVertex, selectedVertex, selectedEl, cursorCm, startShown, startGhost, frameFor, measures, measureStart, snapMeasure, axisLock, spaces, pickedSpace]);

  // Pose d'une porte : sur le mur OU la cloison la plus proche, la plus proche gagne.
  const placeDoor = (w: Point) => {
    const reach = vThresh() * 2.5;
    const onWall = nearestEdge(room.points, w, reach, true);
    let best: { host: 'wall' | 'partition'; index: number; seg: number; t: number; d: number } | null =
      onWall ? { host: 'wall', index: onWall.index, seg: 0, t: onWall.t, d: onWall.d } : null;

    (room.partitions ?? []).forEach((part, pi) => {
      const hit = nearestEdge(part.points, w, reach, false);
      if (hit && (!best || hit.d < best.d)) {
        best = { host: 'partition', index: pi, seg: hit.index, t: hit.t, d: hit.d };
      }
    });
    if (best) addDoor(best.host, best.index, best.seg, best.t);
  };

  // Centre d'une porte (repère pièce).
  const doorCenterWorld = (d: DoorT): Point | null => {
    const host = doorHost(room, d, config.exteriorWallThickness ?? 0);
    return host ? doorCenter(host, d) : null;
  };
  // Extrémité de cloison proche (pour glisser).
  const partitionEndpointHit = (w: Point): { pi: number; ki: number } | null => {
    const parts = room.partitions ?? [];
    for (let pi = 0; pi < parts.length; pi++)
      for (let ki = 0; ki < parts[pi].points.length; ki++)
        if (dist(parts[pi].points[ki], w) <= vThresh()) return { pi, ki };
    return null;
  };
  // Segment de cloison proche (pour sélectionner).
  const partitionSegHit = (w: Point): number => {
    const parts = room.partitions ?? [];
    for (let pi = 0; pi < parts.length; pi++)
      if (nearestEdge(parts[pi].points, w, vThresh() * 1.5, false)) return pi;
    return -1;
  };
  const doorHit = (w: Point): number => {
    const doors = room.doors ?? [];
    for (let i = 0; i < doors.length; i++) {
      const c = doorCenterWorld(doors[i]);
      if (c && dist(c, w) <= Math.max(vThresh() * 2, doors[i].width / 2)) return i;
    }
    return -1;
  };

  // --- Helpers coordonnées ---
  const eventToWorld = (e: React.MouseEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, view);
  };

  const computePreview = useCallback((raw: Point): DrawPreview => {
    const ov = {
      overrideLen: override.len ? parseFloat(override.len) : undefined,
      overrideAngle: override.ang ? parseFloat(override.ang) : undefined,
    };
    const res = snapDrawPoint({
      points: drawing, raw, gridStep: editor.gridStep, snapGrid: editor.snapGrid,
      snapAngle: editor.snapAngle, angleStep: editor.angleStep, vertexThreshold: vThresh(),
      guides,
      ...ov,
    });
    return { ...res, hasLast: drawing.length > 0 };
  }, [drawing, editor, override, view.scale, guides]);

  // --- Souris ---
  const onMouseDown = (e: React.MouseEvent) => {
    const w = eventToWorld(e);
    rawWorld.current = w;
    // Clic du milieu ou barre d'espace : pan, quel que soit l'outil — sinon impossible de
    // se déplacer en cours de tracé sans sortir de l'outil.
    if (e.button === 1 || spaceDown.current) {
      dragRef.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
      return;
    }
    if (e.button !== 0) return;
    if (tool === 'edit') {
      // La ligne de départ se rattrape par sa poignée (prioritaire sur les sommets).
      if (config.startLine && dist(config.startLine, w) <= vThresh() * 1.5) {
        draggingStart.current = true;
        snapshot();
        selectVertex(null); setSelectedEl(null);
        return;
      }
      // Une porte se saisit et coulisse : c'est le geste attendu pour la repositionner.
      const dh = doorHit(w);
      if (dh >= 0) {
        snapshot();
        draggingDoor.current = dh;
        setSelectedEl({ type: 'door', index: dh });
        selectVertex(null); setPickedPlank(null);
        return;
      }
      const vi = nearestVertex(room.points, w, vThresh());
      if (vi >= 0) { snapshot(); draggingVertex.current = vi; selectVertex(vi); setSelectedEl(null); return; }
      const pep = partitionEndpointHit(w);
      if (pep) { snapshot(); draggingPart.current = pep; setSelectedEl({ type: 'partition', index: pep.pi }); selectVertex(null); return; }
      // Corps d'une cloison (hors extrémité) : on la déplace en bloc.
      const pseg = partitionSegHit(w);
      if (pseg >= 0) {
        snapshot();
        draggingWholePart.current = { index: pseg, from: { x: w.x, y: w.y } };
        setSelectedEl({ type: 'partition', index: pseg }); selectVertex(null); setPickedPlank(null);
        return;
      }
    }
    dragRef.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const w = eventToWorld(e);
    rawWorld.current = w;
    if (tool === 'measure' && e.shiftKey !== axisLock) setAxisLock(e.shiftKey);
    if (isDrawing || tool === 'edit' || tool === 'startline' || tool === 'measure') {
      setCursorCm({ x: Math.round(w.x), y: Math.round(w.y) });
    }

    // Glisser la ligne de départ (édition).
    if (draggingStart.current) {
      const s = snapStart(w);
      setConfig({ startLine: s.point, orientationDeg: s.orientationDeg });
      return;
    }
    // Coulisser une porte le long de son support.
    if (draggingDoor.current >= 0) {
      const i = draggingDoor.current;
      const door = room.doors[i];
      const host = door ? doorHost(room, door, config.exteriorWallThickness ?? 0) : null;
      if (host) {
        const len = dist(host.a, host.b) || 1;
        const t = projectToSegment(host.a, host.b, w).t;
        // La porte ne peut pas déborder de son mur : on borne par sa demi-largeur.
        const half = Math.min(door.width, len) / 2 / len;
        updateDoor(i, { center: Math.max(half, Math.min(1 - half, t)) });
      }
      return;
    }

    // Glisser un sommet (édition).
    if (draggingVertex.current >= 0) {
      const snapped = editor.snapGrid ? snapToGrid(w, editor.gridStep) : w;
      moveVertex(draggingVertex.current, { x: Math.round(snapped.x), y: Math.round(snapped.y) });
      return;
    }
    // Glisser une extrémité de cloison.
    if (draggingPart.current) {
      const snapped = editor.snapGrid ? snapToGrid(w, editor.gridStep) : w;
      movePartitionPoint(draggingPart.current.pi, draggingPart.current.ki, { x: Math.round(snapped.x), y: Math.round(snapped.y) });
      return;
    }
    // Déplacer une cloison entière : translation de tous ses points, calée à la grille.
    if (draggingWholePart.current) {
      const drag = draggingWholePart.current;
      const gx = editor.snapGrid ? Math.round((w.x - drag.from.x) / editor.gridStep) * editor.gridStep : w.x - drag.from.x;
      const gy = editor.snapGrid ? Math.round((w.y - drag.from.y) / editor.gridStep) * editor.gridStep : w.y - drag.from.y;
      moveWholePartition(drag.index, gx, gy);
      draggingWholePart.current = { index: drag.index, from: { x: drag.from.x + gx, y: drag.from.y + gy } };
      return;
    }

    const d = dragRef.current;
    if (d && e.buttons === 1) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      setView((v) => ({ ...v, ox: d.ox - dx / v.scale, oy: d.oy - dy / v.scale }));
      return;
    }

    if (isDrawing) setPreview(computePreview(w));
    else if (tool === 'edit') {
      setHoverVertex(nearestVertex(room.points, w, vThresh()));
      setHoverDoor(doorHit(w) >= 0 || partitionSegHit(w) >= 0 || partitionEndpointHit(w) != null);
    }
  };

  const onMouseUp = () => {
    if (draggingDoor.current >= 0) { draggingDoor.current = -1; return; }
    if (draggingStart.current) { draggingStart.current = false; return; }
    if (draggingVertex.current >= 0) { draggingVertex.current = -1; return; }
    if (draggingPart.current) { draggingPart.current = null; return; }
    if (draggingWholePart.current) { draggingWholePart.current = null; return; }
    setTimeout(() => (dragRef.current = null), 0);
  };

  const onClick = (e: React.MouseEvent) => {
    // Ignore seulement si le curseur a réellement bougé (glissement/pan).
    const d = dragRef.current;
    if (d && (Math.abs(e.clientX - d.x) > 6 || Math.abs(e.clientY - d.y) > 6)) return;
    const w = eventToWorld(e);

    // Sélection d'une lame posée (afficher son libellé + longueur).
    if (result && tool === 'edit') {
      const rect = canvasRef.current!.getBoundingClientRect();
      for (const pl of result.placed) {
        if (pl.pieces.some((pc) => pointInPolygon(w, pc))) {
          const b = batches.find((x) => x.id === pl.sourceBatchId);
          setPickedPlank({
            label: pl.label, length: +pl.usedLength.toFixed(1), width: pl.width,
            nominalLength: +pl.length.toFixed(1),
            usedWidth: +pl.usedWidth.toFixed(1), isRipped: pl.isRipped,
            batch: b ? `${b.length}×${b.width}` : pl.sourceBatchId,
            pack: packs.find((p) => p.id === packIdOf(pl.sourceBatchId))?.name ?? '—',
            fromOffcut: pl.fromOffcut, isCut: pl.isCut,
            sx: e.clientX - rect.left, sy: e.clientY - rect.top,
          });
          break;
        }
      }
    }

    if (isDrawing) {
      const p = computePreview(w);
      // La fermeture n'existe que pour un polygone (pièce/zone), pas pour une cloison.
      if (p.closing && tool !== 'wall') { tool === 'hole' ? closeHole() : closeRoom(); setPreview(null); return; }
      addDrawPoint({ x: Math.round(p.point.x * 10) / 10, y: Math.round(p.point.y * 10) / 10 });
      setOverride({ len: '', ang: '' });
      return;
    }

    if (tool === 'space') {
      const hit = spaces.find((sp) => pointInPolygon(w, sp.outer));
      setPickedSpace(hit ? { index: hit.index, point: { x: Math.round(w.x), y: Math.round(w.y) } } : null);
      return;
    }

    if (tool === 'measure') {
      // Clic sur une cote existante (près de son étiquette ou de sa ligne) : on la retire.
      if (!measureStart) {
        const hit = measures.find((m) => {
          const mid = { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 };
          return dist(mid, w) <= vThresh() * 2 || nearestEdge([m.a, m.b], w, vThresh(), false);
        });
        if (hit) { removeMeasure(hit.id); return; }
      }
      if (measureStart) snapshot();
      const p = snapMeasure(w).point;
      const q = { x: Math.round(p.x), y: Math.round(p.y) };
      if (measureStart) finishMeasure(q); else startMeasure(q);
      return;
    }

    if (tool === 'door') { snapshot(); placeDoor(w); return; }

    if (tool === 'startline') { commitStartLine(); return; }

    if (tool === 'edit') {
      // Clic sur une cote -> édition numérique.
      const rect = canvasRef.current!.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      let hit: EdgeLabel | null = null;
      for (const l of edgeLabels.current) {
        if (Math.hypot(l.sx - sx, l.sy - sy) < 18) { hit = l; break; }
      }
      if (hit) {
        setLenEdit({ edgeIndex: hit.edgeIndex, value: String(Math.round(hit.length)), sx: hit.sx, sy: hit.sy });
        return;
      }
      // Sélection d'une cloison ou d'une porte.
      const di = doorHit(w);
      if (di >= 0) { setSelectedEl({ type: 'door', index: di }); selectVertex(null); setPickedPlank(null); return; }
      const pi = partitionSegHit(w);
      if (pi >= 0) { setSelectedEl({ type: 'partition', index: pi }); selectVertex(null); setPickedPlank(null); return; }
      // Clic ailleurs : désélection.
      setSelectedEl(null);
      if (nearestVertex(room.points, w, vThresh()) < 0) selectVertex(null);
    }
  };

  // Termine le tracé courant selon le mode (les actions du store se gardent seules).
  const finishDrawing = () => {
    if (tool === 'wall') closePartition();
    else if (tool === 'hole') closeHole();
    else closeRoom();
    setPreview(null);
    setOverride({ len: '', ang: '' });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (isDrawing) {
      // Les deux clics du double ont ajouté un point en trop : on le retire puis on termine.
      undoDrawPoint();
      setTimeout(finishDrawing, 0);
      return;
    }
    if (tool !== 'edit') return;
    const w = eventToWorld(e);
    if (nearestVertex(room.points, w, vThresh()) >= 0) return;
    const edge = nearestEdge(room.points, w, vThresh() * 1.5);
    if (edge) {
      const snapped = editor.snapGrid ? snapToGrid(edge.point, editor.gridStep) : edge.point;
      insertVertex(edge.index, { x: Math.round(snapped.x), y: Math.round(snapped.y) });
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (isDrawing) { e.preventDefault(); finishDrawing(); }
    // Pendant la pose de la ligne : le clic droit inverse le côté posé en premier.
    else if (tool === 'startline') { e.preventDefault(); setConfig({ startFlip: !config.startFlip }); }
  };

  /** Zoom autour d'un point écran, borné. */
  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    setView((v) => {
      const scale = Math.max(0.03, Math.min(120, v.scale * factor));
      if (scale === v.scale) return v;
      const before = screenToWorld({ x: sx, y: sy }, v);
      return { scale, ox: before.x - sx / scale, oy: before.y - sy / scale };
    });
  }, []);

  /**
   * Molette : zoom (souris) ou pincement (trackpad, qui arrive avec `ctrlKey`).
   * Défilement à deux doigts : pan, comme dans tout éditeur de plan.
   * Le zoom est continu (exponentiel) et non par crans : un pas fixe donne des sauts.
   */
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const pinch = e.ctrlKey || e.metaKey;
    const trackpadPan = !pinch && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.6;

    if (trackpadPan) {
      setView((v) => ({ ...v, ox: v.ox + e.deltaX / v.scale, oy: v.oy + e.deltaY / v.scale }));
      return;
    }
    // Molette classique : crans de ±100 ; trackpad : petits deltas continus.
    const step = pinch ? 0.01 : 0.0022;
    zoomAt(mx, my, Math.exp(-e.deltaY * step));
  };

  // Recalcule l'aperçu quand la longueur saisie change (sans mouvement souris).
  useEffect(() => {
    if (tool === 'draw' && drawing.length > 0) setPreview(computePreview(rawWorld.current));
  }, [override.len, tool, drawing.length, computePreview]);

  const commitDrawFromInput = useCallback(() => {
    const p = computePreview(rawWorld.current);
    addDrawPoint({ x: Math.round(p.point.x * 10) / 10, y: Math.round(p.point.y * 10) / 10 });
    setOverride({ len: '', ang: '' });
  }, [computePreview, addDrawPoint]);

  // Navigation : zoom au clavier, pan à la barre d'espace.
  useEffect(() => {
    const center = () => ({ x: size.w / 2, y: size.h / 2 });
    const down = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (e.code === 'Space') { spaceDown.current = true; return; }
      // Les raccourcis de zoom (+ - 0) sont désactivés quand on saisit une longueur au
      // clavier : sinon taper « 40 » déclenche « 0 » = ajuster la vue, et la vue saute.
      if (isDrawing || tool === 'startline' || tool === 'measure') return;
      if (e.key === '+' || e.key === '=') { const c = center(); zoomAt(c.x, c.y, 1.2); }
      else if (e.key === '-' || e.key === '_') { const c = center(); zoomAt(c.x, c.y, 1 / 1.2); }
      else if (e.key === '0') fit();
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [zoomAt, fit, size, undo, redo, isDrawing, tool]);

  // --- Clavier ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ne pas interférer avec la saisie d'une cote existante (mode édition).
      if (document.activeElement instanceof HTMLInputElement) return;
      if (tool === 'measure' && e.key === 'Escape') {
        if (measureStart) cancelMeasure(); else setTool('edit');
        return;
      }
      if (tool === 'startline') {
        if (e.key === 'Tab' || e.key === ' ') {
          e.preventDefault();
          setConfig({ startFlip: !useStore.getState().config.startFlip });
        } else if (/^[0-9.]$/.test(e.key)) {
          e.preventDefault();
          setAlongInput((s) => s + e.key); // cote exacte le long du mur survolé
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          setAlongInput((s) => s.slice(0, -1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commitStartLine();
        } else if (e.key === 'Escape') {
          setAlongInput((s) => (s ? '' : (setTool('edit'), s)));
        }
        return;
      }
      if (isDrawing) {
        if (/^[0-9.]$/.test(e.key)) {
          e.preventDefault();
          setOverride((o) => ({ ...o, len: o.len + e.key }));
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          setOverride((o) => {
            if (o.len) return { ...o, len: o.len.slice(0, -1) };
            undoDrawPoint();
            return o;
          });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          setOverride((o) => {
            if (o.len) { commitDrawFromInput(); return { len: '', ang: '' }; }
            if (tool === 'wall') { if (drawing.length >= 2) closePartition(); }
            else if (drawing.length >= 3) (tool === 'hole' ? closeHole() : closeRoom());
            return o;
          });
        } else if (e.key === 'Escape') {
          setOverride((o) => (o.len ? { ...o, len: '' } : (clearRoom(), setTool('edit'), o)));
        }
      } else if (tool === 'edit') {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedVertex != null) deleteVertex(selectedVertex);
          else if (selectedEl?.type === 'partition') { removePartition(selectedEl.index); setSelectedEl(null); }
          else if (selectedEl?.type === 'door') { removeDoor(selectedEl.index); setSelectedEl(null); }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, isDrawing, drawing.length, selectedVertex, selectedEl, measureStart, cancelMeasure, undoDrawPoint, clearRoom, setTool, setConfig, closeRoom, closeHole, closePartition, deleteVertex, removePartition, removeDoor, commitDrawFromInput, commitStartLine]);

  const commitLenEdit = () => {
    if (!lenEdit) return;
    const v = parseFloat(lenEdit.value);
    if (v > 0) setEdgeLength(lenEdit.edgeIndex, v);
    setLenEdit(null);
  };

  const onStartHandle =
    tool === 'edit' && config.startLine != null && cursorCm != null
    && dist(config.startLine, cursorCm) <= vThresh() * 1.5;
  const cursor = isDrawing || tool === 'door' || tool === 'startline' || tool === 'measure' ? 'crosshair'
    : tool === 'space' ? 'pointer'
    : tool === 'edit' ? (hoverVertex >= 0 || onStartHandle || hoverDoor ? 'move' : 'default') : 'grab';

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { setPreview(null); setHoverVertex(-1); setCursorCm(null); }}
        style={{ display: 'block', cursor, outline: 'none' }}
      />

      {/* Placement d'un point de cloison sur un mur : distance au coin (comme sur un plan). */}
      {tool === 'wall' && !preview?.hasLast && preview && (() => {
        const off = wallOffsetAt(room.points, preview.point);
        if (!off) return null;
        return (
          <div className="draw-hud">
            <span className="hud-field">
              Mur {off.edgeIndex + 1} · <b>{Math.round(off.along)}</b> / {Math.round(off.edgeLen)} cm
            </span>
            <span className="hud-hint">posez le 1ᵉʳ point le long du mur · l'accroche est en vert</span>
          </div>
        );
      })()}

      {/* Boîte de mesure pendant le tracé (tapez la longueur, Entrée valide) */}
      {isDrawing && preview?.hasLast && (
        <div className="draw-hud">
          <span className="hud-field">
            L <b className={override.len ? 'typed' : ''}>
              {override.len || (preview.length != null ? Math.round(preview.length) : 0)}
            </b> cm
          </span>
          <span className="hud-field">
            ∠ <b>{preview.angle != null ? Math.round(preview.angle) : 0}</b>°
          </span>
          <span className="hud-hint">tapez une longueur · Entrée valide · Échap annule</span>
        </div>
      )}

      {/* Cote en cours : distance ET angle en direct */}
      {tool === 'measure' && (
        <div className="draw-hud">
          {measureStart && cursorCm ? (() => {
            const p = snapMeasure(cursorCm).point;
            const d = dist(measureStart, p);
            // Angle ramené dans [-90, 90] : une cote n'a pas de sens, seulement une pente.
            let ang = (Math.atan2(p.y - measureStart.y, p.x - measureStart.x) * 180) / Math.PI;
            if (ang > 90) ang -= 180;
            if (ang < -90) ang += 180;
            const droit = Math.abs(ang) < 0.05 || Math.abs(Math.abs(ang) - 90) < 0.05;
            return (
              <>
                <span className="hud-field">L <b>{Math.round(d)}</b> cm</span>
                <span className="hud-field">
                  ∠ <b className={droit ? 'ok' : ''}>{ang.toFixed(1)}</b>°
                  {droit && <span className="hud-ok"> droit</span>}
                </span>
              </>
            );
          })() : (
            <span className="hud-field">Cliquez le 1ᵉʳ point</span>
          )}
          <span className="hud-hint">
            <b className={axisLock ? 'typed' : ''}>Maj</b> = cote bien droite (0°/90°) ·
            accroche aux murs · Échap annule
          </span>
        </div>
      )}

      {/* Pose de la ligne de départ : cote le long du mur, saisissable au clavier */}
      {tool === 'startline' && startShown && (
        <div className="draw-hud">
          {startShown.wall ? (
            <span className="hud-field">
              {startShown.wall.label} ·{' '}
              <b className={alongInput ? 'typed' : ''}>
                {alongInput || Math.round(startShown.wall.along)}
              </b>{' '}
              / {Math.round(startShown.wall.edgeLen)} cm
            </span>
          ) : (
            <span className="hud-field">
              Hors mur · x <b>{startShown.point.x}</b> · y <b>{startShown.point.y}</b> cm
            </span>
          )}
          <span className="hud-hint">
            {startShown.wall ? 'tapez une distance · Entrée valide · ' : ''}
            clic droit ou Tab = inverser le sens · Échap annule
          </span>
        </div>
      )}

      {/* Édition d'une cote existante */}
      {lenEdit && (
        <div className="len-edit" style={{ left: lenEdit.sx - 40, top: lenEdit.sy - 14 }}>
          <input
            autoFocus
            value={lenEdit.value}
            onChange={(e) => setLenEdit({ ...lenEdit, value: e.target.value.replace(',', '.').replace(/[^0-9.]/g, '') })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLenEdit();
              if (e.key === 'Escape') setLenEdit(null);
            }}
            onBlur={commitLenEdit}
          />
          <span>cm</span>
        </div>
      )}

      {/* Relevé de position du curseur */}
      {cursorCm && (
        <div className="cursor-hud">x {cursorCm.x} · y {cursorCm.y} cm</div>
      )}

      {/* Pièce sélectionnée : nom et exclusion */}
      {tool === 'space' && pickedSpace != null && spaces[pickedSpace.index] && (() => {
        const sp = spaces[pickedSpace.index];
        return (
          <div className="door-card">
            <div className="pc-head">
              <b>{sp.areaM2.toFixed(2)} m²</b>
              <button onClick={() => setPickedSpace(null)}>✕</button>
            </div>
            <label className="field">
              <span>Nom de la pièce</span>
              <input
                value={sp.name}
                onChange={(e) => tagSpace(pickedSpace.point, { name: e.target.value })}
                placeholder="Salon, Chambre…"
              />
            </label>
            <label className="field checkbox">
              <input
                type="checkbox" checked={sp.excluded}
                onChange={(e) => tagSpace(pickedSpace.point, { excluded: e.target.checked })}
              />
              <span title="Aucune lame posée ici, aucun stock consommé : la pièce sort du calepinage et du métré.">
                Ne pas poser de parquet ici
              </span>
            </label>
          </div>
        );
      })()}

      {/* Cloison sélectionnée : la modifier ou la supprimer */}
      {tool === 'edit' && selectedEl?.type === 'partition' && room.partitions[selectedEl.index] && (() => {
        const i = selectedEl.index;
        const w = room.partitions[i];
        const len = w.points.reduce(
          (s, p, k) => (k === 0 ? 0 : s + dist(w.points[k - 1], p)), 0,
        );
        return (
          <div className="door-card">
            <div className="pc-head">
              <b>Cloison {i + 1}</b>
              <button onClick={() => setSelectedEl(null)}>✕</button>
            </div>
            <label className="field">
              <span>Longueur {w.points.length > 2 ? '(dernier segment)' : ''} (cm)</span>
              <input
                type="number" min={1} step={1}
                value={Math.round(w.points.length > 2
                  ? dist(w.points[w.points.length - 2], w.points[w.points.length - 1])
                  : len)}
                onChange={(e) => { const v = +e.target.value; if (v > 0) setPartitionLength(i, v); }}
              />
            </label>
            <div className="muted">Glissez la cloison pour la déplacer, ou une extrémité pour l'étirer.</div>
            <label className="field">
              <span>Épaisseur (cm)</span>
              <NumberField
                value={w.thickness} min={0.5} step={0.5} suffix="cm"
                onChange={(v) => { if (v > 0) updatePartition(i, { thickness: v }); }}
              />
            </label>
            <label className="field">
              <span>Épaisseur portée</span>
              <select
                value={w.align}
                onChange={(e) => updatePartition(i, { align: e.target.value as WallAlign })}
              >
                <option value="center">Centrée (axe)</option>
                <option value="left">À gauche (face)</option>
                <option value="right">À droite (face)</option>
              </select>
            </label>
            <button
              className="danger"
              onClick={() => { removePartition(i); setSelectedEl(null); }}
            >
              🗑 Supprimer la cloison
            </button>
          </div>
        );
      })()}

      {/* Réglages de la porte sélectionnée */}
      {tool === 'edit' && selectedEl?.type === 'door' && room.doors[selectedEl.index] && (() => {
        const i = selectedEl.index;
        const d = room.doors[i];
        return (
          <div className="door-card">
            <div className="pc-head">
              <b>Porte {d.host === 'partition' ? `· cloison ${d.edgeIndex + 1}` : `· mur ${d.edgeIndex + 1}`}</b>
              <button onClick={() => { removeDoor(i); setSelectedEl(null); }}>Suppr.</button>
            </div>
            <div className="muted">Glissez la porte pour la déplacer sur son mur.</div>
            <label className="field">
              <span>Largeur du passage (cm)</span>
              <input
                type="number" min={40} step={1} value={d.width}
                onChange={(e) => updateDoor(i, { width: Math.max(10, +e.target.value) })}
              />
            </label>
            {(() => {
              const host = doorHost(room, d, config.exteriorWallThickness ?? 0);
              if (!host) return null;
              const len = dist(host.a, host.b);
              return (
                <label className="field">
                  <span>Position sur le mur (cm)</span>
                  <input
                    type="number" min={0} step={1} value={Math.round(d.center * len)}
                    onChange={(e) => {
                      const along = Math.max(0, Math.min(len, +e.target.value));
                      updateDoor(i, { center: len > 0 ? along / len : 0.5 });
                    }}
                  />
                </label>
              );
            })()}
            <div className="door-btns">
              <button onClick={() => updateDoor(i, { hinge: d.hinge === 'l' ? 'r' : 'l' })}>
                ⇄ Gond
              </button>
              <button onClick={() => updateDoor(i, { swing: d.swing === 1 ? -1 : 1 })}>
                ⤢ Sens d'ouverture
              </button>
            </div>
            {d.host === 'partition' && (
              <label className="field checkbox" style={{ marginTop: 8 }}>
                <input
                  type="checkbox" checked={d.throughFloor}
                  onChange={(e) => updateDoor(i, { throughFloor: e.target.checked })}
                />
                <span title="Le parquet passe sous la porte : les deux pièces ne font plus qu'une seule zone de pose, la trame est continue. Sinon, barre de seuil et pose indépendante de chaque côté.">
                  Parquet traversant (pas de seuil)
                </span>
              </label>
            )}
          </div>
        );
      })()}

      {/* Fiche d'une lame sélectionnée */}
      {pickedPlank && (
        <div className="plank-card" style={{ left: Math.min(pickedPlank.sx + 10, size.w - 190), top: Math.max(8, pickedPlank.sy - 10) }}>
          <div className="pc-head">
            <b>Lame {pickedPlank.label}</b>
            <button onClick={() => setPickedPlank(null)}>✕</button>
          </div>
          <div>
            Longueur du morceau : <b>{pickedPlank.length} cm</b>
            {pickedPlank.nominalLength > pickedPlank.length + 0.2 && (
              <span className="muted"> (coupée dans {pickedPlank.nominalLength})</span>
            )}
          </div>
          {pickedPlank.isRipped ? (
            <div className="pc-rip">
              Largeur après refend : <b>{pickedPlank.usedWidth} cm</b>{' '}
              <span className="muted">(lame de {pickedPlank.width}, à refendre)</span>
            </div>
          ) : (
            <div>Largeur : {pickedPlank.width} cm <span className="muted">(pleine)</span></div>
          )}
          <div>Lame d'origine : {pickedPlank.batch} cm</div>
          <div>Paquet : <b>{pickedPlank.pack}</b></div>
          <div>{pickedPlank.fromOffcut ? 'Issue d\'une chute réutilisée' : pickedPlank.isCut ? 'Lame neuve, découpée' : 'Lame neuve, entière'}</div>
        </div>
      )}

      <button className="fit-btn" onClick={fit}>Ajuster la vue</button>
    </div>
  );
}

// --- Rendus auxiliaires ---
function fillRoom(ctx: CanvasRenderingContext2D, poly: Point[], v: View) {
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(191,219,254,0.35)';
  ctx.fill();
}

/** Rangées telles qu'elles seront posées : bandes numérotées dans l'ordre de pose. */
function drawGhostRows(ctx: CanvasRenderingContext2D, rows: GhostRow[], v: View) {
  ctx.save();
  ctx.font = '700 11px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const row of rows) {
    ctx.beginPath();
    row.rect.forEach((p, i) => {
      const s = worldToScreen(p, v);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    // Les premières rangées posées sont les plus marquées : on lit le sens d'un coup d'œil.
    const fade = Math.max(0, 0.22 - row.order * 0.02);
    if (fade > 0) { ctx.fillStyle = `rgba(234,88,12,${fade})`; ctx.fill(); }
    ctx.strokeStyle = 'rgba(234,88,12,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (row.order <= 3) {
      // Pastille du rang, au tiers de la rangée pour ne pas gêner la ligne de départ.
      const a = worldToScreen(row.rect[0], v), b = worldToScreen(row.rect[1], v);
      const c = worldToScreen(row.rect[2], v), d = worldToScreen(row.rect[3], v);
      const cx = (a.x + b.x + c.x + d.x) / 4, cy = (a.y + b.y + c.y + d.y) / 4;
      const px = cx + (a.x - b.x) * 0.3, py = cy + (a.y - b.y) * 0.3;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ea580c';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(String(row.order), px, py + 0.5);
    }
  }
  ctx.restore();
}

/**
 * Ligne de départ : trait plein le long des lames + flèches perpendiculaires montrant
 * le côté posé en premier.
 */
function drawStartLine(ctx: CanvasRenderingContext2D, st: StartLineState, poseDir: Point, v: View) {
  const { point: pt, orientationDeg, preview } = st;
  const r = (orientationDeg * Math.PI) / 180;
  const dir = { x: Math.cos(r), y: Math.sin(r) }; // sens des lames
  const L = 100000;
  const a = worldToScreen({ x: pt.x - dir.x * L, y: pt.y - dir.y * L }, v);
  const b = worldToScreen({ x: pt.x + dir.x * L, y: pt.y + dir.y * L }, v);
  const s = worldToScreen(pt, v);
  const color = preview ? 'rgba(234,88,12,0.85)' : '#ea580c';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  ctx.stroke();

  // Flèches du sens de pose : perpendiculaires à la ligne, vers le premier côté posé.
  const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / dl, uy = (b.y - a.y) / dl; // le long de la ligne (écran)
  const o = worldToScreen({ x: 0, y: 0 }, v);
  const pd = worldToScreen(poseDir, v);
  const pl = Math.hypot(pd.x - o.x, pd.y - o.y) || 1;
  const nx = (pd.x - o.x) / pl, ny = (pd.y - o.y) / pl; // sens de pose (écran)
  const arrow = 34;
  ctx.lineWidth = 2;
  ctx.fillStyle = color;
  for (const t of [-140, 0, 140]) {
    const bx = s.x + ux * t, by = s.y + uy * t;
    const tx = bx + nx * arrow, ty = by + ny * arrow;
    ctx.beginPath();
    ctx.moveTo(bx, by); ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - nx * 8 + ux * 5, ty - ny * 8 + uy * 5);
    ctx.lineTo(tx - nx * 8 - ux * 5, ty - ny * 8 - uy * 5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = color;
  ctx.fill(); ctx.stroke();

  // Cote de position le long du mur : « 287 / 580 » depuis le sommet du mur.
  if (st.wall) drawWallOffset(ctx, st.wall, color, v);

  // Étiquette, du côté opposé aux flèches pour rester lisible.
  const label = preview
    ? (st.wall ? 'Clic : départ le long de ce mur · clic droit = inverser le sens' : 'Clic : poser la ligne · clic droit = inverser le sens')
    : 'Ligne de départ — 1ʳᵉ rangée';
  ctx.font = '600 11px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width + 12;
  const lx = s.x - nx * 22 + 10, ly = s.y - ny * 22;
  ctx.fillStyle = color;
  roundRect(ctx, lx, ly - 9, w, 18, 5);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, lx + 6, ly + 0.5);
  ctx.restore();
}

/**
 * Ligne de cote le long du mur d'appui : du 1ᵉʳ sommet du mur jusqu'à la ligne de départ,
 * avec la valeur lue sur le mur (« 287 / 580 cm »).
 */
function drawWallOffset(ctx: CanvasRenderingContext2D, wall: StartWall, color: string, v: View) {
  const { a, b, along, edgeLen } = wall;
  const u = { x: (b.x - a.x) / (edgeLen || 1), y: (b.y - a.y) / (edgeLen || 1) };
  const at = { x: a.x + u.x * along, y: a.y + u.y * along };
  const sa = worldToScreen(a, v), sb = worldToScreen(b, v), st = worldToScreen(at, v);

  ctx.save();
  // Mur d'appui surligné.
  ctx.strokeStyle = 'rgba(234,88,12,0.35)';
  ctx.lineWidth = 6;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
  // Portion mesurée, en plein.
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y); ctx.lineTo(st.x, st.y);
  ctx.stroke();

  const txt = `${Math.round(along)} / ${Math.round(edgeLen)} cm`;
  ctx.font = '700 12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const mx = (sa.x + st.x) / 2, my = (sa.y + st.y) / 2;
  const w = ctx.measureText(txt).width + 14;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  roundRect(ctx, mx - w / 2, my - 10, w, 20, 6);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#9a3412';
  ctx.fillText(txt, mx, my + 0.5);
  ctx.restore();
}

/** Étiquette d'une pièce : nom + surface, posée en son centre. */
function drawSpaceLabel(
  ctx: CanvasRenderingContext2D,
  sp: Space,
  v: View,
  selected = false,
) {
  const c = worldToScreen(spaceCentroid(sp), v);
  const title = sp.name;
  const sub = sp.excluded ? `${sp.areaM2.toFixed(2)} m² · non posée` : `${sp.areaM2.toFixed(2)} m²`;
  ctx.save();
  ctx.font = '700 13px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.max(ctx.measureText(title).width, ctx.measureText(sub).width) + 20;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = selected ? '#2563eb' : 'rgba(100,116,139,0.5)';
  ctx.lineWidth = selected ? 2 : 1;
  roundRect(ctx, c.x - w / 2, c.y - 20, w, 40, 8);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = sp.excluded ? '#b45309' : '#0f172a';
  ctx.fillText(title, c.x, c.y - 8);
  ctx.font = '600 12px system-ui';
  ctx.fillStyle = sp.excluded ? '#b45309' : '#475569';
  ctx.fillText(sub, c.x, c.y + 9);
  ctx.restore();
}

/** Pièce non parquetée : hachurée, pour qu'on ne la confonde jamais avec une pièce posée. */
function drawExcludedSpace(ctx: CanvasRenderingContext2D, sp: Space, v: View) {
  ctx.save();
  ctx.beginPath();
  sp.outer.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.fillStyle = '#f1f5f9';
  ctx.fill();
  ctx.clip();

  const bb = polygonBBox(sp.outer);
  const tl = worldToScreen({ x: bb.minX, y: bb.minY }, v);
  const br = worldToScreen({ x: bb.maxX, y: bb.maxY }, v);
  ctx.strokeStyle = 'rgba(180,83,9,0.35)';
  ctx.lineWidth = 1.5;
  for (let x = tl.x - (br.y - tl.y); x < br.x; x += 10) {
    ctx.beginPath();
    ctx.moveTo(x, tl.y);
    ctx.lineTo(x + (br.y - tl.y), br.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Distance d'un point (posé sur le périmètre) au coin de départ de son mur. */
function wallOffsetAt(poly: Point[], p: Point): { edgeIndex: number; along: number; edgeLen: number } | null {
  const n = poly.length;
  if (n < 2) return null;
  let best: { edgeIndex: number; along: number; edgeLen: number; d: number } | null = null;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const pr = projectToSegment(a, b, p);
    if (pr.d > 3 || (best && pr.d >= best.d)) continue;
    const edgeLen = dist(a, b);
    best = { edgeIndex: i, along: pr.t * edgeLen, edgeLen, d: pr.d };
  }
  return best;
}

/** Cote entre deux points : ligne d'attache, extrémités marquées, valeur au milieu. */
function drawMeasure(ctx: CanvasRenderingContext2D, a: Point, b: Point, v: View, live: boolean) {
  const sa = worldToScreen(a, v), sb = worldToScreen(b, v);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const color = live ? '#0891b2' : '#0e7490';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  if (live) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Traits d'extrémité, perpendiculaires à la cote.
  const dl = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
  const px = (-(sb.y - sa.y) / dl) * 6, py = ((sb.x - sa.x) / dl) * 6;
  for (const s of [sa, sb]) {
    ctx.beginPath();
    ctx.moveTo(s.x + px, s.y + py); ctx.lineTo(s.x - px, s.y - py);
    ctx.stroke();
  }

  // Angle de la cote, pour repérer d'un coup d'œil si elle est bien droite.
  let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (ang > 90) ang -= 180;
  if (ang < -90) ang += 180;
  const droit = Math.abs(ang) < 0.05 || Math.abs(Math.abs(ang) - 90) < 0.05;
  const txt = droit ? `${Math.round(len)} cm` : `${Math.round(len)} cm · ${ang.toFixed(1)}°`;
  ctx.font = '700 12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
  const w = ctx.measureText(txt).width + 14;
  ctx.fillStyle = '#ecfeff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  roundRect(ctx, mx - w / 2, my - 10, w, 20, 6);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#155e75';
  ctx.fillText(txt, mx, my + 0.5);
  ctx.restore();
}

/** Marque l'accroche courante : carré sur un angle de mur, losange sur son tracé. */
function drawSnapMark(ctx: CanvasRenderingContext2D, snap: SnapResult, v: View) {
  if (!snap.onGuide) return;
  const s = worldToScreen(snap.point, v);
  ctx.save();
  ctx.strokeStyle = '#16a34a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (snap.onGuide === 'vertex') {
    ctx.rect(s.x - 6, s.y - 6, 12, 12);
  } else {
    ctx.moveTo(s.x, s.y - 7); ctx.lineTo(s.x + 7, s.y);
    ctx.lineTo(s.x, s.y + 7); ctx.lineTo(s.x - 7, s.y);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

function drawPartitionHandles(ctx: CanvasRenderingContext2D, parts: Partition[], v: View) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  for (const wpart of parts)
    for (const p of wpart.points) {
      const s = worldToScreen(p, v);
      ctx.beginPath();
      ctx.rect(s.x - 4, s.y - 4, 8, 8);
      ctx.fill(); ctx.stroke();
    }
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  room: Room,
  sel: { type: 'partition' | 'door'; index: number } | null,
  v: View,
  wallThickness: number,
) {
  if (!sel) return;
  ctx.strokeStyle = '#ea580c';
  ctx.lineWidth = 2.5;
  if (sel.type === 'partition') {
    const wpart = room.partitions[sel.index];
    if (!wpart || wpart.points.length < 2) return;
    ctx.save();
    // Axe de la cloison en surbrillance : on saisit d'un coup d'œil laquelle est prise.
    ctx.strokeStyle = '#0f9488';
    ctx.lineWidth = Math.max(5, wpart.thickness * v.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    wpart.points.forEach((p, i) => {
      const s = worldToScreen(p, v);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Poignées : ce sont elles qu'on attrape pour étirer la cloison.
    for (const p of wpart.points) {
      const s = worldToScreen(p, v);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#0f9488';
      ctx.lineWidth = 2.5;
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  } else {
    const d = room.doors[sel.index];
    if (!d) return;
    const host = doorHost(room as Room, d, wallThickness);
    if (!host) return;
    const s = worldToScreen(doorCenter(host, d), v);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Murs extérieurs : anneau plein entre la face extérieure et la face intérieure, pas un
 * trait épais. Un `stroke` large fait déborder les angles (pointes de miter) et ne donne
 * pas de face franche ; ici les deux faces sont de vraies géométries, donc les angles
 * se coupent net, y compris sur les murs obliques.
 */
function drawExteriorWalls(ctx: CanvasRenderingContext2D, poly: Point[], thickness: number, v: View) {
  // `poly` est le nu intérieur : l'épaisseur est portée entièrement vers l'extérieur.
  const inner = poly;
  const outer = offsetPolygon(poly, -thickness);

  const trace = (pts: Point[], reverse: boolean) => {
    const list = reverse ? [...pts].reverse() : pts;
    list.forEach((p, i) => {
      const s = worldToScreen(p, v);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  };

  // Anneau : contour extérieur + contour intérieur en sens inverse, rempli en non-zero.
  ctx.beginPath();
  trace(outer, false);
  trace(inner, true);
  ctx.fillStyle = '#b8c0cc';
  ctx.fill();

  // Faces franches.
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1;
  for (const face of [outer, inner]) {
    ctx.beginPath();
    trace(face, false);
    ctx.stroke();
  }
}

/**
 * Toutes les cloisons dessinées comme UNE seule masse : on unit leurs emprises (via
 * `polygon-clipping`), puis on remplit et on contoure le résultat. Les jonctions entre
 * segments d'une même cloison et entre cloisons différentes se soudent proprement — plus
 * de couture ni de trait interne là où deux cloisons se touchent.
 */
function drawPartitionsUnion(ctx: CanvasRenderingContext2D, parts: Partition[], v: View) {
  const rings: Ring[] = [];
  for (const wall of parts) {
    const last = wall.points.length - 2;
    for (let i = 0; i <= last; i++) {
      const rect = segmentRect(
        wall.points[i], wall.points[i + 1], wall.thickness, wall.align, i > 0, i < last,
      );
      rings.push(rect.map((p) => [p.x, p.y] as [number, number]));
    }
  }
  if (rings.length === 0) return;

  const polys = rings.map((r) => [r] as Polygon);
  let union: MultiPolygon;
  try {
    union = polygonClipping.union(polys[0], ...polys.slice(1));
  } catch {
    union = polys; // géométrie dégénérée : au pire, on trace sans fusion
  }

  // Cloison intérieure : noire (convention d'architecte, distincte des murs extérieurs gris).
  ctx.fillStyle = '#1e293b';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  for (const poly of union) {
    ctx.beginPath();
    for (const ring of poly) {
      ring.forEach(([x, y], k) => {
        const s = worldToScreen({ x, y }, v);
        if (k === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.stroke();
  }
}

/** Porte : baie percée dans l'épaisseur du support (mur OU cloison), vantail et débattement. */
function drawDoor(ctx: CanvasRenderingContext2D, host: DoorHost, door: DoorT, v: View) {
  const { a, b, near, far } = host;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edgeLen = Math.hypot(dx, dy) || 1;
  const ux = dx / edgeLen, uy = dy / edgeLen;
  const px = -uy, py = ux; // normale gauche du support

  const half = Math.min(door.width, edgeLen) / 2;
  const c = { x: a.x + ux * (door.center * edgeLen), y: a.y + uy * (door.center * edgeLen) };
  const at = (t: number, off: number): Point => ({
    x: c.x + ux * t + px * off,
    y: c.y + uy * t + py * off,
  });

  // Baie : on efface toute l'épaisseur du support, d'une face à l'autre.
  const corners = [at(-half, near), at(half, near), at(half, far), at(-half, far)];
  ctx.beginPath();
  corners.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.fillStyle = '#f8fafc';
  ctx.fill();

  // Tableaux (les joues de la baie).
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of [-half, half]) {
    const s = worldToScreen(at(t, near), v), q = worldToScreen(at(t, far), v);
    ctx.moveTo(s.x, s.y); ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();

  // Barre de seuil : le parquet s'arrête sous la porte. Absente si le parquet traverse.
  if (!door.throughFloor) {
    const s = worldToScreen(at(-half, (near + far) / 2), v);
    const q = worldToScreen(at(half, (near + far) / 2), v);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y); ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }

  // Vantail + arc de débattement, du côté choisi.
  const swing = door.swing ?? host.defaultSwing;
  const hingeT = door.hinge === 'l' ? -half : half;
  const hinge = at(hingeT, 0);
  const leaf = { x: hinge.x + px * swing * door.width, y: hinge.y + py * swing * door.width };
  const sh = worldToScreen(hinge, v), sl = worldToScreen(leaf, v);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sl.x, sl.y); ctx.stroke();
  const so = worldToScreen(at(-hingeT, 0), v);
  const a0 = Math.atan2(sl.y - sh.y, sl.x - sh.x);
  const a1 = Math.atan2(so.y - sh.y, so.x - sh.x);
  const r = Math.hypot(sl.x - sh.x, sl.y - sh.y);
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  ctx.beginPath();
  ctx.arc(sh.x, sh.y, r, a0, a0 + d, d < 0);
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawHole(ctx: CanvasRenderingContext2D, poly: Point[], v: View) {
  if (poly.length < 3) return;
  ctx.save();
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.fillStyle = '#e2e8f0';
  ctx.fill();
  ctx.clip();
  // Hachures diagonales pour signaler la zone exclue.
  const bb = polygonBBox(poly);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  const tl = worldToScreen({ x: bb.minX, y: bb.minY }, v);
  const brr = worldToScreen({ x: bb.maxX, y: bb.maxY }, v);
  for (let x = tl.x - (brr.y - tl.y); x < brr.x; x += 8) {
    ctx.beginPath();
    ctx.moveTo(x, tl.y);
    ctx.lineTo(x + (brr.y - tl.y), brr.y);
    ctx.stroke();
  }
  ctx.restore();
  // Contour.
  ctx.beginPath();
  poly.forEach((p, i) => {
    const s = worldToScreen(p, v);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawDims(
  ctx: CanvasRenderingContext2D, poly: Point[], v: View, labels: EdgeLabel[], wallOffsetPx?: number,
) {
  const n = poly.length;
  ctx.font = '600 12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    // Toujours du côté intérieur : sinon les cotes sautent d'une face à l'autre selon le
    // sens de tracé du mur, et une cote sur deux part hors du plan.
    let nx = -dy / l, ny = dx / l;
    if (!pointInPolygon({ x: mid.x + nx * 0.01, y: mid.y + ny * 0.01 }, poly)) { nx = -nx; ny = -ny; }
    const s = worldToScreen(mid, v);
    const off = 18 + (wallOffsetPx ?? 0);
    const sx = s.x + nx * off, sy = s.y + ny * off;
    labels.push({ edgeIndex: i, sx, sy, length });
    const txt = `${Math.round(length)}`;
    const w = ctx.measureText(txt).width + 12;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#93c5fd';
    ctx.lineWidth = 1;
    roundRect(ctx, sx - w / 2, sy - 10, w, 20, 5);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1d4ed8';
    ctx.fillText(txt, sx, sy);
  }
}

/** Cotes d'une cloison : longueur de chaque segment, en gris foncé (couleur des cloisons). */
function drawPartitionDims(ctx: CanvasRenderingContext2D, pts: Point[], v: View) {
  ctx.font = '600 11px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) continue;
    const dx = b.x - a.x, dy = b.y - a.y, l = length || 1;
    const nx = -dy / l, ny = dx / l;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = worldToScreen(mid, v);
    const sx = s.x + nx * 16, sy = s.y + ny * 16;
    const txt = `${Math.round(length)}`;
    const w = ctx.measureText(txt).width + 10;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    roundRect(ctx, sx - w / 2, sy - 9, w, 18, 5);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1e293b';
    ctx.fillText(txt, sx, sy);
  }
}

function drawVertices(
  ctx: CanvasRenderingContext2D, poly: Point[], v: View, hover: number, selected: number | null,
) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const s = worldToScreen(poly[i], v);
    const active = i === selected;
    const hov = i === hover;
    ctx.beginPath();
    ctx.arc(s.x, s.y, active ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#2563eb' : hov ? '#60a5fa' : '#ffffff';
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
  }
}

function drawDrawState(
  ctx: CanvasRenderingContext2D, pts: Point[], preview: DrawPreview | null, v: View,
) {
  // Polyligne posée.
  if (pts.length > 0) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = worldToScreen(p, v);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Segment de prévisualisation vers le curseur.
  if (preview && pts.length > 0) {
    const a = worldToScreen(pts[pts.length - 1], v);
    const b = worldToScreen(preview.point, v);
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = preview.closing ? '#16a34a' : '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    // Étiquette longueur + angle près du milieu.
    if (preview.length != null) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const txt = preview.angle != null
        ? `${Math.round(preview.length)} cm · ${Math.round(preview.angle)}°`
        : `${Math.round(preview.length)} cm`;
      ctx.font = '600 12px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = 'rgba(15,23,42,0.85)';
      roundRect(ctx, mx - w / 2, my - 22, w, 18, 5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, mx, my - 13);
    }
  }
  // Sommets + surbrillance fermeture.
  ctx.fillStyle = '#2563eb';
  for (const p of pts) {
    const s = worldToScreen(p, v);
    ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill();
  }
  if (preview?.closing && pts.length) {
    const s = worldToScreen(pts[0], v);
    ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 2; ctx.stroke();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
