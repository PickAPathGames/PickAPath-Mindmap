// FloatingEdge.tsx — edges connect true center to true center, always (see
// the long comment history in prior versions of this file for two earlier
// wrong attempts at that specific problem).
//
// Arrows are drawn manually (SVG markers can't attach to a path endpoint
// buried at a node's center) via getShapeIntersectionT: closed-form, O(1)
// math for the distance along a ray from a node's center to where it
// crosses that node's TRUE outline — rectangle (rounded corners),
// ellipse/circle, or diamond each have a direct formula, no curve-tracing
// or iteration, so this stays cheap regardless of edge count.
// import { useState } from "react";
import {
  useInternalNode,
  getStraightPath,
  getBezierPath,
  getSmoothStepPath,
  Position,
  BaseEdge,
  type EdgeProps,
} from "@xyflow/react";
import type { MindmapShape } from "./MindmapNode";

export interface FloatingEdgeData {
  color?: string | null;
  lineStyle?: "solid" | "dashed" | "dotted";
  lineWidth?: number;
  pathStyle?: "straight" | "curved" | "angled" | "rounded";
  arrow?: "none" | "incoming" | "outgoing" | "both";
  [key: string]: unknown;
}

type Vec = { x: number; y: number };

// Distance (t) from center, along ray `dir`, to this node's TRUE outline.
// forceRectangle bypasses the actual shape and always uses the rectangle
// formula — used by the reconnect dot below, which needs to sit outside
// the invisible rectangular hit-area regardless of the visual shape.
function getShapeIntersectionT(w2: number, h2: number, shape: MindmapShape | undefined, dir: Vec, forceRectangle = false): number {
  const dx = dir.x;
  const dy = dir.y;
  if ((dx === 0 && dy === 0) || w2 <= 0 || h2 <= 0) return 0;

  if (!forceRectangle && (shape === "circle" || shape === "ellipse")) {
    const denom = Math.sqrt((dx / w2) ** 2 + (dy / h2) ** 2);
    return denom > 0 ? 1 / denom : 0;
  }
  if (!forceRectangle && shape === "diamond") {
    const denom = Math.abs(dx) / w2 + Math.abs(dy) / h2;
    return denom > 0 ? 1 / denom : 0;
  }

  const r = Math.min(10, w2, h2);
  const A = Math.abs(dx);
  const B = Math.abs(dy);
  const u = w2 - r;
  const v = h2 - r;
  if (B > 0 && (A * h2) / B <= u) return h2 / B;
  if (A > 0 && (B * w2) / A <= v) return w2 / A;
  const a = dx * dx + dy * dy;
  const b = -2 * (A * u + B * v);
  const c = u * u + v * v - r * r;
  const disc = Math.max(0, b * b - 4 * a * c);
  return a > 0 ? (-b + Math.sqrt(disc)) / (2 * a) : 0;
}

function getShapeIntersection(center: Vec, w2: number, h2: number, shape: MindmapShape | undefined, dir: Vec): Vec {
  const t = getShapeIntersectionT(w2, h2, shape, dir);
  return { x: center.x + t * dir.x, y: center.y + t * dir.y };
}

// The reconnect dot lives in the edges SVG layer, which renders BEHIND
// nodes — and a node's clickable area is always its full rectangular
// bounding box, even when it's visually a circle/ellipse/diamond (CSS
// border-radius and the diamond's SVG overlay only clip paint, not hit-
// testing, same root cause as the earlier text-overflow bug). For a
// shape that's cut in from the rectangle, the true boundary point often
// falls UNDER that invisible rectangular hit-area, silently stealing the
// dot's clicks. Fix: never place the dot closer than the rectangle's own
// edge — take whichever is farther out, shape or rectangle, plus a small
// fixed margin for comfortable clearance.
// function getDotPosition(center: Vec, w2: number, h2: number, shape: MindmapShape | undefined, dir: Vec): Vec {
//   const shapeT = getShapeIntersectionT(w2, h2, shape, dir);
//   const rectT = getShapeIntersectionT(w2, h2, shape, dir, true);
//   const t = Math.max(shapeT, rectT) + 5;
//   return { x: center.x + t * dir.x, y: center.y + t * dir.y };
// }

function getEdgePosition(center: Vec, point: Vec): Position {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? Position.Right : Position.Left;
  return dy > 0 ? Position.Bottom : Position.Top;
}

// getBezierPath's own return format — "M{sx},{sy} C{c1x},{c1y} {c2x},{c2y}
// {tx},{ty}", one cubic segment, confirmed against @xyflow's own source.
const BEZIER_PATH_RE = /^M(-?[\d.]+),(-?[\d.]+) C(-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+)$/;

function normalizeOr(v: Vec, fallback: Vec): Vec {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len } : fallback;
}

type CubicControlPoints = [Vec, Vec, Vec, Vec]; // [P0 source, P1, P2, P3 target]

