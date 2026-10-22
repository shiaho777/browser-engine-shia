/**
 * `new CSSStyleSheet()` plus `@custom-media` rules (Media Queries 5).
 *
 * `replaceSync` keeps a rule only when the custom-media header parses. A
 * dashed name and its query must be separated by whitespace (a comment counts).
 * `true` / `false` become booleans; any other query becomes a media list.
 */
import { serializeMediaQueryList } from "@browser-engine/css-parser";

interface CustomMediaQuery {
  length: number;
  mediaText: string;
  appendMedium(medium: unknown): void;
  deleteMedium(medium: unknown): void;
  item(index: unknown): string | null;
}

export function installConstructableStylesheets(sandbox: Record<string, unknown>): void {
  class CSSCustomMediaRule {
    readonly name: string;
    readonly query: boolean | CustomMediaQuery;

    constructor(name: string, query: boolean | CustomMediaQuery) {
      this.name = name;
      this.query = query;
    }
  }

  class CSSStyleSheet {
    #rules: CSSCustomMediaRule[] = [];

    get cssRules(): readonly CSSCustomMediaRule[] {
      return this.#rules.slice();
    }

    replaceSync(text: unknown): void {
      const source = typeof text === "string" ? text : "";
      const parsed = parseCustomMedia(source);
      this.#rules = parsed === null ? [] : [new CSSCustomMediaRule(parsed.name, parsed.query)];
    }
  }

  sandbox["CSSStyleSheet"] = CSSStyleSheet;
  sandbox["CSSCustomMediaRule"] = CSSCustomMediaRule;
}

function parseCustomMedia(source: string): { name: string; query: boolean | CustomMediaQuery } | null {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (text === "") return null;
  const header = /^@custom-media\s+(--[A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (header === null) return null;
  const name = header[1] ?? "";
  const query = parseCustomQuery(header[2]);
  if (name === "" || query === null) return null;
  return { name, query };
}

function parseCustomQuery(rest: string | undefined): boolean | CustomMediaQuery | null {
  const query = (rest ?? "").trim();
  if (query === "") return mediaList("");
  if (query === "true") return true;
  if (query === "false") return false;
  if (query.includes("!") || /^(?:true|false)\b/.test(query)) return null;
  return mediaList(serializeMediaQueryList(query));
}

function mediaList(initial: string): CustomMediaQuery {
  let text = initial;
  const parts = (): string[] => text.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  return {
    get length() {
      return parts().length;
    },
    get mediaText() {
      return text;
    },
    set mediaText(value: string) {
      text = serializeMediaQueryList(value);
    },
    appendMedium(medium: unknown) {
      const mediumText = serializeMediaQueryList(typeof medium === "string" ? medium : "");
      const next = parts();
      if (!next.includes(mediumText)) next.push(mediumText);
      text = next.join(", ");
    },
    deleteMedium(medium: unknown) {
      const mediumText = serializeMediaQueryList(typeof medium === "string" ? medium : "");
      text = parts().filter((part) => part !== mediumText).join(", ");
    },
    item(index: unknown) {
      const at = typeof index === "number" ? index : Number(index);
      return parts()[at] ?? null;
    },
  };
}
