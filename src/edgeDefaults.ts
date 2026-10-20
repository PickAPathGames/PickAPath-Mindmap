// edgeDefaults.ts — shared between Canvas.tsx (applying/creating edges) and
// canvasFile.ts (reconstructing edges on load). data.arrow is the source of
// truth we save/load; markerStart/markerEnd are the actual React Flow
// fields that render the arrowhead, always derived from it here so the two
// never drift out of sync.
import { MarkerType } from "@xyflow/react";
import type { FloatingEdgeData } from "./FloatingEdge";

export function arrowToMarkers(arrow: FloatingEdgeData["arrow"]) {
  // Fixed neutral gray rather than trying to live-match the line's
  // (possibly inherited, possibly changing) color — keeps this simple.
  const marker = { type: MarkerType.ArrowClosed, color: "#999" };
  return {
    markerStart: arrow === "incoming" || arrow === "both" ? marker : undefined,
    markerEnd: arrow === "outgoing" || arrow === "both" ? marker : undefined,
  };
}