/**
 * @browser-engine/html-parser
 *
 * Parses a source byte stream into the {@link DomTree} IR, exposed (by the cli
 * wiring layer) as the memoized pure query `qDom`. See design.md §4.1, §6,
 * §7.2.
 *
 * ## Task 5.1 — the full HTML5 tree-construction algorithm
 *
 * Task 3.1 shipped a *minimal* single-pass string scanner. Task 5.1 (Phase 2-4,
 * Requirement 15.1) replaces it with a genuine two-stage HTML5 implementation:
 *
 *   1. A **tokenizer** — a real character-by-character state machine
 *      (`tokenize`) modelled on the WHATWG "12.2.5 Tokenization" states: data,
 *      tag-open/end-tag-open, tag-name, the attribute states (before-name,
 *      name, after-name, before-value, the three value states, after-value),
 *      self-closing, markup-declaration (comment / DOCTYPE / bogus comment),
 *      and RAWTEXT / RCDATA for raw-text and escapable raw-text elements. It
 *      emits a token stream and records tokenizer-level parse errors as
 *      recovery events.
 *
 *   2. A **tree-construction** stage (`buildTree`) — the stack of open elements,
 *      the standard element categories (void, raw-text, escapable raw-text),
 *      optional-tag auto-closing (`<p>`, `<li>`, `<dd>`/`<dt>`, `<option>`,
 *      table sections/cells), implied end tags, and the common error-recovery
 *      behaviours (mismatched end tags force-close intervening elements, stray
 *      end tags are dropped, elements left open at EOF are closed).
 *
 * ### Recovery metric (Requirements 13.1, 13.2, 18.6)
 *
 * Malformed input never throws: the parser applies error recovery and keeps
 * producing a best-effort {@link DomTree}. Every recovery is recorded as a
 * {@link RecoveryEvent}. The pipeline-facing {@link parseHtml} returns only the
 * tree (so it stays a drop-in pure `qDom`), while {@link parseHtmlWithMetrics}
 * additionally surfaces the recovery list. `recoveries.length` is the recovery
 * count (Requirement 13.2).
 *
 * ### Deliberate, documented divergences from the letter of the spec
 *
 * The north star is compat-per-LOC and test stability, not html5lib bug-for-bug
 * fidelity (the task explicitly sanctions a "reasonable, well-tested
 * approximation"). Two divergences are intentional:
 *
 *   - **No forced `html`/`head`/`body` insertion.** The real algorithm wraps a
 *     bare `<div>hello</div>` in implied `<html><head></head><body>…`. We do
 *     NOT: top-level elements are parented directly to the `document`, so
 *     `<div>hello</div>` stays `document → div → text "hello"` (the node shape
 *     the whole downstream pipeline — cli pipeline/render/phase1 WPT checks —
 *     depends on). When the input DOES contain explicit `<html>`/`<head>`/
 *     `<body>` tags they are honoured as ordinary elements. The `document` node
 *     therefore acts as the implicit root container, fragment-style.
 *
 *   - **No adoption-agency reparenting.** A mismatched end tag (`<b><i></b>`)
 *     force-closes the intervening open elements and records a recovery instead
 *     of running the full "adoption agency" formatting-element reconstruction.
 *
 * Optional-tag auto-closing (omitting `</p>`, `</li>`, …) is *valid* HTML, not
 * an error, so it is performed but NOT counted as a recovery; only genuine
 * malformedness (stray/mismatched end tags, unclosed elements, bad tag
 * characters, truncated comments/tags) increments the recovery metric.
 *
 * ### Invariants preserved from task 3.1
 *
 *   - Requirement 18.1 — a valid HTML byte stream parses into a DomTree.
 *   - Requirement 2.7 — `parseHtml` is a *pure* function of its input bytes, so
 *     it is safe as the memoized `qDom` query: no side effects, no shared
 *     mutable state, deterministic output. The result is `deepFreeze`-d so a
 *     downstream stage can never mutate upstream IR (Requirement 3.2).
 *
 * This module imports ONLY the frozen IR (`@browser-engine/ir`) — the single
 * sanctioned inter-stage channel — so it never reaches across a stage boundary
 * (`local/no-cross-stage-import`).
 */
import { deepFreeze, nodeId } from "@browser-engine/ir";
import type { DomNode, DomNodeKind, DomTree, NodeId } from "@browser-engine/ir";

export const PACKAGE_NAME = "@browser-engine/html-parser" as const;

// The Pretty_Printer (DomTree → HTML, Requirement 18.3) and the round-trip
// structural-equality oracle (Requirement 18.4) live in `./serialize.ts` and
// are re-exported here so the package entry point exposes the full
// parse/print/equivalence surface (task 5.2).
export { serializeDom, domTreesEquivalent } from "./serialize.js";

// ---------------------------------------------------------------------------
// Recovery metric (Requirements 13.1, 13.2, 18.6)
// ---------------------------------------------------------------------------

/**
 * The kinds of spec error-recovery the parser performs on malformed input. Each
 * is a genuine HTML parse error (NOT a valid-but-terse construct such as an
 * omitted optional end tag, which is handled silently).
 */
