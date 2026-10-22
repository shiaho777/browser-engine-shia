/**
 * frame-dom-facade.ts — a DOM-backed read facade for `iframe.contentDocument`
 * on SAME-ORIGIN children that have no script runtime (scriptless sandbox,
 * `noscript`, or a document that never booted JS).
 *
 * Real browsers expose the child's live Document either way; our realm
 * document object only exists when a VM sandbox booted. This facade answers
 * the common read surface — `documentElement`/`body`/`title`/`URL`,
 * `getElementById`, `querySelector(All)` (backed by the cascade's real
 * selector matcher), `getElementsByTagName/ClassName`, `textContent`,
 * attributes, `children`/`parentElement`, `matches`/`closest` — over the
 * child's committed DomTree. Mutations are honest no-shows: no DOM-0 write
 * API (`setAttribute`, `innerHTML`...) is fabricated — callers see a
 * read-only view, which is still strictly better than `null` (which is what
 * cross-origin callers get per spec).
 */

import { ruleMatches } from "@browser-engine/cascade";
import type { DomTree, NodeId, StyleRule } from "@browser-engine/ir";

function textContent(dom: DomTree, id: NodeId): string {
  const node = dom.nodes.get(id);
  if (node === undefined) return "";
  if (node.kind === "text" || node.kind === "comment") return node.text ?? "";
  let out = "";
  for (const childId of node.children) {
    const child = dom.nodes.get(childId);
    if (child !== undefined && child.kind !== "comment") out += textContent(dom, childId);
  }
  return out;
}

