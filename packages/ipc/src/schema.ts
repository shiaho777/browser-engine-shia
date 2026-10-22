/**
 * IPC protocol schema (RFC 0004) — the declarative source of truth for the
 * browser-process ↔ web-content wire format.
 *
 * Everything below is **data**: the emitter (`emit.ts`) renders
 * `src/generated/protocol.ts` from it, and `drift.test.ts` pins the committed
 * file byte-for-byte against re-emission. To change the wire format, edit the
 * tables here and re-run `npm run generate --workspace @browser-engine/ipc`.
 *
 * Field type DSL:
 *   "u8" | "u16" | "u32" | "i32" | "f64" | "bool" | "string" | "bytes"
 *   "T?"          nullable — presence byte + payload
 *   "T[]"         list — u32 count + items
 *   "struct:Name" nested record, fields inlined in declaration order
 *   "enum:Name"   u8 index into the matching ENUMS row
 */

export interface FieldDef {
  readonly name: string;
  readonly type: string;
}

export interface StructDef {
  readonly name: string;
  readonly fields: readonly FieldDef[];
}

export interface MessageDef {
  /** PascalCase wire name; emitted `kind` is lowerCamel. */
  readonly name: string;
  /** `req` travels host→content, `rep` content→host. */
  readonly dir: "req" | "rep";
  readonly fields: readonly FieldDef[];
  /** For `req` rows: the reply message that completes the call. */
  readonly reply?: string;
}

/** Enums: declared as ordered string tables (wire value = index). */
export const ENUMS: Readonly<Record<string, readonly string[]>> = {
  Cursor: ["default", "pointer", "text"],
  DownloadState: ["started", "progress", "completed", "failed"],
};