export type RecoveryKind =
  /** A `<` not introducing a valid tag, or a stray `<!`/`<?`. */
  | "invalid-tag-character"
  /** `</>` with no tag name. */
  | "missing-end-tag-name"
  /** A `<!-- … ` comment that never closed before EOF. */
  | "eof-in-comment"
  /** A `<!… >` / `<?…>` parsed as a bogus comment. */
  | "bogus-comment"
  /** A tag or attribute list truncated by EOF. */
  | "eof-in-tag"
  /** An end tag with no matching open element (dropped). */
  | "stray-end-tag"
  /** An end tag that force-closed intervening, differently-named elements. */
  | "mismatched-end-tag"
  /** An end tag for a void element (which can never be open). */
  | "end-tag-for-void-element"
  /** An element still open when the input ended (closed implicitly). */
  | "unclosed-element";

/** A single recovery the parser applied while reading malformed input. */
export interface RecoveryEvent {
  readonly kind: RecoveryKind;
  /** The tag name involved, when the recovery is about a specific element. */
  readonly tag?: string;
  /** The source character offset where the recovery occurred. */
  readonly position: number;
}

/** The full output of {@link parseHtmlWithMetrics}: tree + recovery metric. */
export interface ParseResult {
  readonly tree: DomTree;
  readonly recoveries: readonly RecoveryEvent[];
  /**
   * The document's rendering mode, determined from the DOCTYPE (HTML §13.2.6.1).
   * `"no-quirks"` (standards) for `<!DOCTYPE html>` or a modern public/system id;
   * `"quirks"` when the DOCTYPE is ABSENT or a legacy form; `"limited-quirks"`
   * for the few legacy DOCTYPEs that trigger almost-standards mode. Drives
   * quirks-mode layout behaviours (task 9.4; Requirement 17.4).
   */
  readonly mode: DocumentMode;
}

/**
 * A document's rendering mode (HTML §13.2.6.1 "Determining the document mode").
 * The engine's quirks-mode layout (Requirement 17.4) keys off this.
 */
export type DocumentMode = "no-quirks" | "quirks" | "limited-quirks";

/**
 * Parse a source byte stream into the {@link DomTree} IR (design.md §4.1, §6).
 *
 * The returned tree is rooted at a `document` node whose children are the
 * top-level parsed nodes (mirroring the DOM, where `document` is the root). The
 * whole graph is deep-frozen for runtime immutability (Requirement 3.2). This
 * is the pipeline-facing entry point (`qDom`); use {@link parseHtmlWithMetrics}
 * when the recovery metric is also wanted.
 *
 * @param source raw bytes of the document, decoded as UTF-8.
 * @returns a frozen, branded {@link DomTree}.
 */
export function parseHtml(source: Uint8Array): DomTree {
  return parseHtmlWithMetrics(source).tree;
}

/**
 * Detect the document rendering mode for a source byte stream (task 9.4;
 * Requirement 17.4) without retaining the parsed tree. A convenience over
 * {@link parseHtmlWithMetrics}'s `mode` for callers that only need the mode
 * (e.g. the quirks-mode layout switch).
 *
 * @param source raw bytes of the document, decoded as UTF-8.
 */
export function detectDocumentMode(source: Uint8Array): DocumentMode {
  return parseHtmlWithMetrics(source).mode;
}

/**
 * Parse like {@link parseHtml}, additionally returning the recovery metric — the
 * list of spec error-recoveries applied to malformed input (Requirements 13.1,
 * 13.2, 18.6). Both the tree and the recovery list are deep-frozen. Pure: same
 * bytes ⇒ structurally equal result.
 *
 * @param source raw bytes of the document, decoded as UTF-8.
 */
export function parseHtmlWithMetrics(source: Uint8Array): ParseResult {
  const html = new TextDecoder("utf-8").decode(source);
  const recoveries: RecoveryEvent[] = [];
  const record = (kind: RecoveryKind, position: number, tag?: string): void => {
    recoveries.push(tag === undefined ? { kind, position } : { kind, tag, position });
  };

  const tokens = tokenize(html, record);
  const tree = buildTree(tokens, html.length, record);
  const mode = determineDocumentMode(tokens);

  return deepFreeze({ tree, recoveries, mode });
}

/**
 * Determine the document rendering mode from the token stream (HTML §13.2.6.1,
 * a pragmatic subset; task 9.4 / Requirement 17.4):
 *
 *   - NO DOCTYPE at all ⇒ `"quirks"` (the classic "missing doctype" trigger).
 *   - `<!DOCTYPE html>` (just the name, no legacy public/system id) ⇒
 *     `"no-quirks"` (standards mode).
 *   - A legacy public id known to trigger almost-standards mode (the HTML4
 *     transitional / frameset ids WITH a system id) ⇒ `"limited-quirks"`.
 *   - Any other / older DOCTYPE (e.g. HTML 3.2, a public id without a system id)
 *     ⇒ `"quirks"`.
 *
 * Only the FIRST doctype token is consulted (a later one is a parse error and
 * ignored for mode purposes). Internal: the public entry is
 * {@link detectDocumentMode}, which parses raw bytes.
 */