export function domFacadeDocument(
  dom: DomTree,
  url: string,
  title: string,
): Record<string, unknown> {
  const elementCache = new Map<NodeId, Record<string, unknown>>();

  const isElement = (id: NodeId): boolean => dom.nodes.get(id)?.kind === "element";

  const ruleMatchesSafe = (rule: StyleRule, id: NodeId): boolean => {
    try {
      return ruleMatches(rule, dom, id);
    } catch {
      return false;
    }
  };

  const probeFor = (selector: string): ((id: NodeId) => boolean) => {
    const trimmed = selector.trim();
    if (trimmed === "") return () => false;
    if (trimmed === "*") return () => true;
    if (/^#[\w:-]+$/.test(trimmed)) {
      const want = trimmed.slice(1);
      return (id) => dom.nodes.get(id)?.attrs?.get("id") === want;
    }
    const rule: StyleRule = {
      selector: [{ text: trimmed }],
      declarations: [],
      specificity: [0, 0, 0],
      order: 0,
    };
    return (id) => ruleMatchesSafe(rule, id);
  };

  const matchesSelector = (id: NodeId, selector: string): boolean =>
    isElement(id) && probeFor(selector)(id);

  const queryAll = (selector: string, scopeRoot: NodeId | null): NodeId[] => {
    const probe = probeFor(selector);
    const out: NodeId[] = [];
    const visit = (id: NodeId, includeSelf: boolean): void => {
      const node = dom.nodes.get(id);
      if (node === undefined) return;
      if (includeSelf && node.kind === "element" && probe(id)) out.push(id);
      for (const child of node.children) visit(child, true);
    };
    visit(scopeRoot ?? dom.root, scopeRoot === null);
    // Document-scope queries never return the root container itself.
    return scopeRoot === null ? out.filter((id) => id !== dom.root) : out;
  };

  const findById = (want: string): NodeId | null =>
    queryAll("*", null).find((id) => dom.nodes.get(id)?.attrs?.get("id") === want) ?? null;

  const firstElementByTagName = (tag: string): NodeId | null =>
    queryAll("*", null).find((id) => dom.nodes.get(id)?.tag === tag) ?? null;

  const element = (id: NodeId): Record<string, unknown> | null => {
    if (!isElement(id)) return null;
    const hit = elementCache.get(id);
    if (hit !== undefined) return hit;
    const node = dom.nodes.get(id)!;
    const children = () =>
      node.children.filter((c) => isElement(c)).map((c) => element(c)!);
    const el: Record<string, unknown> = {
      get tagName(): string {
        return (node.tag ?? "").toUpperCase();
      },
      get localName(): string {
        return node.tag ?? "";
      },
      get id(): string {
        return node.attrs?.get("id") ?? "";
      },
      get className(): string {
        return node.attrs?.get("class") ?? "";
      },
      get nodeType(): number {
        return 1;
      },
      get textContent(): string {
        return textContent(dom, id);
      },
      get innerText(): string {
        return textContent(dom, id);
      },
      getAttribute: (name: unknown): string | null =>
        node.attrs?.get(String(name)) ?? null,
      hasAttribute: (name: unknown): boolean => node.attrs?.has(String(name)) ?? false,
      getElementsByTagName: (tag: unknown): object[] => {
        const want = String(tag).toLowerCase();
        return queryAll("*", id)
          .filter((c) => want === "*" || dom.nodes.get(c)?.tag === want)
          .map((c) => element(c)!);
      },
      getElementsByClassName: (names: unknown): object[] => {
        const tokens = String(names).trim().split(/\s+/).filter(Boolean);
        return queryAll("*", id)
          .filter((c) => {
            const have = new Set(
              (dom.nodes.get(c)?.attrs?.get("class") ?? "").split(/\s+/).filter(Boolean),
            );
            return tokens.every((t) => have.has(t));
          })
          .map((c) => element(c)!);
      },
      querySelector: (sel: unknown): object | null => {
        const ids = queryAll(String(sel), id);
        return ids.length > 0 ? element(ids[0]!) : null;
      },
      querySelectorAll: (sel: unknown): object[] =>
        queryAll(String(sel), id).map((c) => element(c)!),
      matches: (sel: unknown): boolean => matchesSelector(id, String(sel)),
      closest: (sel: unknown): object | null => {
        let cur: NodeId | null = id;
        while (cur !== null) {
          if (matchesSelector(cur, String(sel))) return element(cur);
          cur = dom.nodes.get(cur)?.parent ?? null;
        }
        return null;
      },
      get children(): object[] {
        return children();
      },
      get childElementCount(): number {
        return children().length;
      },
      get parentElement(): object | null {
        const p = node.parent;
        return p !== null && isElement(p) ? element(p) : null;
      },
      get firstElementChild(): object | null {
        return children()[0] ?? null;
      },
      get lastElementChild(): object | null {
        const c = children();
        return c[c.length - 1] ?? null;
      },
      // The cache makes `el === el` hold for the same node (platform identity).
    };
    elementCache.set(id, el);
    return el;
  };

  const rootElementId = (() => {
    const root = dom.nodes.get(dom.root);
    if (root !== undefined && root.kind === "element") return dom.root;
    for (const c of root?.children ?? []) {
      if (isElement(c)) return c;
    }
    return null;
  })();

  return {
    nodeType: 9,
    get URL(): string {
      return url;
    },
    get documentURI(): string {
      return url;
    },
    get title(): string {
      return title;
    },
    get readyState(): string {
      return "complete";
    },
    get compatMode(): string {
      return "CSS1Compat";
    },
    get cookie(): string {
      return ""; // scriptless documents expose no cookie jar to readers
    },
    get referrer(): string {
      return "";
    },
    get documentElement(): object | null {
      return rootElementId !== null ? element(rootElementId) : null;
    },
    get head(): object | null {
      const id = firstElementByTagName("head");
      return id !== null ? element(id) : null;
    },
    get body(): object | null {
      const id = firstElementByTagName("body");
      return id !== null ? element(id) : null;
    },
    getElementById: (want: unknown): object | null => {
      const id = findById(String(want));
      return id !== null ? element(id) : null;
    },
    querySelector: (sel: unknown): object | null => {
      const ids = queryAll(String(sel), null);
      return ids.length > 0 ? element(ids[0]!) : null;
    },
    querySelectorAll: (sel: unknown): object[] =>
      queryAll(String(sel), null).map((c) => element(c)!),
    getElementsByTagName: (tag: unknown): object[] => {
      const want = String(tag).toLowerCase();
      return queryAll("*", null)
        .filter((c) => want === "*" || dom.nodes.get(c)?.tag === want)
        .map((c) => element(c)!);
    },
    getElementsByClassName: (names: unknown): object[] => {
      const tokens = String(names).trim().split(/\s+/).filter(Boolean);
      return queryAll("*", null)
        .filter((c) => {
          const have = new Set(
            (dom.nodes.get(c)?.attrs?.get("class") ?? "").split(/\s+/).filter(Boolean),
          );
          return tokens.every((t) => have.has(t));
        })
        .map((c) => element(c)!);
    },
  };
}