export const STRUCTS: readonly StructDef[] = [
  {
    name: "Viewport",
    fields: [
      { name: "width", type: "f64" },
      { name: "height", type: "f64" },
      { name: "devicePixelRatio", type: "f64" },
    ],
  },
  {
    name: "EditableHit",
    fields: [
      { name: "nodeId", type: "string" },
      { name: "tag", type: "string" },
      { name: "value", type: "string" },
      { name: "x", type: "f64" },
      { name: "y", type: "f64" },
      { name: "width", type: "f64" },
      { name: "height", type: "f64" },
      { name: "multiline", type: "bool" },
    ],
  },
  {
    name: "HitInfo",
    fields: [
      { name: "x", type: "f64" },
      { name: "y", type: "f64" },
      { name: "nodeId", type: "string?" },
      { name: "tag", type: "string?" },
      { name: "href", type: "string?" },
      { name: "cursor", type: "enum:Cursor" },
      { name: "editable", type: "struct:EditableHit?" },
    ],
  },
  {
    /** Chrome-visible navigation/tab state, refreshed on every frame reply. */
    name: "NavState",
    fields: [
      { name: "canGoBack", type: "bool" },
      { name: "canGoForward", type: "bool" },
      { name: "url", type: "string" },
      { name: "title", type: "string" },
      { name: "hasPage", type: "bool" },
      /** `target=_blank`/`window.open` navigations pending since the last
       *  reply — the browser process opens a real tab for each (RFC 0011). */
      { name: "pendingNewTabs", type: "struct:NewTabRequest[]" },
      /** Downloads that landed on disk since the last reply — chrome UI
       *  surfaces them (the web-content process owns the network stack and
       *  does the file write; this is the completion notice). */
      { name: "pendingDownloads", type: "struct:DownloadEvent[]" },
      /** `window.close()` on a script-opened context — the shell closes tab. */
      { name: "closeRequested", type: "bool" },
      /** `opener`/`e.source` postMessages addressed to OTHER tabs — the host
       *  routes them (worker→worker messaging goes through the browser proc). */
      { name: "pendingPostMessages", type: "struct:PendingPostMessage[]" },
      /** `window.focus()` targets (own id or a remote tab's) — the shell
       *  activates that tab. `blur` is a no-op (no chrome focus model). */
      { name: "focusRequests", type: "i32[]" },
      /** RFC 0031: the committed document's embedder policy (chrome may
       *  surface isolation state). */
      { name: "coep", type: "string" },
      /** RFC 0031: the committed document's opener policy. */
      { name: "coop", type: "string" },
      /** RFC 0031: COOP same-origin ∧ COEP require-corp/credentialless —
       *  the SharedArrayBuffer/high-res-timer gate. */
      { name: "crossOriginIsolated", type: "bool" },
      /** RFC 0031: `Origin-Agent-Cluster: ?1` requested on this document. */
      { name: "originAgentCluster", type: "bool" },
    ],
  },
  {
    /** A pending `target=_blank`/`window.open` request — the URL plus the
     *  window features that shape the new traversable (RFC 0011). */
    name: "NewTabRequest",
    fields: [
      { name: "url", type: "string" },
      /** Set when the opener asked for `noreferrer` (implies noopener). */
      { name: "referrerPolicy", type: "string?" },
      { name: "popup", type: "bool" },
      { name: "width", type: "u32?" },
      { name: "height", type: "u32?" },
      /** Named traversable name — the shell reuses a tab with this name. */
      { name: "name", type: "string?" },
      /** `window.open` ⇒ the new tab may `window.close()` itself (spec). */
      { name: "scriptOpened", type: "bool" },
      /** When set, the new tab gets NO `window.opener` (noopener/noreferrer). */
      { name: "noopener", type: "bool" },
      /** RFC 0031: the OPENER's document origin — the opened tab's own COOP
       *  re-evaluates the pair once its response headers land. */
      { name: "openerOrigin", type: "string?" },
      /** RFC 0031: the OPENER's COOP — a `same-origin` opener severs the
       *  link when this request's target lands cross-origin. */
      { name: "openerCoop", type: "string?" },
    ],
  },
  {
    /** A `postMessage` that must reach another tab's top-level context. */
    name: "PendingPostMessage",
    fields: [
      { name: "targetTabId", type: "i32" },
      { name: "fromTabId", type: "i32" },
      { name: "fromUrl", type: "string" },
      { name: "dataJson", type: "string" },
      { name: "targetOrigin", type: "string?" },
    ],
  },
  {
    /** A completed download — file already written under downloadsDir. */
    name: "DownloadEvent",
    fields: [
      { name: "url", type: "string" },
      { name: "filename", type: "string" },
      { name: "path", type: "string" },
      /** Bytes written so far (== totalBytes when completed). */
      { name: "bytes", type: "u32" },
      /** Content-Length expectation (null ⇒ server didn't declare one). */
      { name: "totalBytes", type: "u32?" },
      { name: "state", type: "enum:DownloadState" },
      { name: "error", type: "string?" },
    ],
  },
  {
    /** One serialized session entry (history.state travels as JSON text). */
    name: "HistoryEntrySnap",
    fields: [
      { name: "url", type: "string" },
      { name: "title", type: "string" },
      { name: "scrollY", type: "f64" },
      { name: "stateJson", type: "string?" },
      /** Preserves same-document grouping; remapped fresh on restore. */
      { name: "docKey", type: "u32" },
    ],
  },
  {
    /** A whole top-level session history plus its cursor. */
    name: "HistorySnapshot",
    fields: [
      { name: "entries", type: "struct:HistoryEntrySnap[]" },
      { name: "index", type: "i32" },
    ],
  },
  {
    /** One origin's sessionStorage as parallel key/value lists (cloneable). */
    name: "StorageAreaSnapshot",
    fields: [
      { name: "origin", type: "string" },
      { name: "keys", type: "string[]" },
      { name: "values", type: "string[]" },
    ],
  },
  {
    /**
     * A rendered frame: PNG pixels cross as raw `bytes` (transferred, never
     * base64 on the wire) plus the metadata the chrome layer renders.
     */
    name: "Frame",
    fields: [
      { name: "url", type: "string" },
      { name: "title", type: "string" },
      { name: "width", type: "u32" },
      { name: "height", type: "u32" },
      { name: "png", type: "bytes" },
      { name: "durationMs", type: "f64" },
      { name: "frameRev", type: "u32" },
      { name: "scriptsRun", type: "u32" },
      { name: "mutations", type: "u32" },
      { name: "scriptError", type: "string?" },
      { name: "scriptsLoaded", type: "u32" },
      { name: "scriptsFailed", type: "u32" },
      { name: "moduleUrls", type: "u32" },
      { name: "cookies", type: "u32" },
      { name: "networkEvents", type: "u32" },
      { name: "modulesEvaluated", type: "u32" },
      { name: "modulesLinked", type: "u32" },
      { name: "esmSupported", type: "bool" },
      { name: "scrollY", type: "f64" },
      { name: "contentHeight", type: "f64" },
    ],
  },
];