function determineDocumentMode(tokens: readonly Token[]): DocumentMode {
  const doctype = tokens.find((t): t is DoctypeToken => t.type === "doctype");
  if (doctype === undefined) {
    return "quirks"; // no DOCTYPE ⇒ quirks mode.
  }
  return classifyDoctype(doctype.raw);
}

/** Limited-quirks public-id prefixes (HTML §13.2.6.1, almost-standards mode). */
const LIMITED_QUIRKS_PUBLIC_PREFIXES: readonly string[] = [
  "-//w3c//dtd xhtml 1.0 frameset//",
  "-//w3c//dtd xhtml 1.0 transitional//",
];

/** Classify a raw DOCTYPE string (the text between `<!` and `>`). */
function classifyDoctype(raw: string): DocumentMode {
  // Strip the leading `doctype` keyword and normalise whitespace/case.
  const body = raw.replace(/^doctype/i, "").trim();
  if (body.length === 0) {
    return "quirks"; // `<!DOCTYPE>` with no name.
  }

  const lower = body.toLowerCase();
  // The modern, standards-mode doctype: just the name `html`, nothing else.
  if (lower === "html") {
    return "no-quirks";
  }

  // A doctype carrying a PUBLIC identifier: inspect it for the legacy forms.
  const publicMatch = /public\s+("[^"]*"|'[^']*')(?:\s+("[^"]*"|'[^']*'))?/i.exec(body);
  if (publicMatch !== undefined && publicMatch !== null) {
    const publicId = (publicMatch[1] ?? "").slice(1, -1).toLowerCase();
    const hasSystemId = publicMatch[2] !== undefined;
    // The two transitional/frameset ids trigger limited-quirks ONLY when a
    // system identifier is also present; otherwise they are full quirks.
    if (hasSystemId && LIMITED_QUIRKS_PUBLIC_PREFIXES.some((p) => publicId.startsWith(p))) {
      return "limited-quirks";
    }
    return "quirks"; // any other public id (HTML 3.2, etc.) ⇒ quirks.
  }

  // `<!DOCTYPE html SYSTEM "...">` and other non-`html`-only forms ⇒ quirks.
  return "quirks";
}

// ---------------------------------------------------------------------------
// Element categories (WHATWG §3.2.5 / §13.2.6 content + parser categories).
// ---------------------------------------------------------------------------

/** Void elements: never have children; closed implicitly; self-closing-ok. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Raw-text elements: content is verbatim, no markup, no character references. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/** Escapable raw-text (RCDATA) elements: verbatim markup, but entities decode. */
const RCDATA_ELEMENTS: ReadonlySet<string> = new Set(["textarea", "title"]);

/**
 * Elements whose END tag is optional (HTML §13.1.1). Leaving one of these open
 * at EOF is valid HTML, so it does NOT count as a recovery; any OTHER element
 * left open is a genuine "unclosed-element" error.
 */
const OPTIONAL_END_TAG: ReadonlySet<string> = new Set([
  "html", "head", "body", "p", "li", "dd", "dt", "option", "optgroup",
  "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "caption",
]);

/**
 * Elements auto-closed by "generate implied end tags". Used both when closing a
 * `<p>` and when a later end tag legitimately closes terser optional children
 * (e.g. `</ul>` closing an open `<li>`).
 */
const IMPLIED_END_TAGS: ReadonlySet<string> = new Set([
  "dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc",
]);

/**
 * Start tags that close an open `<p>` (HTML "in body" insertion mode). Seeing
 * any of these while a `<p>` is in button scope auto-closes that `<p>`.
 */
const P_CLOSING_START_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog",
  "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "header",
  "hgroup", "main", "menu", "nav", "ol", "p", "section", "summary", "ul",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre", "table", "form",
]);

/**
 * Boundary elements for "button scope" lookups (HTML "has an element in button
 * scope"). Scanning the open-element stack for a `<p>` stops at any of these.
 */
const BUTTON_SCOPE_BOUNDARIES: ReadonlySet<string> = new Set([
  "html", "table", "caption", "td", "th", "marquee", "object",
  "template", "button", "applet",
]);

/** Whitespace characters that terminate a tag/attribute name (HTML §13.2.5). */
function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** A tag name must start with an ASCII letter (HTML "tag open state"). */
function isAsciiAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

// ===========================================================================
// Stage 1: Tokenizer (HTML §13.2.5 tokenization, character-by-character).
// ===========================================================================

/** A start tag token (`<div …>` / `<br …/>`). */
interface StartTagToken {
  readonly type: "start";
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly position: number;
}

/** An end tag token (`</div>`). */
interface EndTagToken {
  readonly type: "end";
  readonly name: string;
  readonly position: number;
}

/** A run of character data (already entity-decoded for non-raw content). */
interface CharactersToken {
  readonly type: "characters";
  readonly data: string;
  readonly position: number;
}

/** A comment token. `bogus` marks `<! … >` / `<? … >` recovered as a comment. */
interface CommentToken {
  readonly type: "comment";
  readonly data: string;
  readonly position: number;
}

