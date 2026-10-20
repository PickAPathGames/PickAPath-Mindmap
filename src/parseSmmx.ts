// parseSmmx.ts — runs in the Tauri webview frontend.
// DOMParser and JSZip are both real in-browser here; no Rust round-trip needed.
// npm install jszip
//
// Direct port of parse_smmx.py, algorithm verified against real exported
// .smmx files (both small and large). This file's own TS/DOM syntax is
// standard-API but not independently executed — run it via test-cli.ts
// and diff against parse_smmx.py's output on the same file.

import JSZip from "jszip";

export type TopicColor =
  | { type: "palette"; index: number; hex: string | null }
  | { type: "custom"; fill: string | null; stroke: string | null };

export interface ResolvedTopic {
  id: string;
  parent: string;
  text: string;
  x: number;
  y: number;
  color: TopicColor | null;
}

// Cross-links — separate from the parent/child tree. Confirmed against a
// real mindmap.xml: <relation source="X" target="Y" asHierarchy="True"/>.
// asHierarchy is present only sometimes; best-supported reading is "style
// this cross-link like a tree line rather than the usual dashed cross-link
// look" — kept as data either way since line-style differentiation isn't
// built yet.
export interface ResolvedRelation {
  source: string;
  target: string;
  asHierarchy: boolean;
}

// Only "bright-palette" hex confirmed so far. Add other style keys
// (e.g. "system.colors-on-black-palette") once read off SimpleMind's own picker.
const DEFAULT_PALETTE: Record<number, string> = {
  1: "#0033FF", 2: "#FF0000", 3: "#FF9900", 4: "#FBC02D",
  5: "#33FF00", 6: "#00CCFF", 7: "#9900FF", 8: "#FF80C0",
};

// Manual direct-child match instead of `:scope >` — avoids depending on
// a CSS selector-engine feature across DOMParser implementations.
function directChild(el: Element, tagName: string): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

function rgbHex(el: Element | null): string | null {
  if (!el) return null;
  const r = Number(el.getAttribute("r"));
  const g = Number(el.getAttribute("g"));
  const b = Number(el.getAttribute("b"));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function parseSmmxFile(
  fileBytes: ArrayBuffer
): Promise<{ styleKey: string | null; topics: ResolvedTopic[]; relations: ResolvedRelation[] }> {
  const zip = await JSZip.loadAsync(fileBytes);
  const xmlFile = zip.file("document/mindmap.xml");
  if (!xmlFile) throw new Error("not a valid .smmx: missing document/mindmap.xml");
  const xmlText = await xmlFile.async("text");
  return parseMindmapXml(xmlText);
}

export function parseMindmapXml(
  xmlText: string
): { styleKey: string | null; topics: ResolvedTopic[]; relations: ResolvedRelation[] } {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("mindmap.xml failed to parse: " + parseError.textContent);

  const metaEl = doc.querySelector("meta");
  const styleEl = metaEl ? directChild(metaEl, "style") : null;
  const styleKey = styleEl?.getAttribute("key") ?? null;

  const topicEls = Array.from(doc.querySelectorAll("topics > topic"));
  const byId = new Map<string, Element>();
  for (const el of topicEls) byId.set(el.getAttribute("id")!, el);

  function resolveColor(id: string, seen: Set<string> = new Set()): TopicColor | null {
    if (seen.has(id) || !byId.has(id)) return null; // cycle guard
    seen.add(id);
    const el = byId.get(id)!;

    const fill = rgbHex(directChild(el, "fillcolor"));
    const stroke = rgbHex(directChild(el, "strokecolor"));
    if (fill || stroke) return { type: "custom", fill, stroke };

    const palette = el.getAttribute("palette");
    if (palette && palette !== "0") {
      const idx = Number(palette);
      return { type: "palette", index: idx, hex: DEFAULT_PALETTE[idx] ?? null };
    }

    const parent = el.getAttribute("parent")!;
    if (parent === "-1") return null;
    return resolveColor(parent, seen);
  }

  const topics: ResolvedTopic[] = topicEls.map((el) => {
    const id = el.getAttribute("id")!;
    return {
      id,
      parent: el.getAttribute("parent")!,
      text: el.getAttribute("text") ?? "",
      x: Number(el.getAttribute("x")),
      y: Number(el.getAttribute("y")),
      color: resolveColor(id),
    };
  });

  const relations: ResolvedRelation[] = Array.from(doc.querySelectorAll("relations > relation")).map(
    (el) => ({
      source: el.getAttribute("source")!,
      target: el.getAttribute("target")!,
      asHierarchy: el.getAttribute("asHierarchy")?.toLowerCase() === "true",
    })
  );

  return { styleKey, topics, relations };
}