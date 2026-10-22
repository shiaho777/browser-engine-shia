/**
 * An about:blank iframe document whose media viewport is the iframe element's
 * CSS width and height. `matchMedia` reads that size live. Resize and media
 * change listeners run on the next animation frame, resize first.
 */
import { createLiveMatchMedia, type MediaQueryListLike } from "./match-media.js";

export interface BlankFrame {
  readonly window: BlankFrameWindow;
  viewportChanged(): void;
}

export interface BlankFrameWindow {
  readonly document: BlankFrameDocument;
  matchMedia(query: unknown): MediaQueryListLike;
  addEventListener(type: unknown, fn: unknown): void;
  removeEventListener(type: unknown, fn: unknown): void;
}

interface BlankFrameDocument {
  body: { innerHTML: string };
  querySelector(selector: unknown): object | null;
}

interface FragmentNode {
  readonly tag: string;
  readonly children: FragmentNode[];
}

export function createBlankFrame(options: {
  viewport: () => { readonly width: number; readonly height: number };
  scheduleFrame: (cb: () => void) => void;
}): BlankFrame {
  const resize = new Set<(event: { readonly type: "resize" }) => void>();
  const live = createLiveMatchMedia(
    () => {
      const size = options.viewport();
      return { type: "screen", widthPx: size.width, heightPx: size.height };
    },
    (flush) => {
      options.scheduleFrame(() => {
        for (const fn of resize) fn({ type: "resize" });
        flush();
      });
    },
  );
  let roots: FragmentNode[] = [];
  const document: BlankFrameDocument = {
    body: {
      get innerHTML() {
        return "";
      },
      set innerHTML(html: string) {
        roots = fragmentNodes(html);
      },
    },
    querySelector(selector: unknown) {
      const tag = typeof selector === "string" ? selector.trim().toLowerCase() : "";
      const found = tag === "" ? undefined : findTag(roots, tag);
      if (found === undefined) return null;
      return {
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      };
    },
  };
  const window: BlankFrameWindow = {
    document,
    matchMedia: (query) => live.matchMedia(query),
    addEventListener(type, fn) {
      if (type === "resize" && typeof fn === "function") resize.add(fn as (event: { readonly type: "resize" }) => void);
    },
    removeEventListener(type, fn) {
      if (type === "resize") resize.delete(fn as (event: { readonly type: "resize" }) => void);
    },
  };
  return { window, viewportChanged: () => live.viewportChanged() };
}

function fragmentNodes(html: string): FragmentNode[] {
  const roots: FragmentNode[] = [];
  const stack: FragmentNode[] = [];
  const re = /<\/?([a-zA-Z][\w:-]*)[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const closing = match[0].startsWith("</");
    const tag = (match[1] ?? "").toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    const node: FragmentNode = { tag, children: [] };
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    if (!match[0].endsWith("/>")) stack.push(node);
  }
  return roots;
}

function findTag(nodes: readonly FragmentNode[], tag: string): FragmentNode | undefined {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    const child = findTag(node.children, tag);
    if (child !== undefined) return child;
  }
  return undefined;
}