function parseBezierControlPoints(path: string): CubicControlPoints | null {
  const m = BEZIER_PATH_RE.exec(path);
  if (!m) return null; // format changed upstream — fail safe, not silently wrong
  const [sx, sy, c1x, c1y, c2x, c2y, tx, ty] = m.slice(1).map(Number);
  return [{ x: sx, y: sy }, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x: tx, y: ty }];
}

function bezierPoint([p0, p1, p2, p3]: CubicControlPoints, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

// Derivative of the same cubic — the curve's true local direction of
// travel at parameter t, as opposed to bezierPoint's position at t.
function bezierTangent([p0, p1, p2, p3]: CubicControlPoints, t: number): Vec {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, c = 3 * t * t;
  return {
    x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x),
    y: a * (p1.y - p0.y) + b * (p2.y - p1.y) + c * (p3.y - p2.y),
  };
}

// Same convex-shape assumption getShapeIntersectionT already relies on: a
// ray from center crosses the outline exactly once, so `point` is inside
// iff it's nearer to center than that ray's own boundary distance.
function isInsideShape(point: Vec, center: Vec, w2: number, h2: number, shape: MindmapShape | undefined): boolean {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return true;
  return dist < getShapeIntersectionT(w2, h2, shape, { x: dx / dist, y: dy / dist });
}

const BOUNDARY_SEARCH_ITERATIONS = 20; // ~2^-20 of the curve — far finer than a pixel, still trivially cheap