export const MESSAGES: readonly MessageDef[] = [
  // ---- host → content requests ------------------------------------------
  {
    name: "Load",
    dir: "req",
    fields: [
      { name: "url", type: "string" },
      { name: "viewport", type: "struct:Viewport" },
      { name: "keepAlive", type: "bool" },
      { name: "push", type: "bool" },
      /** Window-opener referrer override (window.open "noreferrer"). */
      { name: "referrerPolicy", type: "string?" },
    ],
    reply: "FrameReply",
  },
  {
    name: "LoadHtml",
    dir: "req",
    fields: [
      { name: "html", type: "string" },
      { name: "title", type: "string" },
      { name: "viewport", type: "struct:Viewport" },
    ],
    reply: "FrameReply",
  },
  {
    name: "Back",
    dir: "req",
    fields: [{ name: "viewport", type: "struct:Viewport?" }],
    reply: "FrameReply",
  },
  {
    name: "Forward",
    dir: "req",
    fields: [{ name: "viewport", type: "struct:Viewport?" }],
    reply: "FrameReply",
  },
  {
    name: "Reload",
    dir: "req",
    fields: [{ name: "viewport", type: "struct:Viewport?" }],
    reply: "FrameReply",
  },
  {
    /**
     * A click composes hit-test + focus + follow-link inside the renderer —
     * blur-on-outside-click needs the page's focus state, which lives there.
     */
    name: "ClickAt",
    dir: "req",
    fields: [
      { name: "x", type: "f64" },
      { name: "y", type: "f64" },
      { name: "viewport", type: "struct:Viewport?" },
    ],
    reply: "ClickReply",
  },
  {
    name: "SetViewport",
    dir: "req",
    fields: [{ name: "viewport", type: "struct:Viewport" }],
    reply: "FrameReply",
  },
  {
    name: "Scroll",
    dir: "req",
    fields: [
      { name: "dx", type: "f64" },
      { name: "dy", type: "f64" },
      { name: "settle", type: "bool" },
      { name: "viewport", type: "struct:Viewport?" },
    ],
    reply: "FrameReply",
  },
  {
    name: "HitTest",
    dir: "req",
    fields: [
      { name: "x", type: "f64" },
      { name: "y", type: "f64" },
    ],
    reply: "HitInfoReply",
  },
  {
    name: "CommitText",
    dir: "req",
    fields: [
      { name: "nodeId", type: "string" },
      { name: "text", type: "string" },
      { name: "caret", type: "f64" },
      { name: "selStart", type: "f64" },
      { name: "selEnd", type: "f64" },
      { name: "preview", type: "bool" },
    ],
    reply: "FrameReply",
  },
  {
    name: "Pump",
    dir: "req",
    fields: [
      { name: "count", type: "u32" },
      { name: "settleMs", type: "u32" },
      { name: "idleStop", type: "bool" },
    ],
    reply: "PumpReply",
  },
  {
    name: "GetFrame",
    dir: "req",
    fields: [],
    reply: "FrameBytesReply",
  },
  {
    name: "GetNav",
    dir: "req",
    fields: [],
    reply: "NavStateReply",
  },
  {
    name: "Ping",
    dir: "req",
    fields: [],
    reply: "StatusReply",
  },
  {
    /** Export the tab's sessionStorage across origins (duplication clone). */
    name: "ExportSessionStorage",
    dir: "req",
    fields: [],
    reply: "SessionStorageReply",
  },
  {
    /** Import a sessionStorage snapshot — the clone then diverges. */
    name: "ImportSessionStorage",
    dir: "req",
    fields: [{ name: "areas", type: "struct:StorageAreaSnapshot[]" }],
    reply: "StatusReply",
  },
  {
    /** Export the tab's session history for disk persistence. */
    name: "ExportHistory",
    dir: "req",
    fields: [],
    reply: "HistoryReply",
  },
  {
    /** Restore a persisted history — then reload the current entry. */
    name: "ImportHistory",
    dir: "req",
    fields: [{ name: "snapshot", type: "struct:HistorySnapshot" }],
    reply: "FrameReply",
  },
  {
    /** Deliver a cross-tab postMessage into this tab's top-level context. */
    name: "DeliverMessage",
    dir: "req",
    fields: [
      { name: "fromTabId", type: "i32" },
      { name: "fromUrl", type: "string" },
      { name: "dataJson", type: "string" },
      { name: "targetOrigin", type: "string?" },
    ],
    reply: "FrameReply",
  },
  {
    name: "Dispose",
    dir: "req",
    fields: [],
    reply: "StatusReply",
  },

  // ---- content → host replies -------------------------------------------
  {
    /** Every frame-producing op answers with the frame + fresh nav state. */
    name: "FrameReply",
    dir: "rep",
    fields: [
      { name: "frame", type: "struct:Frame?" },
      { name: "nav", type: "struct:NavState" },
    ],
  },
  {
    name: "HitInfoReply",
    dir: "rep",
    fields: [{ name: "hit", type: "struct:HitInfo" }],
  },
  {
    name: "PumpReply",
    dir: "rep",
    fields: [
      { name: "frames", type: "u32" },
      { name: "mutations", type: "u32" },
      { name: "frameRev", type: "u32" },
      { name: "frame", type: "struct:Frame?" },
      { name: "nav", type: "struct:NavState" },
    ],
  },
  {
    name: "FrameBytesReply",
    dir: "rep",
    fields: [
      { name: "png", type: "bytes?" },
      { name: "frameRev", type: "u32" },
    ],
  },
  {
    name: "NavStateReply",
    dir: "rep",
    fields: [{ name: "nav", type: "struct:NavState" }],
  },
  {
    name: "ClickReply",
    dir: "rep",
    fields: [
      { name: "hit", type: "struct:HitInfo" },
      { name: "navigated", type: "bool" },
      { name: "frame", type: "struct:Frame?" },
      { name: "editable", type: "struct:EditableHit?" },
      { name: "nav", type: "struct:NavState" },
    ],
  },
  {
    name: "SessionStorageReply",
    dir: "rep",
    fields: [{ name: "areas", type: "struct:StorageAreaSnapshot[]" }],
  },
  {
    /** A tab's whole serialized session history (restart restore). */
    name: "HistoryReply",
    dir: "rep",
    fields: [{ name: "snapshot", type: "struct:HistorySnapshot" }],
  },
  {
    /** Liveness + the renderer's own font-stack report for /api/health. */
    name: "StatusReply",
    dir: "rep",
    fields: [
      { name: "ok", type: "bool" },
      { name: "fonts", type: "string" },
    ],
  },
  {
    /** Reserved: any request may fail with this instead of its reply row. */
    name: "Error",
    dir: "rep",
    fields: [{ name: "message", type: "string" }],
  },
];

/** The reserved wire tag of the error reply. */
export const ERROR_TAG = 0;
