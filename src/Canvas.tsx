// Canvas.tsx — mindmap canvas core.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  applyNodeChanges,
  useEdgesState,
  useReactFlow,
  ConnectionMode,
  reconnectEdge,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MindmapNode, type MindmapNodeData, type MindmapShape } from "./MindmapNode";
import { FloatingEdge, type FloatingEdgeData } from "./FloatingEdge";
import { toJsonCanvas, fromJsonCanvas } from "./canvasFile";
import { importSmmx } from "./importSmmx";
import { save as saveDialog, open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { readTextFile, readFile, writeTextFile, readDir, mkdir, exists } from "@tauri-apps/plugin-fs";
import { documentDir, join, appConfigDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";

const nodeTypes = { mindmap: MindmapNode };
const edgeTypes = { floating: FloatingEdge };
const HOLD_MS = 350;
const PANE_DESELECT_DELAY_MS = 250; // must exceed the OS double-click window
const HISTORY_LIMIT = 100;
const COMMIT_DEBOUNCE_MS = 500; // groups a burst of rapid changes (typing, dragging) into one undo step

const NODE_NUDGE_SMALL = 5;
const NODE_NUDGE_LARGE = 40;
const PAN_STEP_SMALL = 60;
const PAN_STEP_LARGE = 400;

const DIR_VECTORS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

const sidebarButtonStyle = {
  background: "#2a2a2a",
  border: "1px solid #444",
  borderRadius: 6,
  color: "#ddd",
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
} as const;

// Plain SVG chevron, since appearance: none below strips the native
// dropdown arrow along with the native (wrong-theme) box it's fixing.
const SELECT_CHEVRON = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" stroke="#999" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
)}")`;

const sidebarSelectStyle = {
  background: "#2a2a2a",
  border: "1px solid #444",
  borderRadius: 6,
  color: "#ddd",
  padding: "4px 20px 4px 6px",
  fontSize: 12,
  cursor: "pointer",
  // Without this, WebKitGTK (and some other engines) render the CLOSED
  // select box with the native OS widget theme — light background, light
  // text on this Linux setup — ignoring the background/color above;
  // that's exactly the mismatch reported (closed box wrong, opened
  // dropdown list fine, since the list popup was never the native-themed
  // part). appearance: none hands the whole box to this CSS instead.
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage: SELECT_CHEVRON,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 6px center",
} as const;

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32];
const LINE_WIDTHS = [1, 2, 3, 4, 5, 6, 8];

// SimpleMind's own default 8-swatch "bright-palette" — established back
// when we first reverse-engineered the smmx color model, reused here for
// familiarity rather than inventing a different set.
const PALETTE = ["#0033FF", "#FF0000", "#FF9900", "#FBC02D", "#33FF00", "#00CCFF", "#9900FF", "#FF80C0"];

function useCtrlHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Control") setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Control") setHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  return held;
}

function getDescendantIds(rootId: string, childrenOf: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const childId of childrenOf.get(id) ?? []) {
      if (!out.has(childId)) {
        out.add(childId);
        stack.push(childId);
      }
    }
  }
  return out;
}