/** A DOCTYPE token (no node is emitted for it; kept so the driver can skip it). */
interface DoctypeToken {
  readonly type: "doctype";
  readonly position: number;
  /** The raw DOCTYPE contents between `<!` and `>` (e.g. `doctype html`). */
  readonly raw: string;
}

type Token =
  | StartTagToken
  | EndTagToken
  | CharactersToken
  | CommentToken
  | DoctypeToken;

/** Signature of the recovery-recording callback threaded through both stages. */
type RecordRecovery = (kind: RecoveryKind, position: number, tag?: string) => void;

/**
 * Run the HTML tokenizer over `html`, returning the token stream. The tree
 * builder decides RAWTEXT/RCDATA transitions, so the tokenizer exposes a hook
 * via the returned tokens: when a start tag for a raw-text/RCDATA element is
 * emitted, this function itself switches the relevant state (it knows the
 * element categories), keeping a single pass.
 */
function tokenize(html: string, record: RecordRecovery): Token[] {
  const tokens: Token[] = [];
  const len = html.length;
  let i = 0;

  /** Accumulator for the current run of character data. */
  let textStart = -1;
  let textBuf = "";

  const flushText = (): void => {
    if (textBuf.length > 0) {
      tokens.push({ type: "characters", data: textBuf, position: textStart });
    }
    textBuf = "";
    textStart = -1;
  };

  const pushText = (s: string, at: number): void => {
    if (s.length === 0) return;
    if (textStart === -1) textStart = at;
    textBuf += s;
  };

  while (i < len) {
    const ch = html[i] ?? "";

    if (ch !== "<") {
      // ---- data state: consume a run up to the next '<' -------------------
      let j = i + 1;
      while (j < len && html[j] !== "<") j += 1;
      pushText(decodeEntities(html.slice(i, j)), i);
      i = j;
      continue;
    }

    // ch === "<": markup. Decide which construct by the next character.
    const next = html[i + 1];

    if (next === "!") {
      flushText();
      i = tokenizeMarkupDeclaration(html, i, tokens, record);
      continue;
    }

    if (next === "/") {
      flushText();
      i = tokenizeEndTag(html, i, tokens, record);
      continue;
    }

    if (next === "?") {
      // Bogus comment (HTML: a '?' here is a parse error → comment).
      flushText();
      record("bogus-comment", i);
      const end = html.indexOf(">", i);
      const stop = end === -1 ? len : end;
      tokens.push({ type: "comment", data: html.slice(i + 1, stop), position: i });
      i = end === -1 ? len : end + 1;
      continue;
    }

    if (next !== undefined && isAsciiAlpha(next)) {
      flushText();
      const result = tokenizeStartTag(html, i, record);
      tokens.push(result.token);
      i = result.nextIndex;

      // The tokenizer owns RAWTEXT/RCDATA: after a non-self-closing raw-text or
      // escapable-raw-text start tag, consume content verbatim up to its end
      // tag (HTML §13.2.5.2 RAWTEXT/RCDATA states).
      if (!result.token.selfClosing) {
        const name = result.token.name;
        if (RAW_TEXT_ELEMENTS.has(name)) {
          i = tokenizeRawText(html, i, name, tokens, record, false);
        } else if (RCDATA_ELEMENTS.has(name)) {
          i = tokenizeRawText(html, i, name, tokens, record, true);
        }
      }
      continue;
    }

    // A '<' not introducing a tag/comment/declaration (e.g. "a < b"): the spec
    // emits it as a literal character and stays in the data state.
    record("invalid-tag-character", i);
    pushText("<", i);
    i += 1;
  }

  flushText();
  return tokens;
}

/**
 * Tokenize a markup declaration beginning at `start` (the `<`, with `html[start
 * + 1] === "!"`): a comment (`<!-- … -->`), a DOCTYPE, or a bogus comment
 * (`<!…>`). Returns the index just past the construct.
 */
function tokenizeMarkupDeclaration(
  html: string,
  start: number,
  tokens: Token[],
  record: RecordRecovery,
): number {
  const len = html.length;

  if (html.startsWith("<!--", start)) {
    const end = html.indexOf("-->", start + 4);
    if (end === -1) {
      // Unterminated comment: take the rest of the input as its data.
      record("eof-in-comment", start);
      tokens.push({ type: "comment", data: html.slice(start + 4), position: start });
      return len;
    }
    tokens.push({ type: "comment", data: html.slice(start + 4, end), position: start });
    return end + 3;
  }

  // `<!DOCTYPE …>` (case-insensitive). Emitted as a doctype token; no node.
  if (/^<!doctype/i.test(html.slice(start, start + 9))) {
    const end = html.indexOf(">", start);
    const stop = end === -1 ? len : end;
    tokens.push({ type: "doctype", position: start, raw: html.slice(start + 2, stop) });
    return end === -1 ? len : end + 1;
  }

  // Anything else after `<!` (e.g. `<![CDATA[…]]>`, `<!foo>`): bogus comment.
  record("bogus-comment", start);
  const end = html.indexOf(">", start);
  const stop = end === -1 ? len : end;
  tokens.push({ type: "comment", data: html.slice(start + 2, stop), position: start });
  return end === -1 ? len : end + 1;
}

