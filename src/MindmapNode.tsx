// MindmapNode.tsx — custom mindmap card: colored outline, dark fill,
// auto-grows with its text, edits only on double-click.
import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";

export type MindmapShape = "rectangle" | "ellipse" | "circle" | "diamond";

export interface MindmapNodeData {
  text: string;
  color: string | null;
  colorManual?: boolean;
  shape?: MindmapShape;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  textAlign?: "left" | "center" | "right";
  onTextChange: (id: string, text: string) => void;
  highlighted?: boolean;
  autoEdit?: boolean;
  editRequest?: number;
  [key: string]: unknown;
}

export function MindmapNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: MindmapNodeData;
  selected?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  // Only true for the one render where a just-created card kicks itself
  // into edit mode (below) — tells the focus effect to leave the
  // full-content selection selectNodeContents already made instead of
  // collapsing it, so the default text is highlighted and typing replaces
  // it, same as any "select all" convention.
  const selectAllOnFocus = useRef(false);

  // Mount-only and deliberately not reacting to data.autoEdit changing
  // later — it's a one-shot instruction from creation, not an ongoing
  // property of the card, so re-checking it on every data update would be
  // wrong (nothing ever flips it back to trigger this again, but nothing
  // needs to).
  const lastEditRequest = useRef(data.editRequest);

  useEffect(() => {
    if (data.editRequest !== undefined && data.editRequest !== lastEditRequest.current) {
      lastEditRequest.current = data.editRequest;
      selectAllOnFocus.current = true;
      setEditing(true);
    }
  }, [data.editRequest]);

  useEffect(() => {
    if (!editing || !textRef.current) return;
    textRef.current.focus();
    const range = document.createRange();
    range.selectNodeContents(textRef.current);
    if (!selectAllOnFocus.current) {
      range.collapse(false); // normal re-edit: cursor at the end, nothing selected
    } // else: leave the full-content selection as-is so typing overwrites it
    selectAllOnFocus.current = false;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    if (textRef.current) data.onTextChange(id, textRef.current.textContent ?? "");
  }, [id, data]);

  const shape = data.shape ?? "rectangle";
  const color = data.color ?? "#666";
  const borderWidth = 2 + (selected ? 2 : 0) + (data.highlighted === true ? 2 : 0);

  // Diamond can't use a plain CSS border — clip-path would crop a
  // rectangular border into fragments instead of a clean diamond outline,
  // and a rotated-square trick complicates auto-sizing. An SVG polygon
  // behind the text, stretched to the box's actual (content-driven) size
  // via preserveAspectRatio="none", gets a properly-traced outline without
  // fighting the auto-grow layout at all.
  const isDiamond = shape === "diamond";
  const isRound = shape === "circle" || shape === "ellipse";

  // border-radius only clips paint, not layout — text still wraps at the
  // box's full rectangular width and pierces out right where a round/
  // diamond shape curves or tapers in hardest (top/bottom). Centering
  // moves text into the widest area first; extra padding buys margin
  // beyond that. A truly exact fit would need to measure the text and
  // size the shape around it — real complexity for a practical mitigation.
  const shapeStyle: React.CSSProperties =
    shape === "circle"
      ? { borderRadius: "50%", aspectRatio: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center" }
      : shape === "ellipse"
        ? { borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }
        : isDiamond
          ? { border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center" }
          : { borderRadius: 10 };

  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      style={{
        position: "relative",
        padding: isDiamond ? "18px 28px" : isRound ? "26px 32px" : "8px 14px",
        background: "#1e1e1e",
        border: `${borderWidth}px solid ${color}`,
        opacity: data.highlighted === false ? 0.35 : 1,
        color: "#eee",
        fontSize: data.fontSize ?? 14,
        fontWeight: data.bold ? "bold" : "normal",
        fontStyle: data.italic ? "italic" : "normal",
        textDecoration:
          [data.underline && "underline", data.strikethrough && "line-through"].filter(Boolean).join(" ") ||
          "none",
        minWidth: 20,
        maxWidth: 320,
        cursor: editing ? "text" : "default",
        ...shapeStyle,
      }}
    >
      {isDiamond && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: -1 }}
        >
          <polygon
            points="50,2 98,50 50,98 2,50"
            fill="#1e1e1e"
            stroke={color}
            strokeWidth={borderWidth * 2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle
        id="connect"
        type="source"
        position={Position.Right}
        style={{
          opacity: selected ? 1 : 0,
          pointerEvents: selected ? "auto" : "none",
          width: 10,
          height: 10,
          background: data.color ?? "#888",
          border: "2px solid #141414",
        }}
      />
      <div
        ref={textRef}
        // "nodrag" is React Flow's own convention (see its Handle divs in
        // devtools) for "don't let a node-drag start from inside here" —
        // needed only while editing, so text-drag-select works instead of
        // dragging the whole card.
        className={editing ? "nodrag" : undefined}
        contentEditable={editing}
        suppressContentEditableWarning
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
        style={{ outline: "none", whiteSpace: "pre-wrap", wordBreak: "break-word", textAlign: data.textAlign ?? "left" }}
      >
        {data.text}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}