// Bisects ALONG THE CURVE ITSELF for where it crosses `center`'s shape,
// starting from the end (t=0 or t=1) that's known to sit at that node's
// own center — unlike getShapeIntersectionT, there's no closed form for
// "where does a cubic cross a rounded rect/ellipse/diamond", so this
// walks in numerically instead. Needed because the curve keeps bending
// past its own endpoint tangent, so a straight ray from center (however
// well-aimed) can miss the point the visible curve actually passes
// through, especially on cards big enough that the bend is still
// happening when the curve reaches their edge.
function findBoundaryT(
  cp: CubicControlPoints,
  center: Vec,
  w2: number,
  h2: number,
  shape: MindmapShape | undefined,
  atNode: 0 | 1
): number {
  let lo: number = atNode; // known inside (this end IS the node's center)
  let hi: number = atNode === 0 ? 1 : 0; // presumed outside
  if (isInsideShape(bezierPoint(cp, hi), center, w2, h2, shape)) return hi; // nodes overlapping enough that the whole curve is inside — nothing to bisect
  for (let i = 0; i < BOUNDARY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (isInsideShape(bezierPoint(cp, mid), center, w2, h2, shape)) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Which way is further INTO the node from a point attached at this side —
// exact (not approximate) for angled/rounded, since step-routing really
// is axis-aligned right at its endpoint by construction. NOT used for
// curved anymore (see below) — a bezier's tangent isn't reliably axis-
// aligned the way a step path's is, so it used the wrong model entirely.
function inwardVector(position: Position): Vec {
  switch (position) {
    case Position.Left:
      return { x: 1, y: 0 };
    case Position.Right:
      return { x: -1, y: 0 };
    case Position.Top:
      return { x: 0, y: 1 };
    case Position.Bottom:
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 0 };
  }
}

function ArrowHead({ point, direction, color }: { point: Vec; direction: Vec; color: string }) {
  const angleDeg = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  return (
    <polygon
      points="-10,-5 0,0 -10,5"
      fill={color}
      transform={`translate(${point.x} ${point.y}) rotate(${angleDeg})`}
      style={{ pointerEvents: "none" }}
    />
  );
}

export function FloatingEdge({ id, source, target, style, data, selected }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  // const [dotHover, setDotHover] = useState(false);

  if (!sourceNode || !targetNode) return null;

  const sw2 = (sourceNode.measured?.width ?? 0) / 2;
  const sh2 = (sourceNode.measured?.height ?? 0) / 2;
  const tw2 = (targetNode.measured?.width ?? 0) / 2;
  const th2 = (targetNode.measured?.height ?? 0) / 2;
  const sourceCenter = { x: sourceNode.internals.positionAbsolute.x + sw2, y: sourceNode.internals.positionAbsolute.y + sh2 };
  const targetCenter = { x: targetNode.internals.positionAbsolute.x + tw2, y: targetNode.internals.positionAbsolute.y + th2 };
  const sourceShape = (sourceNode.data as { shape?: MindmapShape }).shape;
  const targetShape = (targetNode.data as { shape?: MindmapShape }).shape;

  const edgeData = data as FloatingEdgeData | undefined;
  const pathStyle = edgeData?.pathStyle ?? "straight";

  // point-to-point direction — used directly for straight, and as the
  // degenerate/fallback direction for curved (parse failure, or a zero-
  // length tangent where a control point lands exactly on its endpoint).
  const ptpDx = targetCenter.x - sourceCenter.x;
  const ptpDy = targetCenter.y - sourceCenter.y;
  const ptpLen = Math.hypot(ptpDx, ptpDy) || 1;
  const pointToPointDir: Vec = { x: ptpDx / ptpLen, y: ptpDy / ptpLen };

  let edgePath: string;
  let sourceRotationDir: Vec;
  let targetRotationDir: Vec;
  // Set only for curved edges whose path parsed cleanly — the exact point
  // where the curve crosses each node's outline, overriding the generic
  // ray-cast-from-center below (which assumes a straight line and can't
  // follow a bezier that's still bending when it reaches the edge).
  let curvedBoundary: { source: Vec; target: Vec } | null = null;

  if (pathStyle === "straight") {
    [edgePath] = getStraightPath({
      sourceX: sourceCenter.x,
      sourceY: sourceCenter.y,
      targetX: targetCenter.x,
      targetY: targetCenter.y,
    });
    targetRotationDir = pointToPointDir;
    sourceRotationDir = { x: -pointToPointDir.x, y: -pointToPointDir.y };
  } else {
    const sourcePosition = getEdgePosition(sourceCenter, targetCenter);
    const targetPosition = getEdgePosition(targetCenter, sourceCenter);

    if (pathStyle === "curved") {
      [edgePath] = getBezierPath({
        sourceX: sourceCenter.x,
        sourceY: sourceCenter.y,
        sourcePosition,
        targetX: targetCenter.x,
        targetY: targetCenter.y,
        targetPosition,
      });
      const cp = parseBezierControlPoints(edgePath);
      if (cp) {
        const tSource = findBoundaryT(cp, sourceCenter, sw2, sh2, sourceShape, 0);
        const tTarget = findBoundaryT(cp, targetCenter, tw2, th2, targetShape, 1);
        const sourceForward = normalizeOr(bezierTangent(cp, tSource), pointToPointDir);
        const targetForward = normalizeOr(bezierTangent(cp, tTarget), pointToPointDir);
        sourceRotationDir = { x: -sourceForward.x, y: -sourceForward.y };
        targetRotationDir = targetForward;
        curvedBoundary = { source: bezierPoint(cp, tSource), target: bezierPoint(cp, tTarget) };
      } else {
        // format changed upstream — fall back to the old approximation rather than crash
        targetRotationDir = pointToPointDir;
        sourceRotationDir = { x: -pointToPointDir.x, y: -pointToPointDir.y };
      }
    } else {
      [edgePath] = getSmoothStepPath({
        sourceX: sourceCenter.x,
        sourceY: sourceCenter.y,
        sourcePosition,
        targetX: targetCenter.x,
        targetY: targetCenter.y,
        targetPosition,
        borderRadius: pathStyle === "rounded" ? 8 : 0,
      });
      sourceRotationDir = inwardVector(sourcePosition);
      targetRotationDir = inwardVector(targetPosition);
    }
  }

  // PLACEMENT direction — the opposite of rotation: points OUT of the card
  // toward the other node, so the ray lands on the near crossing (where the
  // line actually pierces the outline) instead of the far one.
  const sourcePlacementDir = { x: -sourceRotationDir.x, y: -sourceRotationDir.y };
  const targetPlacementDir = { x: -targetRotationDir.x, y: -targetRotationDir.y };

  const sourceBoundaryPoint =
    curvedBoundary?.source ?? getShapeIntersection(sourceCenter, sw2, sh2, sourceShape, sourcePlacementDir);
  const targetBoundaryPoint =
    curvedBoundary?.target ?? getShapeIntersection(targetCenter, tw2, th2, targetShape, targetPlacementDir);
  // const dotPosition = getDotPosition(sourceCenter, sw2, sh2, sourceShape, sourcePlacementDir);


  const inheritedColor = (targetNode.data as { color?: string | null }).color ?? "#666";
  const color = edgeData?.color ?? inheritedColor;
  const dashArray =
    edgeData?.lineStyle === "dashed" ? "8 4" : edgeData?.lineStyle === "dotted" ? "1.5 4" : undefined;
  const strokeWidth = (edgeData?.lineWidth ?? 2) + (selected ? 2 : 0);
  const arrow = edgeData?.arrow ?? "none";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ ...style, stroke: color, strokeWidth, strokeDasharray: dashArray }}
      />
      {(arrow === "incoming" || arrow === "both") && (
        <ArrowHead point={sourceBoundaryPoint} direction={sourceRotationDir} color={color} />
      )}
      {(arrow === "outgoing" || arrow === "both") && (
        <ArrowHead point={targetBoundaryPoint} direction={targetRotationDir} color={color} />
      )}
      {/* {selected && (
        // Reconnect dot — source end only (matches SimpleMind: you can
        // reassign a card's parent, not pick a different child). Canvas.tsx
        // detects mousedown on this specific element via data-reconnect-edge
        // and drives the actual drag; this only needs to be visible,
        // identifiable, and clickable — not handle the drag itself.
        <circle
          data-reconnect-edge={id}
          cx={dotPosition.x}
          cy={dotPosition.y}
          r={dotHover ? 7 : 5}
          fill="#fff"
          stroke={color}
          strokeWidth={2}
          onMouseEnter={() => setDotHover(true)}
          onMouseLeave={() => setDotHover(false)}
          style={{ cursor: "grab", pointerEvents: "all" }}
        />
      )} */}
    </>
  );
}