/**
 * Tokenize an end tag beginning at `start` (the `<`, with `html[start + 1] ===
 * "/"`). Returns the index just past the closing `>`.
 */
function tokenizeEndTag(
  html: string,
  start: number,
  tokens: Token[],
  record: RecordRecovery,
): number {
  const len = html.length;
  const after = html[start + 2];

  if (after === ">") {
    // `</>`: missing end tag name (parse error). Per spec this is ignored.
    record("missing-end-tag-name", start);
    return start + 3;
  }

  if (after === undefined) {
    // `</` at EOF.
    record("eof-in-tag", start);
    return len;
  }

  if (!isAsciiAlpha(after)) {
    // `</1>` etc.: not a valid end tag name → bogus comment per spec.
    record("bogus-comment", start);
    const bad = html.indexOf(">", start);
    const stop = bad === -1 ? len : bad;
    tokens.push({ type: "comment", data: html.slice(start + 2, stop), position: start });
    return bad === -1 ? len : bad + 1;
  }

  let i = start + 2;
  const nameStart = i;
  while (i < len) {
    const c = html[i] ?? "";
    if (isSpace(c) || c === ">" || c === "/") break;
    i += 1;
  }
  const name = html.slice(nameStart, i).toLowerCase();

  // Skip any junk (attributes are ignored on end tags) up to '>'.
  const gt = html.indexOf(">", i);
  if (gt === -1) {
    record("eof-in-tag", start, name);
    tokens.push({ type: "end", name, position: start });
    return len;
  }
  tokens.push({ type: "end", name, position: start });
  return gt + 1;
}

/** Result of {@link tokenizeStartTag}. */
interface StartTagResult {
  readonly token: StartTagToken;
  readonly nextIndex: number;
}

/**
 * Tokenize a start tag beginning at `start` (the `<`). Implements the tag-name
 * and attribute states: lowercased name, attribute names lowercased, values
 * entity-decoded, first declaration of a duplicate attribute wins (HTML parse
 * error on the duplicate, but we keep the first quietly to match the DOM).
 */
function tokenizeStartTag(html: string, start: number, record: RecordRecovery): StartTagResult {
  const len = html.length;
  let i = start + 1;

  // ---- tag name -----------------------------------------------------------
  const nameStart = i;
  while (i < len) {
    const c = html[i] ?? "";
    if (isSpace(c) || c === ">" || c === "/") break;
    i += 1;
  }
  const name = html.slice(nameStart, i).toLowerCase();

  const attrs = new Map<string, string>();
  let selfClosing = false;

  // ---- attribute list -----------------------------------------------------
  while (i < len) {
    while (i < len && isSpace(html[i] ?? "")) i += 1;
    if (i >= len) {
      record("eof-in-tag", start, name);
      break;
    }

    const c = html[i];
    if (c === ">") {
      i += 1;
      return { token: { type: "start", name, attrs, selfClosing, position: start }, nextIndex: i };
    }
    if (c === "/") {
      // Self-closing solidus. Spec: only meaningful right before '>'.
      i += 1;
      while (i < len && isSpace(html[i] ?? "")) i += 1;
      if (html[i] === ">") {
        selfClosing = true;
        i += 1;
        return {
          token: { type: "start", name, attrs, selfClosing, position: start },
          nextIndex: i,
        };
      }
      // A stray '/' not before '>': treat as an attribute-name boundary.
      selfClosing = true;
      continue;
    }

    // ---- attribute name ---------------------------------------------------
    const attrNameStart = i;
    while (i < len) {
      const a = html[i] ?? "";
      if (isSpace(a) || a === "=" || a === ">" || a === "/") break;
      i += 1;
    }
    const attrName = html.slice(attrNameStart, i).toLowerCase();

    // ---- optional value ---------------------------------------------------
    while (i < len && isSpace(html[i] ?? "")) i += 1;
    let value = "";
    let hasValue = false;
    if (html[i] === "=") {
      hasValue = true;
      i += 1;
      while (i < len && isSpace(html[i] ?? "")) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const valueStart = i + 1;
        const close = html.indexOf(quote, valueStart);
        const valueEnd = close === -1 ? len : close;
        value = decodeEntities(html.slice(valueStart, valueEnd));
        if (close === -1) record("eof-in-tag", start, name);
        i = close === -1 ? len : close + 1;
      } else {
        const valueStart = i;
        while (i < len) {
          const v = html[i] ?? "";
          if (isSpace(v) || v === ">") break;
          i += 1;
        }
        value = decodeEntities(html.slice(valueStart, i));
      }
    }

    if (attrName.length > 0 && !attrs.has(attrName)) {
      // A valueless attribute carries the empty string (HTML boolean attr).
      attrs.set(attrName, hasValue ? value : "");
    }
  }

  // Reached EOF inside the tag.
  return { token: { type: "start", name, attrs, selfClosing, position: start }, nextIndex: len };
}

