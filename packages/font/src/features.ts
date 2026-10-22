/**
 * `features.ts` — CSS font micro-syntax → HarfBuzz arguments (RFC 0005).
 *
 * Every parser here turns a *computed style string* (`font-family`,
 * `font-feature-settings`, `font-variation-settings`, `font-kerning`,
 * `font-variant`, `font-variant-numeric`, `font-optical-sizing`,
 * `font-stretch`) into the data the shaper consumes: family name lists,
 * OpenType feature specs, and variation axis values. The layout stage copies
 * the raw strings onto `ShapingFont.css`; INTERPRETING them lives here —
 * inside the font boundary.
 */

/** One OpenType feature request, in HarfBuzz `hb_feature_t` terms. */
export interface FontFeatureSpec {
  readonly tag: string;
  readonly value: number;
}

/** One variation-axis setting (`font-variation-settings` entry). */
export interface FontVariation {
  readonly tag: string;
  readonly value: number;
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** True when `name` is a CSS generic family keyword (never a real font name). */
export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase());
}

/**
 * Parse a `font-family` value into the ordered name list. Quoted names keep
 * their inner spaces; unquoted names are whitespace-folded and lowercased for
 * case-insensitive matching (CSS: family names match case-insensitively).
 * Generic keywords come through as themselves (lowercased).
 */
