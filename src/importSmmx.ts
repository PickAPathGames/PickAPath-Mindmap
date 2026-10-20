// importSmmx.ts — converts a parsed SimpleMind map (parseSmmx.ts, verified
// back when we built it) into this app's Node/Edge shape.
import type { Node, Edge } from "@xyflow/react";
import type { MindmapNodeData } from "./MindmapNode";
import { parseSmmxFile, type ResolvedTopic } from "./parseSmmx";

// SimpleMind text markup: \N (capital — confirmed against real data) marks
// a line break, \*...\* toggles bold.
//
// \N mixes deliberate Enter presses and SimpleMind's own word-wrap with no
// way to tell them apart (confirmed by checking SimpleMind's other export
// formats — html/opml/mm all treat wrap and real breaks identically, so
// the distinction is lost at the source, not just in our import). Tested
// both keeping \N as a real newline and converting it to a space; kept as
// newline — matches the visual layout and position/coordinate alignment
// better across real cards than flattening to spaces did.
function cleanSmmxText(raw: string): string {
  return raw.replace(/\\N/gi, "\n").replace(/\\\*/g, "");
}

function topicColorToHex(color: ResolvedTopic["color"]): string | null {
  if (!color) return null;
  if (color.type === "custom") return color.stroke ?? color.fill ?? null;
  return color.hex; // may be null if this palette/style key isn't in the table yet
}

export async function importSmmx(
  fileBytes: ArrayBuffer,
  onTextChange: (id: string, text: string) => void
): Promise<{ nodes: Node<MindmapNodeData>[]; edges: Edge[] }> {
  const { topics, relations } = await parseSmmxFile(fileBytes);

  const nodes: Node<MindmapNodeData>[] = topics.map((t) => ({
    id: t.id,
    type: "mindmap",
    position: { x: t.x, y: t.y },
    data: { text: cleanSmmxText(t.text), color: topicColorToHex(t.color), onTextChange },
  }));

  const treeEdges: Edge[] = topics
    .filter((t) => t.parent !== "-1")
    .map((t) => ({ id: `e${t.parent}-${t.id}`, source: t.parent, target: t.id, type: "floating" }));

  // Cross-links, same dedup rule as manual connections use at runtime:
  // same pair in either direction counts as a duplicate, whether against a
  // tree edge or another relation.
  const seen = new Set(treeEdges.map((e) => [e.source, e.target].sort().join("|")));
  const relationEdges: Edge[] = [];
  for (const r of relations) {
    const key = [r.source, r.target].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    relationEdges.push({ id: `e${r.source}-${r.target}`, source: r.source, target: r.target, type: "floating" });
  }

  return { nodes, edges: [...treeEdges, ...relationEdges] };
}