function nodeCenter(n: Node<MindmapNodeData>): { x: number; y: number } {
  const w = n.measured?.width ?? 140;
  const h = n.measured?.height ?? 44;
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

// In-memory, not the OS clipboard — this is structural (relative
// positions, colors, internal edges), not plain text, and pasting it back
// as JSON into some other app's text field would be meaningless anyway.
// Positions are stored relative to rootId so the copied shape can be
// dropped anywhere and keep its internal layout.
interface ClipboardBranch {
  nodes: Array<{
    id: string;
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
    dx: number;
    dy: number;
  }>;
  edges: Array<{ source: string; target: string; data?: FloatingEdgeData }>;
  rootId: string;
}

let nextId = 1000; // seed above any id an imported map might already use

// Remembers the last-opened file/folder across app restarts. Deliberately
// a plain JSON file via the fs plugin already in use elsewhere in this
// file, rather than pulling in a separate store plugin (that'd mean new
// Cargo/capabilities wiring for what's a two-field object) — appConfigDir
// is the platform-correct place for this kind of app-level setting, as
// opposed to documentDir which is for user-created content.
interface AppSession {
  filePath?: string;
  folderPath?: string;
}

const SESSION_FILE_NAME = "session.json";

async function getSessionFilePath(): Promise<string> {
  const dir = await appConfigDir();
  // Fine if this already exists — only a real failure here (e.g. a missing
  // fs:allow-mkdir permission) should surface, and it'll do so on the
  // read/write that follows regardless.
  await mkdir(dir, { recursive: true }).catch(() => {});
  return join(dir, SESSION_FILE_NAME);
}

async function loadSession(): Promise<AppSession> {
  try {
    const path = await getSessionFilePath();
    if (!(await exists(path))) return {};
    return JSON.parse(await readTextFile(path));
  } catch (err) {
    console.error("couldn't read saved session, starting fresh:", err);
    return {};
  }
}

async function saveSession(session: AppSession): Promise<void> {
  try {
    const path = await getSessionFilePath();
    await writeTextFile(path, JSON.stringify(session, null, 2));
  } catch (err) {
    console.error(
      "couldn't save session (last-opened file/folder won't be remembered next launch) — " +
        "check fs:allow-mkdir and fs:allow-exists are in src-tauri/capabilities/default.json:",
      err
    );
  }
}

type TextStyleDefaults = Pick<
  MindmapNodeData,
  "bold" | "italic" | "underline" | "strikethrough" | "fontSize" | "textAlign"
>;

export function Canvas() {
  const [nodes, setNodes] = useState<Node<MindmapNodeData>[]>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Undo/redo. history/redoStack hold past {nodes,edges} snapshots.
  // lastCommitted tracks the most recent *checkpointed* state (not
  // necessarily the live one) — when a burst of changes settles, THAT
  // (the state from before the burst) is what gets pushed to history, not
  // the state after. skipNextCommit prevents an undo/redo's own state
  // change from immediately re-triggering a new history entry.
  const [history, setHistory] = useState<Array<{ nodes: Node<MindmapNodeData>[]; edges: Edge[] }>>([]);
  const [redoStack, setRedoStack] = useState<Array<{ nodes: Node<MindmapNodeData>[]; edges: Edge[] }>>([]);
  const lastCommitted = useRef<{ nodes: Node<MindmapNodeData>[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const skipNextCommit = useRef(false);
  const commitTimer = useRef<number | null>(null);
  const pendingCenterRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    if (skipNextCommit.current) {
      skipNextCommit.current = false;
      lastCommitted.current = { nodes, edges };
      return;
    }
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      setHistory((h) => [...h.slice(-(HISTORY_LIMIT - 1)), lastCommitted.current]);
      setRedoStack([]);
      lastCommitted.current = { nodes, edges };
    }, COMMIT_DEBOUNCE_MS);
    return () => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current);
    };
  }, [nodes, edges]);

  // Unsaved-changes flag, for the Save button dot and the close prompt.
  // Deliberately a SEPARATE flag from skipNextCommit above: undo/redo do
  // need to mark this dirty (walking state back/forward can land somewhere
  // that no longer matches what's on disk), they just shouldn't create a
  // new history entry — those are two different questions. Only a real
  // load/new/import (via resetHistory) counts as "nothing to save".
  const [dirty, setDirty] = useState(false);
  const skipNextDirty = useRef(true); // mount isn't a user edit either

  useEffect(() => {
    if (skipNextDirty.current) {
      skipNextDirty.current = false;
      return;
    }
    setDirty(true);
  }, [nodes, edges]);

  // Used by load/import/new — a file switch shouldn't carry undo history
  // from whatever was open before it.
  const resetHistory = useCallback((newNodes: Node<MindmapNodeData>[], newEdges: Edge[]) => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    setHistory([]);
    setRedoStack([]);
    lastCommitted.current = { nodes: newNodes, edges: newEdges };
    skipNextCommit.current = true;
    skipNextDirty.current = true;
    setDirty(false);
  }, []);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  // where "Replace Next" resumes from — without this, a replacement that
  // contains the search term (e.g. "idea" -> "ideas") just re-matches its
  // own output forever on the same card instead of ever advancing.
  const [replaceCursor, setReplaceCursor] = useState({ nodeIndex: 0, charOffset: 0 });

  useEffect(() => {
    setReplaceCursor({ nodeIndex: 0, charOffset: 0 });
  }, [searchQuery]);
  const [clipboard, setClipboard] = useState<ClipboardBranch | null>(null);
  // const [reconnecting, setReconnecting] = useState<{ edgeId: string; fromPoint: { x: number; y: number } } | null>(
  //   null
  // );
  // const [reconnectDragPos, setReconnectDragPos] = useState<{ x: number; y: number } | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderFiles, setFolderFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [defaultShape, setDefaultShape] = useState<MindmapShape>("rectangle");
  const [defaultPathStyle, setDefaultPathStyle] = useState<FloatingEdgeData["pathStyle"]>("straight");
  const [defaultArrow, setDefaultArrow] = useState<FloatingEdgeData["arrow"]>("none");
  const [defaultTextStyle, setDefaultTextStyle] = useState<TextStyleDefaults>({});
  const toggleDefaultTextFlag = useCallback(
    (key: "bold" | "italic" | "underline" | "strikethrough") => {
      setDefaultTextStyle((d) => ({ ...d, [key]: !d[key] }) as TextStyleDefaults);
    },
    []
  );
  const [autosaveEnabled, setAutosaveEnabled] = useState(false);
  const [autosaveIntervalMin, setAutosaveIntervalMin] = useState(5);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, setCenter, setViewport, zoomIn, zoomOut, getViewport } = useReactFlow();
  const ctrlHeld = useCtrlHeld();
  const holdTimer = useRef<number | null>(null);
  const deselectTimer = useRef<number | null>(null);

  const cancelHold = useCallback(() => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("mouseup", cancelHold);
    return () => {
      window.removeEventListener("mouseup", cancelHold);
      if (deselectTimer.current) window.clearTimeout(deselectTimer.current);
    };
  }, [cancelHold]);

  const onTextChange = useCallback((id: string, text: string) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, text } } : n)));
  }, []);

  const childrenOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of edges) {
      const list = map.get(e.source) ?? [];
      list.push(e.target);
      map.set(e.source, list);
    }
    return map;
  }, [edges]);

  const refreshFolderFiles = useCallback(async (dir: string) => {
    const entries = await readDir(dir);
    const files = await Promise.all(
      entries
        .filter((e) => e.name?.toLowerCase().endsWith(".canvas"))
        .map(async (e) => ({ name: e.name!, path: await join(dir, e.name!) }))
    );
    files.sort((a, b) => a.name.localeCompare(b.name));
    setFolderFiles(files);
  }, []);

  const chooseFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    setFolderPath(dir);
    await refreshFolderFiles(dir);
  }, [refreshFolderFiles]);

  const loadFileByPath = useCallback(
    async (path: string) => {
      const text = await readTextFile(path);
      const { nodes: loadedNodes, edges: loadedEdges } = fromJsonCanvas(JSON.parse(text), onTextChange);
      setNodes(loadedNodes);
      setEdges(loadedEdges);
      setFilePath(path);
      resetHistory(loadedNodes, loadedEdges);
      // avoid id collisions between loaded nodes and anything created next
      const maxId = Math.max(0, ...loadedNodes.map((n) => Number(n.id)).filter((n) => !Number.isNaN(n)));
      if (maxId >= nextId) nextId = maxId + 1;
    },
    [onTextChange, setEdges, resetHistory]
  );

  // Remember-last-session: restore once on mount, then keep the saved
  // session in sync with filePath/folderPath from then on. sessionRestored
  // guards the very first run of the save-effect below — without it, that
  // effect's initial pass (nodes/edges/paths all still at their startup
  // nulls, before the async restore below has had a chance to run) would
  // immediately overwrite a real saved session with nulls before it was
  // ever read back.
  const sessionRestored = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const session = await loadSession();
        if (session.folderPath) {
          setFolderPath(session.folderPath);
          try {
            await refreshFolderFiles(session.folderPath);
          } catch (err) {
            console.error("couldn't reopen last folder (may have been moved or deleted):", err);
          }
        }
        if (session.filePath) {
          try {
            await loadFileByPath(session.filePath);
          } catch (err) {
            console.error("couldn't reopen last file (may have been moved or deleted):", err);
          }
        }
      } finally {
        sessionRestored.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionRestored.current) return;
    saveSession({ filePath: filePath ?? undefined, folderPath: folderPath ?? undefined });
  }, [filePath, folderPath]);

  const newMap = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setFilePath(null);
    resetHistory([], []);
  }, [setEdges, resetHistory]);

  const saveMap = useCallback(
    async (forcePicker: boolean) => {
      let path = filePath;
      if (forcePicker || !path) {
        const defaultDir = folderPath ?? (await documentDir());
        const picked = await saveDialog({
          defaultPath: await join(defaultDir, "mindmap.canvas"),
          filters: [{ name: "Mind Map", extensions: ["canvas"] }],
        });
        if (!picked) return; // user cancelled
        path = picked;
      }
      if (!path) return;
      await writeTextFile(path, JSON.stringify(toJsonCanvas(nodes, edges), null, 2));
      setFilePath(path);
      setDirty(false);
      if (folderPath) refreshFolderFiles(folderPath); // pick up a newly-created file
    },
    [filePath, nodes, edges, folderPath, refreshFolderFiles]
  );

  // Background/automatic save — silent, so it must never surface the
  // save-as picker: with no filePath yet there's nowhere silent to write
  // to, so this just no-ops until the user does one manual Save.
  const autosave = useCallback(() => {
    if (!filePath || !dirty) return;
    saveMap(false);
  }, [filePath, dirty, saveMap]);

  // Read via ref in the timers below rather than called directly —
  // autosave's identity changes on every edit (it closes over dirty/
  // filePath), and depending on it directly would reset the interval on
  // every keystroke instead of firing on a true fixed cadence.
  const autosaveRef = useRef(autosave);
  useEffect(() => {
    autosaveRef.current = autosave;
  }, [autosave]);

  useEffect(() => {
    if (!autosaveEnabled) return;
    const onBlur = () => autosaveRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [autosaveEnabled]);

  useEffect(() => {
    if (!autosaveEnabled) return;
    const id = window.setInterval(() => autosaveRef.current(), autosaveIntervalMin * 60_000);
    return () => window.clearInterval(id);
  }, [autosaveEnabled, autosaveIntervalMin]);

  // Same ref pattern for the close handler below, which is registered once
  // on mount — re-subscribing a Tauri window event on every edit would mean
  // an async IPC round-trip per keystroke, plus a gap where nothing is
  // listening between unregister and re-register.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const saveMapRef = useRef(saveMap);
  useEffect(() => {
    saveMapRef.current = saveMap;
  }, [saveMap]);
  // Synchronous re-entrancy guard — set the instant the handler starts,
  // before any await. Whether the double dialog comes from two registered
  // listeners or the OS/webview delivering close-requested twice for one
  // click, JS still runs each handler invocation to completion (or to its
  // first await) before starting the next, so whichever invocation runs
  // second sees this already true and bails before showing its own
  // dialog — unlike the earlier `cancelled` registration-race guard below,
  // this doesn't depend on which of those causes is the real one.
  const closingRef = useRef(false);

  // preventDefault() fires immediately and unconditionally now, rather
  // than only when staying open (see the previous version's comment,
  // still true as a design point, just not sufficient on its own): the
  // close didn't resume on its own even with nothing to save, so this
  // doesn't lean on Tauri resuming it. The dialog/save and the destroy()
  // call are now in SEPARATE try/catch blocks: destroy() is the one new
  // API call here that's never been exercised before, so if it's the one
  // rejecting (most likely a missing core:window:allow-destroy /
  // core:window:allow-close permission in
  // src-tauri/capabilities/default.json — Tauri v2 doesn't grant those by
  // default), that failure is now caught, logged with that hint, and
  // doesn't get silently swallowed the way a shared finally would.
  // closingRef resets on that failure so a later close attempt isn't
  // permanently blocked by this one having failed.
  //
  // cancelled guards a real but separate race: onCloseRequested's
  // registration is itself async, and if this effect's cleanup runs
  // before that registration resolves (e.g. React StrictMode's dev-only
  // mount→cleanup→mount), `unlisten` is still undefined when cleanup
  // fires, so the first listener never gets removed. Recording that
  // cleanup already happened, and unlistening immediately once the late
  // registration does resolve, closes that gap too.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closingRef.current) return;
        closingRef.current = true;
        try {
          if (dirtyRef.current) {
            const shouldSave = await ask("You have unsaved changes. Save before closing?", {
              title: "Unsaved changes",
              kind: "warning",
            });
            if (shouldSave) await saveMapRef.current(false);
          }
        } catch (err) {
          console.error("close-prompt step failed, closing anyway:", err);
        }
        try {
          await getCurrentWindow().destroy();
        } catch (err) {
          console.error(
            "getCurrentWindow().destroy() was rejected — most likely missing core:window:allow-destroy " +
              "(and/or core:window:allow-close) in src-tauri/capabilities/default.json:",
            err
          );
          closingRef.current = false;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);


  const openMap = useCallback(async () => {
    const picked = await openDialog({ filters: [{ name: "Mind Map", extensions: ["canvas"] }] });
    if (!picked || Array.isArray(picked)) return; // cancelled or somehow multi-select
    await loadFileByPath(picked);
  }, [loadFileByPath]);

  const importMap = useCallback(async () => {
    const picked = await openDialog({ filters: [{ name: "SimpleMind Map", extensions: ["smmx"] }] });
    if (!picked || Array.isArray(picked)) return;
    const bytes = await readFile(picked); // binary — .smmx is a zip, not text
    const { nodes: loadedNodes, edges: loadedEdges } = await importSmmx(bytes.buffer, onTextChange);
    setNodes(loadedNodes);
    setEdges(loadedEdges);
    // different source format — don't let Ctrl+S silently overwrite the
    // original .smmx with our .canvas JSON, prompt for a real save location
    setFilePath(null);
    resetHistory(loadedNodes, loadedEdges);
    const maxId = Math.max(0, ...loadedNodes.map((n) => Number(n.id)).filter((n) => !Number.isNaN(n)));
    if (maxId >= nextId) nextId = maxId + 1;
  }, [onTextChange, setEdges, resetHistory]);

  const copyBranch = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;

    // single card: copy it + everything under it. 2+ cards: copy exactly
    // the selection, no auto-expansion — matches what was asked for.
    const idsToCopy =
      selected.length === 1
        ? new Set([selected[0].id, ...getDescendantIds(selected[0].id, childrenOf)])
        : new Set(selected.map((n) => n.id));

    // anchor for relative positions, and the node a paste-as-child
    // reconnects to — first selected node, arbitrarily but deterministically
    const root = selected[0];

    setClipboard({
      nodes: nodes
        .filter((n) => idsToCopy.has(n.id))
        .map((n) => ({
          id: n.id,
          text: n.data.text,
          color: n.data.color,
          colorManual: n.data.colorManual,
          shape: n.data.shape,
          bold: n.data.bold,
          italic: n.data.italic,
          underline: n.data.underline,
          strikethrough: n.data.strikethrough,
          fontSize: n.data.fontSize,
          textAlign: n.data.textAlign,
          dx: n.position.x - root.position.x,
          dy: n.position.y - root.position.y,
        })),
      edges: edges
        .filter((e) => idsToCopy.has(e.source) && idsToCopy.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, data: e.data as FloatingEdgeData | undefined })),
      rootId: root.id,
    });
  }, [nodes, edges, childrenOf]);

  const pasteBranch = useCallback(() => {
    if (!clipboard) return;
    const selected = nodes.filter((n) => n.selected);
    if (selected.length >= 2) return; // ambiguous which card to attach to — no-op

    const target = selected.length === 1 ? selected[0] : null;
    const anchor = target
      ? { x: target.position.x + 160, y: target.position.y + 120 }
      : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

    const idMap = new Map<string, string>();
    const newNodes: Node<MindmapNodeData>[] = clipboard.nodes.map((n) => {
      const newId = String(nextId++);
      idMap.set(n.id, newId);
      return {
        id: newId,
        type: "mindmap",
        position: { x: anchor.x + n.dx, y: anchor.y + n.dy },
        data: {
          text: n.text,
          color: n.color,
          colorManual: n.colorManual,
          shape: n.shape,
          bold: n.bold,
          italic: n.italic,
          underline: n.underline,
          strikethrough: n.strikethrough,
          fontSize: n.fontSize,
          textAlign: n.textAlign,
          onTextChange,
        },
        selected: false,
      };
    });

    const newEdges: Edge[] = clipboard.edges.map((e) => ({
      id: `e${idMap.get(e.source)}-${idMap.get(e.target)}`,
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      type: "floating",
      data: e.data,
    }));

    if (target) {
      const newRootId = idMap.get(clipboard.rootId)!;
      newEdges.push({ id: `e${target.id}-${newRootId}`, source: target.id, target: newRootId, type: "floating" });
    }

    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...newNodes]);
    setEdges((eds) => [...eds, ...newEdges]);
  }, [clipboard, nodes, onTextChange, setEdges, screenToFlowPosition]);

  const selectAll = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
  }, []);

  const requestEditSelected = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length !== 1) return; // ambiguous otherwise, same rule as pasteBranch
    const id = selected[0].id;
    setNodes((nds) =>
      nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, editRequest: (n.data.editRequest ?? 0) + 1 } } : n))
    );
  }, [nodes]);

  const moveSelectedNodes = useCallback((dx: number, dy: number) => {
    setNodes((nds) =>
      nds.map((n) => (n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n))
    );
  }, []);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const vp = getViewport();
      setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 0 });
    },
    [getViewport, setViewport]
  );

  // Anchor = single selected card's center, else viewport center. Score
  // favors small distance-in-direction + penalizes perpendicular drift —
  // simple heuristic, tune PERP weight if it picks weird cards.
  const navigateSelection = useCallback(
    (dir: { x: number; y: number }, extreme: boolean) => {
      const selected = nodes.filter((n) => n.selected);
      const anchor =
        selected.length === 1
          ? nodeCenter(selected[0])
          : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const excludeId = selected.length === 1 ? selected[0].id : null;

      let best: Node<MindmapNodeData> | null = null;
      let bestScore = Infinity;
      let bestPrimary = -Infinity;

      for (const n of nodes) {
        if (n.id === excludeId) continue;
        const c = nodeCenter(n);
        const dx = c.x - anchor.x;
        const dy = c.y - anchor.y;
        const primary = dx * dir.x + dy * dir.y;
        const perp = dx * dir.y - dy * dir.x;
        if (primary <= 1) continue; // must actually lie in that direction

        if (extreme) {
          if (primary > bestPrimary) {
            bestPrimary = primary;
            best = n;
          }
        } else {
          const score = primary + Math.abs(perp) * 2;
          if (score < bestScore) {
            bestScore = score;
            best = n;
          }
        }
      }

      if (best) {
        const id = best.id;
        setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
      }
    },
    [nodes, screenToFlowPosition]
  );

  const createCardAtCenter = useCallback(
    (forceUnlinked: boolean) => {
      const pos = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const selected = nodes.filter((n) => n.selected);
      const linkTo = !forceUnlinked && selected.length === 1 ? selected[0] : null;
      const id = String(nextId++);
      pendingCenterRef.current.set(id, pos);
      const newNode: Node<MindmapNodeData> = {
        id,
        type: "mindmap",
        position: pos,
        data: { text: "New idea", color: linkTo ? linkTo.data.color : null, shape: defaultShape, ...defaultTextStyle, autoEdit: true, onTextChange },
        selected: true,
      };
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);
      if (linkTo) {
        setEdges((eds) => [
          ...eds,
          { id: `e${linkTo.id}-${id}`, source: linkTo.id, target: id, type: "floating", data: { pathStyle: defaultPathStyle, arrow: defaultArrow } },
        ]);
      }
    },
    [nodes, screenToFlowPosition, onTextChange, setEdges, defaultShape, defaultPathStyle, defaultArrow, defaultTextStyle]
  );

  const centerMap = useCallback(() => {
    if (nodes.length === 0) return;
    const cx = nodes.reduce((sum, n) => sum + n.position.x + (n.measured?.width ?? 0) / 2, 0) / nodes.length;
    const cy = nodes.reduce((sum, n) => sum + n.position.y + (n.measured?.height ?? 0) / 2, 0) / nodes.length;
    setCenter(cx, cy, { zoom: getViewport().zoom, duration: 300 });
  }, [nodes, setCenter, getViewport]);

  const fitToView = useCallback(() => {
    fitView({ duration: 300 });
  }, [fitView]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    if (commitTimer.current) window.clearTimeout(commitTimer.current); // a pending commit must not fire after this
    const prev = history[history.length - 1];
    setRedoStack((r) => [...r, lastCommitted.current]);
    setHistory((h) => h.slice(0, -1));
    skipNextCommit.current = true;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    lastCommitted.current = prev;
  }, [history, setEdges]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    const next = redoStack[redoStack.length - 1];
    setHistory((h) => [...h, lastCommitted.current]);
    setRedoStack((r) => r.slice(0, -1));
    skipNextCommit.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    lastCommitted.current = next;
  }, [redoStack, setEdges]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery("");
          setReplaceQuery("");
          return;
        }
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT" || active?.tagName === "SELECT") return;
        setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
        setEdges((eds) => eds.map((ed) => (ed.selected ? { ...ed, selected: false } : ed)));
        return;
      }
      if (!import.meta.env.DEV && (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"))) {
        e.preventDefault();
        return;
      }
      if (e.key === "Home") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT") return; // native cursor-to-start instead
        e.preventDefault();
        centerMap();
        return;
      }
      if (e.key === "F2") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT") return;
        e.preventDefault();
        requestEditSelected();
        return;
      }
      if (e.key in DIR_VECTORS) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT") return;
        const dir = DIR_VECTORS[e.key];
        e.preventDefault();
        if (e.altKey) {
          navigateSelection(dir, e.shiftKey);
        } else if (e.ctrlKey || e.metaKey) {
          const step = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP_SMALL;
          panBy(-dir.x * step, -dir.y * step);
        } else if (nodes.some((n) => n.selected)) {
          const step = e.shiftKey ? NODE_NUDGE_LARGE : NODE_NUDGE_SMALL;
          moveSelectedNodes(dir.x * step, dir.y * step);
        } else {
          const step = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP_SMALL;
          panBy(-dir.x * step, -dir.y * step);
        }
        return;
      }
      if (e.key === "Enter") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT") return;
        e.preventDefault();
        createCardAtCenter(e.shiftKey);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        saveMap(e.shiftKey); // Ctrl+Shift+S forces the save-as picker
      } else if (key === "o") {
        e.preventDefault();
        openMap();
      } else if (key === "i") {
        e.preventDefault();
        importMap();
      } else if (key === "n") {
        e.preventDefault();
        newMap();
      } else if (key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (key === "f") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (key === "c" || key === "v") {
        const active = document.activeElement as HTMLElement | null;
        // a card being edited, or the search box, handles its own native
        // text copy/paste — don't steal the keystroke from an in-progress edit
        if (active?.isContentEditable || active?.tagName === "INPUT") return;
        e.preventDefault();
        if (key === "c") copyBranch();
        else pasteBranch();
      } else if (key === "a") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT") return; // native select-all-text instead
        e.preventDefault();
        selectAll();
      } else if (key === "z" || key === "y") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable || active?.tagName === "INPUT") return; // native in-field undo instead
        e.preventDefault();
        if (key === "y" || (key === "z" && e.shiftKey)) redo();
        else undo();
      } else if (key === "0") {
        e.preventDefault();
        fitToView();
      } else if (key === "=" || key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (key === "-" || key === "_") {
        e.preventDefault();
        zoomOut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    saveMap,
    openMap,
    importMap,
    newMap,
    searchOpen,
    copyBranch,
    pasteBranch,
    selectAll,
    undo,
    redo,
    centerMap,
    fitToView,
    zoomIn,
    zoomOut,
    requestEditSelected,
    createCardAtCenter,
    navigateSelection,
    moveSelectedNodes,
    panBy,
  ]);

  // Highlighting is computed for display only — never written into the
  // real `nodes` state, so it's never saved and never fights with
  // onNodesChange's delta-based updates.
  const displayNodes = useMemo(() => {
    if (!searchQuery.trim()) return nodes;
    const q = searchQuery.toLowerCase();
    return nodes.map((n) => ({
      ...n,
      data: { ...n.data, highlighted: n.data.text.toLowerCase().includes(q) },
    }));
  }, [nodes, searchQuery]);

  const displayEdges = useMemo(
    () => edges.map((e) => ({ ...e, reconnectable: e.selected ? ("source" as const) : false })),
    [edges]
  );

  const onNodesChange = useCallback((changes: NodeChange<Node<MindmapNodeData>>[]) => {
    const selectChanges = changes.filter((c) => c.type === "select");
    if (selectChanges.length && import.meta.env.DEV) {
      console.log("select changes:", selectChanges);
    }

    const deselects = changes.filter((c) => c.type === "select" && c.selected === false);
    const rest = changes.filter((c) => !(c.type === "select" && c.selected === false));

    if (rest.length) {
      setNodes((nds) => {
        let next = applyNodeChanges<Node<MindmapNodeData>>(rest, nds);
        for (const c of rest) {
          if (c.type === "dimensions" && c.dimensions && pendingCenterRef.current.has(c.id)) {
            const center = pendingCenterRef.current.get(c.id)!;
            pendingCenterRef.current.delete(c.id);
            const { width, height } = c.dimensions;
            next = next.map((n) =>
              n.id === c.id ? { ...n, position: { x: center.x - width / 2, y: center.y - height / 2 } } : n
            );
          }
        }
        return next;
      });
    }

    if (deselects.length) {
      if (deselectTimer.current) window.clearTimeout(deselectTimer.current);
      deselectTimer.current = window.setTimeout(() => {
        setNodes((nds) => applyNodeChanges<Node<MindmapNodeData>>(deselects, nds));
        deselectTimer.current = null;
      }, PANE_DESELECT_DELAY_MS);
    }
  }, []);

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return; // hit a node, not empty canvas

      if (deselectTimer.current) {
        window.clearTimeout(deselectTimer.current);
        deselectTimer.current = null;
      }

      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const selected = nodes.find((n) => n.selected);
      const id = String(nextId++);
      pendingCenterRef.current.set(id, pos); // <-- add
      const newNode: Node<MindmapNodeData> = {
        id,
        type: "mindmap",
        position: pos,
        data: { text: "New idea", color: selected ? selected.data.color : null, shape: defaultShape, ...defaultTextStyle, autoEdit: true, onTextChange },
        selected: true,
      };

      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);
      if (selected) {
        setEdges((eds) => [
          ...eds,
          {
            id: `e${selected.id}-${id}`,
            source: selected.id,
            target: id,
            type: "floating",
            data: { pathStyle: defaultPathStyle, arrow: defaultArrow },
          },
        ]);
      }
    },
    [nodes, screenToFlowPosition, onTextChange, setEdges, defaultShape, defaultPathStyle, defaultArrow, defaultTextStyle]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return; // no self-loops
      setEdges((eds) => {
        const exists = eds.some(
          (e) =>
            (e.source === connection.source && e.target === connection.target) ||
            (e.source === connection.target && e.target === connection.source)
        );
        if (exists) return eds;
        return [
          ...eds,
          {
            id: `e${connection.source}-${connection.target}`,
            source: connection.source!,
            target: connection.target!,
            type: "floating",
            data: { pathStyle: defaultPathStyle, arrow: defaultArrow },
          },
        ];
      });
    },
    [setEdges, defaultPathStyle, defaultArrow]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;
      return !edges.some(
        (e) =>
          e.id !== (connection as Edge).id &&
          ((e.source === connection.source && e.target === connection.target) ||
            (e.source === connection.target && e.target === connection.source))
      );
    },
    [edges]
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
    },
    [setEdges]
  );

  // Source-end only, matching SimpleMind (confirmed by the user checking
  // the real app: you reassign a card's parent, not pick a different
  // child — no tree-rearrangement questions to deal with as a result).
  // Same self-loop/duplicate guards as onConnect, applied to the new
  // source instead of a brand-new connection.
  // const reconnectSourceTo = useCallback(
  //   (edgeId: string, newSourceId: string) => {
  //     setEdges((eds) => {
  //       const edge = eds.find((e) => e.id === edgeId);
  //       if (!edge) return eds;
  //       if (newSourceId === edge.target) return eds; // no self-loop
  //       const duplicate = eds.some(
  //         (e) =>
  //           e.id !== edgeId &&
  //           ((e.source === newSourceId && e.target === edge.target) ||
  //             (e.source === edge.target && e.target === newSourceId))
  //       );
  //       if (duplicate) return eds;
  //       return eds.map((e) =>
  //         e.id === edgeId ? { ...e, source: newSourceId, id: `e${newSourceId}-${edge.target}` } : e
  //       );
  //     });
  //   },
  //   [setEdges]
  // );

  const onMouseDownCapture = useCallback(
    (event: React.MouseEvent) => {
      // const reconnectEl = (event.target as Element).closest("[data-reconnect-edge]");
      // if (reconnectEl) {
      //   const edgeId = reconnectEl.getAttribute("data-reconnect-edge");
      //   if (edgeId) {
      //     event.stopPropagation();
      //     const fromPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      //     setReconnecting({ edgeId, fromPoint });
      //     setReconnectDragPos(fromPoint);
      //   }
      //   return;
      // }

      cancelHold(); // always clear any stale pending timer first
      if ((event.target as Element).closest(".react-flow__handle")) return; // starting a connection drag, not a hold-select
      const nodeEl = (event.target as Element).closest(".react-flow__node");
      if (!nodeEl) return;
      const id = nodeEl.getAttribute("data-id");
      if (!id) return;

      const expand = () => {
        const descendants = getDescendantIds(id, childrenOf);
        setNodes((nds) =>
          nds.map((n) => (n.id === id || descendants.has(n.id) ? { ...n, selected: true } : n))
        );
      };

      if (event.shiftKey) {
        expand(); // SimpleMind: shift+drag moves the branch too, no hold needed
        return;
      }

      holdTimer.current = window.setTimeout(expand, HOLD_MS);
    },
    [childrenOf, cancelHold]
  );

  // Resolves the drag started above: on release, whatever node is under
  // the cursor (via elementFromPoint — same .react-flow__node + data-id
  // pattern used everywhere else in this file) becomes the edge's new
  // source. Releasing over empty space or the edge's own current nodes is
  // simply a no-op, not an error state.
  // useEffect(() => {
  //   if (!reconnecting) return;
  //   document.body.style.cursor = "grabbing";
  //   const onUp = (e: MouseEvent) => {
  //     const el = document.elementFromPoint(e.clientX, e.clientY);
  //     const nodeEl = el?.closest(".react-flow__node");
  //     const newSourceId = nodeEl?.getAttribute("data-id");
  //     if (newSourceId) reconnectSourceTo(reconnecting.edgeId, newSourceId);
  //     setReconnecting(null);
  //   };
  //   window.addEventListener("mouseup", onUp);
  //   return () => {
  //     document.body.style.cursor = "";
  //     window.removeEventListener("mouseup", onUp);
  //   };
  // }, [reconnecting, reconnectSourceTo]);

  // Each currently-selected node is its own cascade root. A cascade walks
  // down through children, applying the new color, but stops (does not
  // touch that node or anything below it) at any descendant that already
  // has colorManual=true — that's a deliberate earlier color choice, not
  // something an ancestor edit should overwrite. Only the directly-picked
  // nodes themselves become colorManual=true; nodes that just went along
  // for the cascade stay eligible for the next one. Passing color=null is
  // "clear" — resets colorManual back to false too, not just the color.
  //
  // Same swatch row does double duty: colors selected nodes, colors
  // selected edges, or both if somehow both are selected at once — one
  // color picker in the toolbar instead of duplicating it per target type.
  const applyColor = useCallback(
    (color: string | null) => {
      const nodeTargets = nodes.filter((n) => n.selected).map((n) => n.id);
      const nodeTargetSet = new Set(nodeTargets);
      const anyEdgeSelected = edges.some((e) => e.selected);

      if (nodeTargets.length > 0) {
        setNodes((nds) => {
          const byId = new Map(nds.map((n) => [n.id, n]));
          const toUpdate = new Set<string>(nodeTargets);

          const cascade = (id: string) => {
            for (const childId of childrenOf.get(id) ?? []) {
              if (toUpdate.has(childId)) continue;
              const child = byId.get(childId);
              if (!child || child.data.colorManual) continue; // stop here
              toUpdate.add(childId);
              cascade(childId);
            }
          };
          nodeTargets.forEach(cascade);

          return nds.map((n) =>
            toUpdate.has(n.id)
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    color,
                    colorManual: nodeTargetSet.has(n.id) ? color !== null : n.data.colorManual,
                  },
                }
              : n
          );
        });
      }

      if (anyEdgeSelected) {
        setEdges((eds) =>
          eds.map((e) => (e.selected ? { ...e, data: { ...(e.data as FloatingEdgeData), color } } : e))
        );
      }
    },
    [nodes, edges, childrenOf, setEdges]
  );

  // Right-click a swatch: select every node currently at that exact color
  // instead of applying it — flat filter, no cascade, regardless of
  // manual/inherited status or hierarchy.
  const selectByColor = useCallback((color: string | null) => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.data.color === color })));
  }, []);

  const selectSearchMatches = useCallback(() => {
    if (!searchQuery.trim()) return;
    const q = searchQuery.toLowerCase();
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.data.text.toLowerCase().includes(q) })));
  }, [searchQuery]);

  const applyLineStyle = useCallback(
    (lineStyle: FloatingEdgeData["lineStyle"]) => {
      setEdges((eds) =>
        eds.map((e) => (e.selected ? { ...e, data: { ...(e.data as FloatingEdgeData), lineStyle } } : e))
      );
    },
    [setEdges]
  );

  const applyLineWidth = useCallback(
    (lineWidth: number) => {
      setEdges((eds) =>
        eds.map((e) => (e.selected ? { ...e, data: { ...(e.data as FloatingEdgeData), lineWidth } } : e))
      );
    },
    [setEdges]
  );

  const applyShape = useCallback((shape: MindmapShape) => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, data: { ...n.data, shape } } : n)));
  }, []);

  const applyPathStyle = useCallback(
    (pathStyle: FloatingEdgeData["pathStyle"]) => {
      setEdges((eds) =>
        eds.map((e) => (e.selected ? { ...e, data: { ...(e.data as FloatingEdgeData), pathStyle } } : e))
      );
    },
    [setEdges]
  );

  const applyArrow = useCallback(
    (arrow: FloatingEdgeData["arrow"]) => {
      setEdges((eds) =>
        eds.map((e) => (e.selected ? { ...e, data: { ...(e.data as FloatingEdgeData), arrow } } : e))
      );
    },
    [setEdges]
  );

  // Whole-card toggle, not inline/per-segment — matches SimpleMind's actual
  // behavior (confirmed, not assumed). Mixed-selection rule matches most
  // editors: if every selected card already has the flag on, turn it off
  // for all; otherwise turn it on for all.
  const toggleTextStyle = useCallback(
    (key: "bold" | "italic" | "underline" | "strikethrough") => {
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;
      const allOn = selected.every((n) => n.data[key]);
      const next = !allOn;
      setNodes((nds) => nds.map((n) => (n.selected ? { ...n, data: { ...n.data, [key]: next } } : n)));
    },
    [nodes]
  );

  const applyFontSize = useCallback((fontSize: number) => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, data: { ...n.data, fontSize } } : n)));
  }, []);

  const applyTextAlign = useCallback((textAlign: MindmapNodeData["textAlign"]) => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, data: { ...n.data, textAlign } } : n)));
  }, []);

  // Replace Next: resumes from replaceCursor rather than re-scanning each
  // card from position 0 — a plain from-the-start scan gets stuck forever
  // when the replacement text contains the search term (e.g. "idea" ->
  // "ideas": the freshly-written "ideas" still contains "idea", so the old
  // from-scratch version kept re-matching its own output on the same
  // card). Checks each node exactly once per click, starting at the
  // cursor and wrapping around, so it also correctly cycles back to the
  // start once it's swept the whole map.
  const replaceNext = useCallback(() => {
    if (!searchQuery || nodes.length === 0) return;
    const q = searchQuery.toLowerCase();
    const n = nodes.length;

    for (let step = 0; step < n; step++) {
      const i = (replaceCursor.nodeIndex + step) % n;
      const startFrom = step === 0 ? replaceCursor.charOffset : 0;
      const node = nodes[i];
      const idx = node.data.text.toLowerCase().indexOf(q, startFrom);
      if (idx === -1) continue;
      const newText = node.data.text.slice(0, idx) + replaceQuery + node.data.text.slice(idx + searchQuery.length);
      onTextChange(node.id, newText);
      setReplaceCursor({ nodeIndex: i, charOffset: idx + replaceQuery.length });
      return;
    }
  }, [nodes, searchQuery, replaceQuery, onTextChange, replaceCursor]);

  // Replace All: every occurrence, every node, in one pass. Escaping the
  // query before building the RegExp — this is meant to be an exact
  // substring match, not a regex search, so a literal "." or "(" in the
  // search box must match itself, not act as a regex metacharacter.
  const replaceAll = useCallback(() => {
    if (!searchQuery) return;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "gi");
    setNodes((nds) =>
      nds.map((n) => ({ ...n, data: { ...n.data, text: n.data.text.replace(pattern, replaceQuery) } }))
    );
  }, [searchQuery, replaceQuery]);

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      <div
        style={{
          minHeight: 20,
          background: "#1a1a1a",
          borderBottom: "1px solid #333",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
        }}
      >
        <span style={{ color: "#888", fontSize: 12 }}>Color</span>
        {PALETTE.map((hex) => (
          <button
            key={hex}
            onClick={() => applyColor(hex)}
            onContextMenu={(e) => {
              e.preventDefault();
              selectByColor(hex);
            }}
            title={`${hex} — left: apply, right: select all this color`}
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              background: hex,
              border: "1px solid #555",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
        <input
          type="color"
          onChange={(e) => applyColor(e.target.value)}
          title="Custom color"
          style={{
            width: 24,
            height: 24,
            padding: 0,
            border: "1px solid #555",
            borderRadius: 4,
            background: "none",
            cursor: "pointer",
          }}
        />
        <button
          onClick={() => applyColor(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            selectByColor(null);
          }}
          title="Left: clear, right: select all default-colored"
          style={sidebarButtonStyle}
        >
          Clear
        </button>

        <div style={{ width: 1, height: 24, background: "#333", margin: "0 4px" }} />

        <span style={{ color: "#888", fontSize: 12 }}>Shape</span>
        {(
          [
            ["rectangle", "Rect"],
            ["ellipse", "Oval"],
            ["circle", "Circle"],
            ["diamond", "Diamond"],
          ] as const
        ).map(([shape, label]) => (
          <button
            key={shape}
            onClick={() => applyShape(shape)}
            onContextMenu={(e) => {
              e.preventDefault();
              setDefaultShape(shape);
            }}
            title={`Left: apply to selection, right: set as default for new cards${defaultShape === shape ? " (current default)" : ""}`}
            style={{ ...sidebarButtonStyle, outline: defaultShape === shape ? "1px solid #888" : "none" }}
          >
            {label}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "#333", margin: "0 4px" }} />

        <span style={{ color: "#888", fontSize: 12 }}>Line</span>
        <button onClick={() => applyLineStyle("solid")} style={sidebarButtonStyle}>
          Solid
        </button>
        <button onClick={() => applyLineStyle("dashed")} style={sidebarButtonStyle}>
          Dashed
        </button>
        <button onClick={() => applyLineStyle("dotted")} style={sidebarButtonStyle}>
          Dotted
        </button>
        <select
          defaultValue=""
          onChange={(e) => {
            applyLineWidth(Number(e.target.value));
            e.target.value = "";
          }}
          style={sidebarSelectStyle}
        >
          <option value="" disabled>
            Width
          </option>
          {LINE_WIDTHS.map((w) => (
            <option key={w} value={w}>
              {w}px
            </option>
          ))}
        </select>

        <div style={{ width: 1, height: 24, background: "#333", margin: "0 4px" }} />

        <span style={{ color: "#888", fontSize: 12 }}>Path</span>
        {(
          [
            ["straight", "Straight"],
            ["curved", "Curved"],
            ["angled", "Angled"],
            ["rounded", "Rounded"],
          ] as const
        ).map(([pathStyle, label]) => (
          <button
            key={pathStyle}
            onClick={() => applyPathStyle(pathStyle)}
            onContextMenu={(e) => {
              e.preventDefault();
              setDefaultPathStyle(pathStyle);
            }}
            title={`Left: apply to selected lines, right: set as default for new lines${defaultPathStyle === pathStyle ? " (current default)" : ""}`}
            style={{ ...sidebarButtonStyle, outline: defaultPathStyle === pathStyle ? "1px solid #888" : "none" }}
          >
            {label}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "#333", margin: "0 4px" }} />

        <span style={{ color: "#888", fontSize: 12 }}>Arrow</span>
        {(
          [
            ["none", "None"],
            ["incoming", "In"],
            ["outgoing", "Out"],
            ["both", "Both"],
          ] as const
        ).map(([arrow, label]) => (
          <button
            key={arrow}
            onClick={() => applyArrow(arrow)}
            onContextMenu={(e) => {
              e.preventDefault();
              setDefaultArrow(arrow);
            }}
            title={`Left: apply to selected lines, right: set as default for new lines${defaultArrow === arrow ? " (current default)" : ""}`}
            style={{ ...sidebarButtonStyle, outline: defaultArrow === arrow ? "1px solid #888" : "none" }}
          >
            {label}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "#333", margin: "0 4px" }} />

        <span style={{ color: "#888", fontSize: 12 }}>Text</span>
        {(
          [
            ["bold", "B", { fontWeight: "bold" }],
            ["italic", "I", { fontStyle: "italic" }],
            ["underline", "U", { textDecoration: "underline" }],
            ["strikethrough", "S", { textDecoration: "line-through" }],
          ] as const
        ).map(([key, label, extra]) => (
          <button
            key={key}
            onClick={() => toggleTextStyle(key)}
            onContextMenu={(e) => {
              e.preventDefault();
              toggleDefaultTextFlag(key);
            }}
            title={`Left: toggle on selection, right: toggle as default for new cards${defaultTextStyle[key] ? " (current default)" : ""}`}
            style={{ ...sidebarButtonStyle, ...extra, outline: defaultTextStyle[key] ? "1px solid #888" : "none" }}
          >
            {label}
          </button>
        ))}
        <select
          defaultValue=""
          onChange={(e) => {
            applyFontSize(Number(e.target.value));
            e.target.value = "";
          }}
          style={sidebarSelectStyle}
        >
          <option value="" disabled>
            Size
          </option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={defaultTextStyle.fontSize ?? ""}
          onChange={(e) =>
            setDefaultTextStyle((d) => ({ ...d, fontSize: e.target.value ? Number(e.target.value) : undefined }))
          }
          title="Default font size for new cards"
          style={sidebarSelectStyle}
        >
          <option value="">New: 14</option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              New: {s}
            </option>
          ))}
        </select>

        {(["left", "center", "right"] as const).map((a) => (
          <button
            key={a}
            onClick={() => applyTextAlign(a)}
            onContextMenu={(e) => {
              e.preventDefault();
              setDefaultTextStyle((d) => ({ ...d, textAlign: d.textAlign === a ? undefined : a }));
            }}
            title="Left: apply to selection, right: set/clear as default for new cards"
            style={{ ...sidebarButtonStyle, outline: defaultTextStyle.textAlign === a ? "1px solid #888" : "none" }}
          >
            {a[0].toUpperCase() + a.slice(1)}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "#333", margin: "0 4px" }} />

        <span style={{ color: "#888", fontSize: 12 }}>View</span>
        <button onClick={centerMap} title="Home" style={sidebarButtonStyle}>
          Center
        </button>
        <button onClick={fitToView} title="Ctrl+0" style={sidebarButtonStyle}>
          Fit
        </button>
        <button onClick={() => zoomIn()} title="Ctrl+=" style={sidebarButtonStyle}>
          Zoom In
        </button>
        <button onClick={() => zoomOut()} title="Ctrl+-" style={sidebarButtonStyle}>
          Zoom Out
        </button>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: sidebarOpen ? 220 : 0,
            minWidth: sidebarOpen ? 220 : 0,
            overflow: "hidden",
            transition: "width 0.2s ease, min-width 0.2s ease",
            height: "100%",
            background: "#191919",
            borderRight: sidebarOpen ? "1px solid #333" : "none",
            display: "flex",
            flexDirection: "column",
            color: "#ddd",
            fontSize: 13,
          }}
        >
          <div
            style={{
              width: 220,
              padding: 10,
              borderBottom: "1px solid #333",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            <button onClick={newMap} style={sidebarButtonStyle}>
              New
            </button>
            <button onClick={chooseFolder} style={sidebarButtonStyle}>
              Open Folder
            </button>
            <button onClick={() => saveMap(false)} title="Ctrl+S" style={sidebarButtonStyle}>
              Save{dirty ? " \u2022" : ""}
            </button>
            <button onClick={() => saveMap(true)} title="Ctrl+Shift+S" style={sidebarButtonStyle}>
              Save As
            </button>
          </div>
          <div
            style={{
              width: 220,
              padding: "6px 10px",
              borderBottom: "1px solid #333",
              display: "flex",
              alignItems: "center",
              gap: 6,
              boxSizing: "border-box",
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={autosaveEnabled}
                onChange={(e) => setAutosaveEnabled(e.target.checked)}
              />
              Autosave
            </label>
            {autosaveEnabled && (
              <select
                value={autosaveIntervalMin}
                onChange={(e) => setAutosaveIntervalMin(Number(e.target.value))}
                title="Autosave interval — also saves whenever the window loses focus"
                style={sidebarSelectStyle}
              >
                {[1, 2, 5, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            )}
          </div>
          <div
            title={folderPath ?? undefined}
            style={{
              width: 220,
              padding: "6px 10px",
              color: "#888",
              fontSize: 11,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              boxSizing: "border-box",
            }}
          >
            {folderPath ?? "No folder selected"}
          </div>
          <div style={{ width: 220, flex: 1, overflowY: "auto" }}>
            {folderFiles.map((f) => (
              <div
                key={f.path}
                onClick={() => loadFileByPath(f.path)}
                style={{
                  padding: "6px 10px",
                  cursor: "pointer",
                  background: f.path === filePath ? "#2a2a2a" : "transparent",
                  borderLeft: f.path === filePath ? "2px solid #888" : "2px solid transparent",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {f.name}
              </div>
            ))}
          </div>
        </div>
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          title="Toggle sidebar (Ctrl+B)"
          style={{
            ...sidebarButtonStyle,
            alignSelf: "flex-start",
            marginTop: 10,
            marginLeft: 4,
            padding: "4px 6px",
          }}
        >
          {sidebarOpen ? "\u2039" : "\u203A"}
        </button>
      <div
        ref={wrapperRef}
        onDoubleClick={handleDoubleClick}
        onMouseDownCapture={onMouseDownCapture}
        style={{ flex: 1, height: "100%", background: "#141414", position: "relative" }}
      >
        <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        panOnDrag={!ctrlHeld}
        selectionOnDrag={ctrlHeld}
        multiSelectionKeyCode="Control"
        selectionKeyCode={null}
        deleteKeyCode={["Backspace", "Delete"]}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{ stroke: "#888", strokeWidth: 2 }}
        onConnect={onConnect}
        minZoom={0.03}
        zoomOnDoubleClick={false}
        onNodeClick={cancelHold}
        onNodeDragStart={cancelHold}
        onNodeDragStop={cancelHold}
        onReconnect={onReconnect}
        isValidConnection={isValidConnection}
        colorMode="dark"
        fitView
        disableKeyboardA11y
      >
        <Background variant={BackgroundVariant.Dots} gap={20} color="#333" />
      </ReactFlow>
      {searchOpen && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            background: "#1e1e1e",
            border: "1px solid #444",
            borderRadius: 8,
            padding: "6px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#888", fontSize: 11, width: 52 }}>Search</span>
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                // keep this from ever reaching the global Ctrl+S/O/I/F or
                // React Flow's delete-key handling while typing a query
                e.stopPropagation();
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setSearchQuery("");
                  setReplaceQuery("");
                }
              }}
              placeholder="Search cards…"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#eee",
                fontSize: 14,
                width: 220,
              }}
            />
            <span style={{ color: "#888", fontSize: 12 }}>
              {searchQuery.trim()
                ? `${displayNodes.filter((n) => n.data.highlighted).length} match${displayNodes.filter((n) => n.data.highlighted).length === 1 ? "" : "es"}`
                : "Esc to close"}
            </span>
            {searchQuery.trim() && (
              <button onClick={selectSearchMatches} style={sidebarButtonStyle}>
                Select matches
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#888", fontSize: 11, width: 52 }}>Replace</span>
            <input
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setSearchQuery("");
                  setReplaceQuery("");
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  replaceAll();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  replaceNext();
                }
              }}
              placeholder="Replace with…"
              title="Enter: replace next — Ctrl+Enter: replace all"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#eee",
                fontSize: 14,
                width: 220,
              }}
            />
            <button onClick={replaceNext} style={sidebarButtonStyle} title="Enter">
              Replace next
            </button>
            <button onClick={replaceAll} style={sidebarButtonStyle} title="Ctrl+Enter">
              Replace all
            </button>
          </div>
        </div>
      )}
    </div>
    </div>
    </div>
  );
}