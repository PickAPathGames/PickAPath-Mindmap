// canvasFile.ts — save/load. Uses JSON Canvas (jsoncanvas.org) as the file
// format: open MIT spec, and it's the same format Obsidian Canvas reads, so
// these files stay openable there too as a fallback, even though the actual
// editing model here is nothing like Obsidian's.
import type { Node, Edge } from "@xyflow/react";
import type { MindmapNodeData, MindmapShape } from "./MindmapNode";
import type { FloatingEdgeData } from "./FloatingEdge";

interface JsonCanvasTextNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  colorManual?: boolean; // extra field, outside the spec proper — JSON Canvas explicitly allows this
  shape?: MindmapShape; // extra field
  bold?: boolean; // extra field
  italic?: boolean; // extra field
  underline?: boolean; // extra field
  strikethrough?: boolean; // extra field
  fontSize?: number; // extra field
  textAlign?: "left" | "center" | "right"; // extra field
}

interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  color?: string; // extra field — manual line color override, unset means "inherit"
  lineStyle?: "solid" | "dashed" | "dotted"; // extra field
  lineWidth?: number; // extra field
  pathStyle?: "straight" | "curved" | "angled" | "rounded"; // extra field
  arrow?: "none" | "incoming" | "outgoing" | "both"; // extra field
}

export interface JsonCanvasFile {
  nodes: JsonCanvasTextNode[];
  edges: JsonCanvasEdge[];
}

export function toJsonCanvas(nodes: Node<MindmapNodeData>[], edges: Edge[]): JsonCanvasFile {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "text",
      text: n.data.text,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      // fall back to a sane default only if a node was somehow never
      // measured (shouldn't happen for anything actually on screen)
      width: Math.round(n.measured?.width ?? 140),
      height: Math.round(n.measured?.height ?? 44),
      ...(n.data.color ? { color: n.data.color } : {}),
      ...(n.data.colorManual ? { colorManual: true } : {}),
      ...(n.data.shape && n.data.shape !== "rectangle" ? { shape: n.data.shape } : {}),
      ...(n.data.bold ? { bold: true } : {}),
      ...(n.data.italic ? { italic: true } : {}),
      ...(n.data.underline ? { underline: true } : {}),
      ...(n.data.strikethrough ? { strikethrough: true } : {}),
      ...(n.data.fontSize ? { fontSize: n.data.fontSize } : {}),
      ...(n.data.textAlign ? { textAlign: n.data.textAlign } : {}),
    })),
    edges: edges.map((e) => {
      const d = e.data as FloatingEdgeData | undefined;
      return {
        id: e.id,
        fromNode: e.source,
        toNode: e.target,
        ...(d?.color ? { color: d.color } : {}),
        ...(d?.lineStyle ? { lineStyle: d.lineStyle } : {}),
        ...(d?.lineWidth ? { lineWidth: d.lineWidth } : {}),
        ...(d?.pathStyle && d.pathStyle !== "straight" ? { pathStyle: d.pathStyle } : {}),
        ...(d?.arrow && d.arrow !== "none" ? { arrow: d.arrow } : {}),
      };
    }),
  };
}

export function fromJsonCanvas(
  file: JsonCanvasFile,
  onTextChange: (id: string, text: string) => void
): { nodes: Node<MindmapNodeData>[]; edges: Edge[] } {
  const nodes: Node<MindmapNodeData>[] = file.nodes
    .filter((n) => n.type === "text")
    .map((n) => ({
      id: n.id,
      type: "mindmap",
      position: { x: n.x, y: n.y },
      // Deliberately NOT setting width/height here. They're saved in the
      // file (JSON Canvas requires them), but using them as a hint freezes
      // React Flow's remeasurement — same mistake made and undone in
      // handleDoubleClick a while back, just missed here. That freeze is
      // what caused cards to wrap after reload: a stale saved width plus
      // border-box sizing means a slightly thicker border (search
      // highlight, or just measurement rounding) eats into a width that
      // can no longer grow to compensate.
      data: {
        text: n.text,
        color: n.color ?? null,
        colorManual: n.colorManual ?? false,
        shape: n.shape ?? "rectangle",
        bold: n.bold,
        italic: n.italic,
        underline: n.underline,
        strikethrough: n.strikethrough,
        fontSize: n.fontSize,
        textAlign: n.textAlign,
        onTextChange,
      },
    }));

  const edges: Edge[] = file.edges.map((e) => ({
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    type: "floating",
    data: {
      color: e.color ?? null,
      lineStyle: e.lineStyle,
      lineWidth: e.lineWidth,
      pathStyle: e.pathStyle ?? "straight",
      arrow: e.arrow ?? "none",
    } as FloatingEdgeData,
  }));

  return { nodes, edges };
}