export function parseFontFamilyList(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    const quoted = item.match(/^(['"])(.*)\1$/s);
    if (quoted !== null) {
      const inner = (quoted[2] ?? "").trim();
      if (inner !== "") out.push(inner.toLowerCase());
      continue;
    }
    const folded = item.replace(/\s+/g, " ").trim().toLowerCase();
    if (folded !== "") out.push(folded);
  }
  return out;
}

/**
 * Parse `font-feature-settings`: `"tag" <integer|on|off>` comma entries.
 * `normal`/empty → []. Invalid entries are dropped (CSS discards the
 * declaration at parse time in a real cascade; our string property arrives
 * unvalidated, so this is the validation point — a malformed *list* drops
 * that entry, never silently reshapes the whole value).
 */
export function parseFontFeatureSettings(value: string): FontFeatureSpec[] {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "normal") return [];
  const out: FontFeatureSpec[] = [];
  for (const raw of value.split(",")) {
    const m = raw.trim().match(/^(['"])([a-z0-9]{1,4})\1\s*([-+]?\d+|on|off)?$/i);
    if (m === null) continue;
    const tag = (m[2] ?? "").toLowerCase();
    const v = (m[3] ?? "on").toLowerCase();
    const num = v === "on" ? 1 : v === "off" ? 0 : Number.parseInt(v, 10);
    if (Number.isNaN(num) || num < 0) continue;
    out.push({ tag, value: num });
  }
  return out;
}

/** `font-variant-numeric` keyword → the OpenType feature tag it enables. */
const NUMERIC_FEATURES: Readonly<Record<string, string>> = {
  "lining-nums": "lnum",
  "oldstyle-nums": "onum",
  "proportional-nums": "pnum",
  "tabular-nums": "tnum",
  "diagonal-fractions": "frac",
  "stacked-fractions": "afrc",
  ordinal: "ordn",
  "slashed-zero": "zero",
};

/** `font-variant`/`font-variant-caps` keyword → tag (we carry the shorthand). */
const CAPS_FEATURES: Readonly<Record<string, string[]>> = {
  "small-caps": ["smcp"],
  "all-small-caps": ["smcp", "c2sc"],
  "petite-caps": ["pcap"],
  "all-petite-caps": ["pcap", "c2pc"],
  unicase: ["unic"],
  "titling-caps": ["titl"],
};

/** `font-variant-ligatures` keyword → `[tag, value]` pairs (RFC 0006). */
const LIGATURE_FEATURES: Readonly<Record<string, readonly (readonly [string, number])[]>> = {
  "common-ligatures": [["liga", 1], ["clig", 1]],
  "no-common-ligatures": [["liga", 0], ["clig", 0]],
  "discretionary-ligatures": [["dlig", 1]],
  "no-discretionary-ligatures": [["dlig", 0]],
  "historical-ligatures": [["hlig", 1]],
  "no-historical-ligatures": [["hlig", 0]],
  contextual: [["calt", 1]],
  "no-contextual": [["calt", 0]],
};

/** `font-variant-position` keyword → tag. */
const POSITION_FEATURES: Readonly<Record<string, string>> = {
  sub: "subs",
  sup: "sups",
};

/** `font-variant-east-asian` keyword → tag. */
const EAST_ASIAN_FEATURES: Readonly<Record<string, string>> = {
  jis78: "jp78",
  jis83: "jp83",
  jis90: "jp90",
  jis04: "jp04",
  simplified: "smpl",
  traditional: "trad",
  "full-width": "fwid",
  "proportional-width": "pwid",
  ruby: "ruby",
};

/**
 * `font-variant-alternates` → hb features (CSS Fonts §6.10). Functional
 * notations name one or more feature lookups: `stylistic(N)`/`styleset(…)`
 * select `ssNN`; `character-variant(N)` selects `cvNN`; `swash`/`ornaments`/
 * `annotation` carry their integer as the feature VALUE. `historical-forms`
 * maps to `hist`.
 */
function parseAlternates(value: string): FontFeatureSpec[] {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "normal") return [];
  const out: FontFeatureSpec[] = [];
  // Functional values may contain ", " — collapse whitespace inside parens
  // first so `styleset(1, 4)` survives as one token.
  const compact = v.replace(/\(\s*/g, "(").replace(/\s*\)/g, ")").replace(/,\s*/g, ",");
  for (const token of compact.split(/\s+/).filter((t) => t !== "")) {
    if (token === "historical-forms") { out.push({ tag: "hist", value: 1 }); continue; }
    const m = /^([a-z-]+)\(([\d,\s]+)\)$/.exec(token);
    if (m === null) continue;
    const fn = m[1] ?? "";
    const args = (m[2] ?? "").split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    const ssTag = (n: number): string | null =>
      n >= 1 && n <= 99 ? `ss${String(n).padStart(2, "0")}` : null;
    const cvTag = (n: number): string | null =>
      n >= 1 && n <= 99 ? `cv${String(n).padStart(2, "0")}` : null;
    for (const n of args) {
      switch (fn) {
        case "stylistic": { const t = ssTag(n); if (t !== null) out.push({ tag: t, value: 1 }); break; }
        case "styleset": { const t = ssTag(n); if (t !== null) out.push({ tag: t, value: 1 }); break; }
        case "character-variant": { const t = cvTag(n); if (t !== null) out.push({ tag: t, value: 1 }); break; }
        case "swash": out.push({ tag: "swsh", value: n }); break;
        case "ornaments": out.push({ tag: "ornm", value: n }); break;
        case "annotation": out.push({ tag: "nalt", value: n }); break;
        default: break;
      }
    }
  }
  return out;
}

export interface CssFeatureInput {
  readonly kerning?: string; // font-kerning: auto|normal|none
  readonly variantLigatures?: string; // font-variant-ligatures keyword list
  readonly variantCaps?: string; // font-variant-caps keyword
  readonly variantPosition?: string; // font-variant-position keyword
  readonly variantEastAsian?: string; // font-variant-east-asian keyword list
  readonly variantAlternates?: string; // font-variant-alternates
  readonly variantNumeric?: string; // font-variant-numeric keyword list
  readonly featureSettings?: string; // font-feature-settings
}

/**
 * Fold the CSS font-feature properties into one ordered `FontFeatureSpec`
 * list. Order matters: shorthand-derived features (`font-kerning`,
 * `font-variant*`) are added FIRST, `font-feature-settings` LAST — per CSS
 * Fonts §7 the explicit settings override the shorthand-derived ones, and
 * HarfBuzz applies the array in order.
 */
export function cssFontFeatures(input: CssFeatureInput): FontFeatureSpec[] {
  const out: FontFeatureSpec[] = [];
  const seen = new Map<string, number>();
  const push = (tag: string, value: number): void => {
    if (seen.has(tag)) return; // first claim wins within the shorthand layer
    seen.set(tag, value);
    out.push({ tag, value });
  };
  if ((input.kerning ?? "auto").trim().toLowerCase() === "none") push("kern", 0);
  // CSS Fonts §7: all font-variant-* features precede font-feature-settings.
  const ligatures = (input.variantLigatures ?? "normal").trim().toLowerCase();
  if (ligatures === "none") {
    // CSS Fonts §6.11: `none` disables every ligature-related feature,
    // contextual alternates included.
    push("liga", 0); push("clig", 0); push("dlig", 0); push("hlig", 0); push("calt", 0);
  } else {
    for (const token of ligatures.split(/\s+/)) {
      for (const [tag, value] of LIGATURE_FEATURES[token] ?? []) push(tag, value);
    }
  }
  for (const token of (input.variantCaps ?? "normal").trim().toLowerCase().split(/\s+/)) {
    for (const tag of CAPS_FEATURES[token] ?? []) push(tag, 1);
  }
  const positionTag = POSITION_FEATURES[(input.variantPosition ?? "normal").trim().toLowerCase()];
  if (positionTag !== undefined) push(positionTag, 1);
  const numeric = (input.variantNumeric ?? "normal").trim().toLowerCase();
  for (const token of numeric.split(/\s+/)) {
    const tag = NUMERIC_FEATURES[token];
    if (tag !== undefined) push(tag, 1);
  }
  const eastAsian = (input.variantEastAsian ?? "normal").trim().toLowerCase();
  for (const token of eastAsian.split(/\s+/)) {
    const tag = EAST_ASIAN_FEATURES[token];
    if (tag !== undefined) push(tag, 1);
  }
  for (const spec of parseAlternates(input.variantAlternates ?? "normal")) {
    push(spec.tag, spec.value);
  }
  // font-feature-settings override anything the shorthand layer claimed.
  for (const spec of parseFontFeatureSettings(input.featureSettings ?? "")) {
    const idx = out.findIndex((f) => f.tag === spec.tag);
    if (idx >= 0) out.splice(idx, 1);
    out.push(spec);
  }
  return out;
}

/**
 * Parse `font-variation-settings`: `"tag" <number>` comma entries.
 * `normal`/empty → []. Tags are 4 chars (unquoted 4-char idents accepted too —
 * some content uses them; CSS requires quotes but tolerates here costs nothing
 * and the tag shape is still validated).
 */
export function parseVariationSettings(value: string): FontVariation[] {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "normal") return [];
  const out: FontVariation[] = [];
  for (const raw of value.split(",")) {
    const m = raw.trim().match(/^(['"])?([a-zA-Z0-9 ]{4})\1\s+([-+]?\d+(?:\.\d+)?)$/);
    if (m === null) continue;
    out.push({ tag: m[2] ?? "", value: Number.parseFloat(m[3] ?? "0") });
  }
  return out;
}

/**
 * `font-stretch` keyword/percentage → the OS/2 `usWidthClass` (1–9) a family
 * match should prefer. Returns `null` for `normal` (no preference).
 */
export function fontStretchWidthClass(value: string): number | null {
  const v = value.trim().toLowerCase();
  const table: Record<string, number> = {
    "ultra-condensed": 1,
    "extra-condensed": 2,
    condensed: 3,
    "semi-condensed": 4,
    normal: 5,
    "semi-expanded": 6,
    expanded: 7,
    "extra-expanded": 8,
    "ultra-expanded": 9,
  };
  if (v in table) return table[v] === 5 ? null : (table[v] ?? null);
  const pct = Number.parseFloat(v);
  if (v.endsWith("%") && !Number.isNaN(pct)) {
    // CSS Fonts: 50%→1, 62.5%→2, 75%→3, 87.5%→4, 100%→5, 112.5%→6, 125%→7, 150%→8, 200%→9.
    const bands = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
    let best = 5;
    let dist = Infinity;
    bands.forEach((b, i) => {
      const d = Math.abs(pct - b);
      if (d < dist) {
        dist = d;
        best = i + 1;
      }
    });
    return best === 5 ? null : best;
  }
  return null;
}