/**
 * Consume RAWTEXT / RCDATA content for `name` starting at `start`, up to its
 * matching `</name>` end tag (case-insensitive). Emits a characters token for
 * the content (entity-decoded only for RCDATA) and the end tag token. Returns
 * the index just past the end tag (or EOF).
 */
function tokenizeRawText(
  html: string,
  start: number,
  name: string,
  tokens: Token[],
  record: RecordRecovery,
  decodeRefs: boolean,
): number {
  const len = html.length;
  const lower = html.toLowerCase();
  const close = `</${name}`;
  const idx = lower.indexOf(close, start);

  if (idx === -1) {
    // No end tag before EOF: take the rest as content, leave element open.
    const content = html.slice(start);
    if (content.length > 0) {
      tokens.push({
        type: "characters",
        data: decodeRefs ? decodeEntities(content) : content,
        position: start,
      });
    }
    record("eof-in-tag", start, name);
    return len;
  }

  const content = html.slice(start, idx);
  if (content.length > 0) {
    tokens.push({
      type: "characters",
      data: decodeRefs ? decodeEntities(content) : content,
      position: start,
    });
  }
  tokens.push({ type: "end", name, position: idx });
  const gt = html.indexOf(">", idx);
  return gt === -1 ? len : gt + 1;
}

// ===========================================================================
// Stage 2: Tree construction (HTML §13.2.6 — stack of open elements, implied
// end tags, optional-tag auto-closing, error recovery).
// ===========================================================================

/** A node under construction. Optional fields are populated per `kind`. */
interface MutableNode {
  readonly id: NodeId;
  readonly kind: DomNodeKind;
  tag?: string;
  attrs?: ReadonlyMap<string, string>;
  text?: string;
  readonly children: NodeId[];
  readonly parent: NodeId | null;
}

/**
 * Build the DomTree from the token stream. Maintains the stack of open
 * elements (index 0 is always the `document` root, so the stack never empties);
 * the element at the top is the current insertion point.
 *
 * @param tokens   the token stream from {@link tokenize}.
 * @param eofPos   the source length (position attributed to EOF recoveries).
 * @param record   the recovery-recording callback.
 */
function buildTree(tokens: readonly Token[], eofPos: number, record: RecordRecovery): DomTree {
  const nodes: MutableNode[] = [];

  const create = (kind: DomNodeKind, parent: NodeId | null): MutableNode => {
    const node: MutableNode = { id: nodeId(nodes.length), kind, children: [], parent };
    nodes.push(node);
    return node;
  };

  const root = create("document", null);
  const stack: MutableNode[] = [root];
  const top = (): MutableNode => stack[stack.length - 1] ?? root;

  const appendChildTo = (parent: MutableNode, kind: DomNodeKind): MutableNode => {
    const node = create(kind, parent.id);
    parent.children.push(node.id);
    return node;
  };

  /** Does the open-element stack hold an element named `name`? */
  const hasOpenElement = (name: string): boolean => {
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      if (stack[k]?.tag === name) return true;
    }
    return false;
  };

  /** "Has a `<p>` in button scope" (HTML scope rules, used for p auto-close). */
  const hasParagraphInButtonScope = (): boolean => {
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      const el = stack[k];
      if (el === undefined) continue;
      if (el.tag === "p") return true;
      if (el.tag !== undefined && BUTTON_SCOPE_BOUNDARIES.has(el.tag)) return false;
    }
    return false;
  };

  /**
   * Pop the stack down to (and including) the nearest element named `name`.
   * Records a `mismatched-end-tag` recovery for each intervening element that
   * is force-closed. Returns true if a match was found.
   */
  const closeNamedElement = (name: string, position: number): boolean => {
    let target = -1;
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      if (stack[k]?.tag === name) {
        target = k;
        break;
      }
    }
    if (target === -1) return false;
    // Anything above the target was left open by malformed nesting — unless it
    // is an optional-end-tag element legitimately closed by this ancestor's end
    // tag (e.g. `</ul>` closing an open `<li>`, `</table>` closing `<tr>`/`<td>`),
    // which is valid HTML and recorded as no recovery.
    for (let k = stack.length - 1; k > target; k -= 1) {
      const el = stack[k];
      if (el?.tag !== undefined && !OPTIONAL_END_TAG.has(el.tag)) {
        record("mismatched-end-tag", position, el.tag);
      }
    }
    stack.length = target;
    return true;
  };

  /** Generate implied end tags (optionally except `keep`) — HTML §13.2.6. */
  const generateImpliedEndTags = (keep?: string): void => {
    while (stack.length > 1) {
      const el = top();
      if (el.tag !== undefined && el.tag !== keep && IMPLIED_END_TAGS.has(el.tag)) {
        stack.pop();
      } else {
        break;
      }
    }
  };

  /** Auto-close an open `<p>` (in button scope) before a block-level start. */
  const closeParagraphIfOpen = (): void => {
    if (hasParagraphInButtonScope()) {
      generateImpliedEndTags("p");
      // Pop up to and including the <p>.
      while (stack.length > 1) {
        const popped = stack.pop();
        if (popped?.tag === "p") break;
      }
    }
  };

  /**
   * Optional-tag auto-closing on a NEW start tag (HTML §13.1.1): a sibling
   * `<li>`, `<dd>`/`<dt>`, `<option>`, table row/cell, etc. closes the open one.
   * This is VALID HTML, so it is performed silently (no recovery recorded).
   */
  const autoCloseForStartTag = (name: string): void => {
    const current = top().tag;
    if (current === undefined) return;

    if (name === "li" && current === "li") {
      stack.pop();
      return;
    }
    if ((name === "dd" || name === "dt") && (current === "dd" || current === "dt")) {
      stack.pop();
      return;
    }
    if (name === "option" && current === "option") {
      stack.pop();
      return;
    }
    if (name === "optgroup" && (current === "option" || current === "optgroup")) {
      if (current === "option") stack.pop();
      if (top().tag === "optgroup") stack.pop();
      return;
    }
    if ((name === "tr") && current === "tr") {
      stack.pop();
      return;
    }
    if ((name === "td" || name === "th") && (current === "td" || current === "th")) {
      stack.pop();
      return;
    }
    if ((name === "thead" || name === "tbody" || name === "tfoot")) {
      // Close an open cell/row/section before a new table section.
      while (
        stack.length > 1 &&
        ["td", "th", "tr", "thead", "tbody", "tfoot"].includes(top().tag ?? "")
      ) {
        stack.pop();
      }
      return;
    }

    if (P_CLOSING_START_TAGS.has(name)) {
      closeParagraphIfOpen();
    }
  };

  // ---- main token loop ----------------------------------------------------
  for (const token of tokens) {
    switch (token.type) {
      case "doctype":
        // No node is materialised for a DOCTYPE (matches task 3.1 behaviour).
        break;

      case "characters": {
        const node = appendChildTo(top(), "text");
        node.text = token.data;
        break;
      }

      case "comment": {
        const node = appendChildTo(top(), "comment");
        node.text = token.data;
        break;
      }

      case "start": {
        autoCloseForStartTag(token.name);

        const el = appendChildTo(top(), "element");
        el.tag = token.name;
        el.attrs = token.attrs;

        if (VOID_ELEMENTS.has(token.name) || token.selfClosing) {
          // Childless; never pushed onto the open-element stack.
          break;
        }
        // Ordinary, raw-text, and RCDATA elements all push onto the stack. For
        // raw-text/RCDATA the tokenizer has already emitted this element's
        // verbatim content as a characters token followed by its end tag, so
        // the content attaches as a child and the end tag pops it normally.
        stack.push(el);
        break;
      }

      case "end": {
        const name = token.name;

        if (VOID_ELEMENTS.has(name)) {
          // `</br>`, `</img>`, … — void elements are never open.
          record("end-tag-for-void-element", token.position, name);
          break;
        }

        if (!hasOpenElement(name)) {
          // Stray end tag: no matching open element (dropped per spec).
          record("stray-end-tag", token.position, name);
          break;
        }

        // Closing a `<p>`/`<li>`/… first generates implied end tags.
        generateImpliedEndTags(name);
        closeNamedElement(name, token.position);
        break;
      }

      default: {
        // Exhaustiveness guard: every token kind is handled above.
        const _exhaustive: never = token;
        return _exhaustive;
      }
    }
  }

  // ---- EOF: close everything still open -----------------------------------
  for (let k = stack.length - 1; k >= 1; k -= 1) {
    const el = stack[k];
    if (el?.tag !== undefined && !OPTIONAL_END_TAG.has(el.tag)) {
      record("unclosed-element", eofPos, el.tag);
    }
  }

  synthesizeDocumentStructure(root, nodes);

  return freezeTree(root.id, nodes);
}

/** Elements that belong in `<head>` when they appear before body content. */
const HEAD_ELEMENTS: ReadonlySet<string> = new Set([
  "base",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

/**
 * Normalize the finished tree to the HTML5 document outline: every document
 * ends up as document → html → [head?, body?], exactly what the "in head"/
 * "in body" insertion modes build for a browser. Documents that already spell
 * out their structure are untouched except for misplaced siblings (moved to
 * `<body>`); documents written without the wrapper get it synthesized, so
 * `document.body` / `document.head` exist everywhere.
 */
function synthesizeDocumentStructure(root: MutableNode, nodes: MutableNode[]): void {
  // `parent` is readonly in the IR-facing type; synthesis owns the tree until
  // it freezes, so re-parenting goes through this writable view.
  const mutableParent = (node: MutableNode): { parent: NodeId | null } => node;
  const detach = (node: MutableNode): void => {
    const parent = node.parent !== null ? nodes[node.parent] : undefined;
    if (parent === undefined) return;
    const index = parent.children.indexOf(node.id);
    if (index !== -1) parent.children.splice(index, 1);
  };
  const appendNode = (parent: MutableNode, node: MutableNode): void => {
    detach(node);
    mutableParent(node).parent = parent.id;
    parent.children.push(node.id);
  };
  const createElement = (tag: string, parent: MutableNode): MutableNode => {
    const node: MutableNode = { id: nodeId(nodes.length), kind: "element", tag, children: [], parent: parent.id };
    nodes.push(node);
    parent.children.push(node.id);
    return node;
  };

  const rootChildren = root.children.map((id) => nodes[id] as MutableNode);
  let html = rootChildren.find((n) => n.kind === "element" && n.tag === "html");

  // Content found directly under `document`: head-eligible elements move to
  // head, everything else to body. Comments stay where they are.
  const toHead: MutableNode[] = [];
  const toBody: MutableNode[] = [];
  for (const child of rootChildren) {
    if (child === html || child.kind === "comment") continue;
    if (child.kind === "element" && child.tag !== undefined && HEAD_ELEMENTS.has(child.tag)) toHead.push(child);
    else toBody.push(child);
  }

  if (html === undefined) {
    html = { id: nodeId(nodes.length), kind: "element", tag: "html", children: [], parent: root.id };
    nodes.push(html);
    // Keep leading document-level comments ahead of the synthesized root.
    root.children.push(html.id);
  }

  const htmlChildren = html.children.map((id) => nodes[id] as MutableNode);
  let head = htmlChildren.find((n) => n.kind === "element" && n.tag === "head");
  let body = htmlChildren.find((n) => n.kind === "element" && n.tag === "body");
  if (head === undefined) {
    head = createElement("head", html);
    html.children.splice(html.children.indexOf(head.id), 1);
    html.children.unshift(head.id); // head precedes body (and stray content).
  }
  if (body === undefined) {
    body = createElement("body", html);
  }
  // Malformed strays directly under <html> belong in body.
  for (const stray of htmlChildren) {
    if (stray !== head && stray !== body && stray.kind !== "comment") appendNode(body, stray);
  }

  for (const node of toHead) appendNode(head, node);
  for (const node of toBody) appendNode(body, node);

  // Moving nodes can make previously-separated text nodes adjacent (e.g. text
  // split around a comment that stays behind). Browsers merge adjacent text
  // nodes; do the same so parse → print → parse stays a fixed point.
  const mergeAdjacentTextIn = (parent: MutableNode): void => {
    const kept: NodeId[] = [];
    for (const childId of parent.children) {
      const child = nodes[childId];
      if (child === undefined) continue;
      const prevId = kept.length > 0 ? kept[kept.length - 1] : undefined;
      const prev = prevId !== undefined ? nodes[prevId] : undefined;
      if (child.kind === "text" && prev !== undefined && prev.kind === "text") {
        (prev as { text?: string }).text = (prev.text ?? "") + (child.text ?? "");
        continue; // the duplicate id is dropped entirely.
      }
      kept.push(childId);
    }
    parent.children.splice(0, parent.children.length, ...kept);
  };
  mergeAdjacentTextIn(head);
  mergeAdjacentTextIn(body);
}

// ---------------------------------------------------------------------------
// Entity decoding — the small, common subset needed for static documents.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
  ["copy", "\u00a9"],
  ["reg", "\u00ae"],
  ["trade", "\u2122"],
  ["hellip", "\u2026"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
]);

/**
 * Decode the HTML character references that appear in static documents: the
 * core named entities plus a small common set, and numeric references
 * (`&#NN;` / `&#xHH;`). Unknown references are left verbatim (HTML's lenient
 * behaviour for an unrecognised reference).
 */
function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;

  let out = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (ch !== "&") {
      out += ch;
      i += 1;
      continue;
    }

    const semi = input.indexOf(";", i + 1);
    if (semi === -1 || semi - i > 32) {
      out += "&";
      i += 1;
      continue;
    }

    const body = input.slice(i + 1, semi);
    let replacement: string | null = null;

    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (Number.isFinite(code) && code > 0) replacement = safeFromCodePoint(code);
    } else if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0) replacement = safeFromCodePoint(code);
    } else {
      replacement = NAMED_ENTITIES.get(body) ?? null;
    }

    if (replacement === null) {
      out += "&";
      i += 1;
    } else {
      out += replacement;
      i = semi + 1;
    }
  }

  return out;
}

/** `String.fromCodePoint` guarded against invalid code points. */
function safeFromCodePoint(code: number): string | null {
  if (code > 0x10ffff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Freeze: materialise the mutable scaffolding into the frozen, branded IR.
// ---------------------------------------------------------------------------

function freezeTree(root: NodeId, mutable: readonly MutableNode[]): DomTree {
  const nodes = new Map<NodeId, DomNode>();

  for (const n of mutable) {
    let node: DomNode;
    if (n.kind === "element") {
      node = {
        id: n.id,
        kind: "element",
        tag: n.tag ?? "",
        attrs: n.attrs ?? new Map<string, string>(),
        children: n.children,
        parent: n.parent,
      };
    } else if (n.kind === "text" || n.kind === "comment") {
      node = {
        id: n.id,
        kind: n.kind,
        text: n.text ?? "",
        children: n.children,
        parent: n.parent,
      };
    } else {
      node = {
        id: n.id,
        kind: n.kind,
        children: n.children,
        parent: n.parent,
      };
    }
    nodes.set(n.id, node);
  }

  const tree = { root, nodes } as unknown as DomTree;
  return deepFreeze(tree);
}
