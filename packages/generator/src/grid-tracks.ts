/**
 * `grid-template-columns` / `grid-template-rows`.
 *
 * Specified values outside the track-list grammar are rejected. On a grid
 * container, getComputedStyle reads the resolved track list: lengths against
 * the definite size, `repeat()` expanded, adjacent line names merged, and
 * empty `auto-fit` tracks collapsed to 0px.
 */

const RESERVED_LINE = new Set(["auto", "span", "initial", "inherit", "unset", "revert", "revert-layer"]);

type Breadth =
  | { readonly kind: "px"; readonly size: number }
  | { readonly kind: "em"; readonly em: number }
  | { readonly kind: "pct"; readonly pct: number }
  | { readonly kind: "calc"; readonly text: string }
  | { readonly kind: "fr"; readonly fr: number }
  | { readonly kind: "auto" }
  | { readonly kind: "min" }
  | { readonly kind: "max" };

interface Track {
  readonly min: Breadth;
  readonly max: Breadth;
  readonly fit: Breadth | null;
}

interface Slot {
  names: string[];
  track: Track;
  fitCollapse: boolean;
}

function lex(input: string): string[] | null {
  const out: string[] = [];
  const s = input.trim();
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "[") {
      const close = s.indexOf("]", i);
      if (close < 0) return null;
      const inner = s.slice(i + 1, close).trim().replace(/\s+/g, " ");
      const names = inner === "" ? [] : inner.split(" ");
      if (names.some((name) => RESERVED_LINE.has(name.toLowerCase()) || /^-?\d/.test(name))) return null;
      out.push(inner === "" ? "[]" : `[${inner}]`);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!) && s[j] !== "[") {
      if (s[j] === "(") {
        let depth = 1;
        j += 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "(") depth += 1;
          else if (s[j] === ")") depth -= 1;
          j += 1;
        }
        if (depth !== 0) return null;
        break;
      }
      j += 1;
    }
    if (j === i) return null;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function fnArgs(token: string, name: string): string | null {
  const head = `${name}(`;
  if (!token.toLowerCase().startsWith(head) || !token.endsWith(")")) return null;
  return token.slice(head.length, -1).trim();
}

function splitComma(args: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]!;
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
  }
  return null;
}

function parseBreadth(token: string, flexible: boolean): Breadth | null {
  const lower = token.toLowerCase();
  if (lower === "auto") return { kind: "auto" };
  if (lower === "min-content") return { kind: "min" };
  if (lower === "max-content") return { kind: "max" };
  // A bare zero is a length. Any other unitless number is not.
  if (/^[+]?(?:0+(?:\.0+)?|\.0+)$/.test(token)) return { kind: "px", size: 0 };
  if (/^-/.test(token) && !/^calc\(/i.test(token)) return null;
  if (/^calc\(/i.test(token)) return { kind: "calc", text: token };
  const px = /^(\d+(?:\.\d+)?)px$/i.exec(token);
  if (px !== null) return { kind: "px", size: Number(px[1]) };
  const em = /^(\d+(?:\.\d+)?)em$/i.exec(token);
  if (em !== null) return { kind: "em", em: Number(em[1]) };
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(token);
  if (pct !== null) return { kind: "pct", pct: Number(pct[1]) };
  const fr = /^(\d+(?:\.\d+)?)fr$/i.exec(token);
  if (fr !== null) return flexible ? { kind: "fr", fr: Number(fr[1]) } : null;
  return null;
}

function parseTrack(token: string): Track | null {
  const minmax = fnArgs(token, "minmax");
  if (minmax !== null) {
    const parts = splitComma(minmax);
    if (parts === null) return null;
    const min = parseBreadth(parts[0], false);
    const max = parseBreadth(parts[1], true);
    if (min === null || max === null || min.kind === "fr") return null;
    return { min, max, fit: null };
  }
  const fit = fnArgs(token, "fit-content");
  if (fit !== null) {
    const arg = parseBreadth(fit, false);
    if (arg === null || arg.kind === "auto" || arg.kind === "min" || arg.kind === "max" || arg.kind === "fr") return null;
    return { min: { kind: "auto" }, max: { kind: "auto" }, fit: arg };
  }
  const breadth = parseBreadth(token, true);
  if (breadth === null) return null;
  if (breadth.kind === "fr") return { min: { kind: "auto" }, max: breadth, fit: null };
  if (breadth.kind === "auto" || breadth.kind === "min" || breadth.kind === "max") {
    return { min: breadth, max: breadth, fit: null };
  }
  return { min: breadth, max: breadth, fit: null };
}

function isFixedTrack(track: Track): boolean {
  if (track.fit !== null) return false;
  const length = (breadth: Breadth): boolean =>
    breadth.kind === "px" || breadth.kind === "em" || breadth.kind === "pct" || breadth.kind === "calc";
  if (length(track.min) && (length(track.max) || track.max.kind === "fr" || track.max.kind === "auto")) return true;
  const inflexible = length(track.min) || track.min.kind === "min" || track.min.kind === "max" || track.min.kind === "auto";
  return inflexible && length(track.max);
}

function lineNames(token: string): string[] {
  const inner = token.slice(1, -1).trim();
  return inner === "" ? [] : inner.split(" ");
}

interface Parsed {
  slots: Slot[];
  tail: string[];
}

function parseBody(tokens: readonly string[], allowAuto: boolean): Parsed | null {
  const slots: Slot[] = [];
  let pending: string[] = [];
  let tail: string[] = [];
  let tailFromBracket = false;
  let autos = 0;
  const takePending = (): string[] => {
    const names = pending;
    pending = [];
    tail = [];
    tailFromBracket = false;
    return names;
  };
  for (const token of tokens) {
    if (token.startsWith("[")) {
      const names = lineNames(token);
      if (tailFromBracket) return null;
      if (slots.length === 0 && tail.length === 0) {
        if (pending.length > 0) return null;
        pending = names;
      } else {
        tail = [...tail, ...names];
        pending = [...tail];
        tailFromBracket = true;
      }
      continue;
    }
    const repeat = fnArgs(token, "repeat");
    if (repeat !== null) {
      const parts = splitComma(repeat);
      if (parts === null) return null;
      const count = parts[0].toLowerCase();
      const body = lex(parts[1]);
      if (body === null) return null;
      const inner = parseBody(body, false);
      if (inner === null || inner.slots.length === 0) return null;
      if (count === "auto-fill" || count === "auto-fit") {
        if (!allowAuto || autos > 0) return null;
        if (inner.slots.some((slot) => !isFixedTrack(slot.track))) return null;
        autos += 1;
        const collapse = count === "auto-fit";
        inner.slots.forEach((slot, index) => {
          slots.push({
            names: index === 0 ? [...takePending(), ...slot.names] : [...slot.names],
            track: slot.track,
            fitCollapse: collapse,
          });
        });
        // One copy is stored here; resolveTrackList repeats it to the real count.
        slots[slots.length - inner.slots.length]!.fitCollapse = collapse;
        (slots[slots.length - inner.slots.length] as Slot & { autoCount?: number }).autoCount = inner.slots.length;
        tail = [...inner.tail];
        pending = [...tail];
        continue;
      }
      if (!/^[1-9]\d*$/.test(count)) return null;
      const times = Number(count);
      for (let n = 0; n < times; n += 1) {
        inner.slots.forEach((slot, index) => {
          // Each copy except the first starts with the pattern's trailing names.
          const names = index === 0 ? [...takePending(), ...slot.names] : [...slot.names];
          slots.push({ names, track: slot.track, fitCollapse: false });
        });
        tail = [...inner.tail];
        pending = [...tail];
      }
      continue;
    }
    const track = parseTrack(token);
    if (track === null) return null;
    slots.push({ names: takePending(), track, fitCollapse: false });
  }
  if (slots.length === 0) return null;
  return { slots, tail };
}

const SUBGRID_RESERVED = new Set(["auto", "span", "initial", "inherit", "unset", "revert", "revert-layer", "default"]);

function isSubgridIdent(name: string): boolean {
  if (SUBGRID_RESERVED.has(name.toLowerCase())) return false;
  return /^(?:--|-?[A-Za-z_\u00A0-\uFFFF])[-A-Za-z0-9_\u00A0-\uFFFF]*$/.test(name);
}

/** `subgrid` plus a line-name list. Null when this is not a subgrid value. */
function canonicalSubgrid(value: string): string | null {
  const text = value.trim().replace(/\s+/g, " ");
  if (!/^subgrid(?: |$)/i.test(text)) return null;
  const rest = text.slice("subgrid".length).trim();
  if (rest === "") return "subgrid";
  let i = 0;
  const skip = (): void => {
    while (rest[i] === " ") i += 1;
  };
  const readBracket = (): boolean => {
    if (rest[i] !== "[") return false;
    const close = rest.indexOf("]", i);
    if (close < 0) return false;
    const inner = rest.slice(i + 1, close).trim().replace(/\s+/g, " ");
    if (inner !== "" && inner.split(" ").some((name) => !isSubgridIdent(name))) return false;
    i = close + 1;
    return true;
  };
  const readRepeat = (): boolean => {
    if (!rest.slice(i).toLowerCase().startsWith("repeat(")) return false;
    i += "repeat(".length;
    skip();
    const countStart = i;
    while (i < rest.length && rest[i] !== "," && rest[i] !== " ") i += 1;
    const count = rest.slice(countStart, i).toLowerCase();
    skip();
    if (rest[i] !== ",") return false;
    i += 1;
    if (count !== "auto-fill" && !/^[1-9]\d*$/.test(count)) return false;
    let groups = 0;
    while (i < rest.length && rest[i] !== ")") {
      skip();
      if (rest[i] === ")") break;
      if (!readBracket()) return false;
      groups += 1;
      skip();
    }
    if (rest[i] !== ")" || groups < 1) return false;
    i += 1;
    return true;
  };
  while (i < rest.length) {
    skip();
    if (i >= rest.length) break;
    const ok = rest[i] === "[" ? readBracket() : readRepeat();
    if (!ok) return null;
  }
  return `subgrid ${rest}`;
}

/** Canonical specified value, or null when the track list is invalid. Empty `[]` line names drop out. */
export function canonicalTrackList(value: string): string | null {
  const text = value.trim();
  const subgrid = canonicalSubgrid(text);
  if (subgrid !== null) return subgrid;
  if (!trackListValid(text)) return null;
  if (text.toLowerCase() === "none") return "none";
  // A lone zero is a length. Keep it distinct from the layout sentinel "0".
  if (/^[+]?(?:0+(?:\.0+)?|\.0+)$/.test(text)) return "0px";
  return text
    .replace(/\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+,/g, ",")
    .replace(/,\s+/g, ", ")
    .trim();
}

/** `none` or a `<track-list>` / `<auto-track-list>`. */
export function trackListValid(value: string): boolean {
  const text = value.trim();
  if (text.toLowerCase() === "none") return true;
  const tokens = lex(text);
  if (tokens === null || tokens.length === 0) return false;
  return parseBody(tokens, true) !== null;
}

export interface TrackResolve {
  readonly breadth: number;
  readonly em: number;
  readonly items: number;
  /** The single item's min-content and max-content, when both are that size. */
  readonly content: number;
}

function evalBreadth(breadth: Breadth, opt: TrackResolve): number | null {
  if (breadth.kind === "px") return breadth.size;
  if (breadth.kind === "em") return breadth.em * opt.em;
  if (breadth.kind === "pct") return (breadth.pct / 100) * opt.breadth;
  if (breadth.kind === "calc") {
    const args = breadth.text.slice(5, -1).replace(/\s+/g, "");
    const parts = args.match(/[+-]?(?:\d*\.?\d+)(?:px|em|%)?/gi);
    if (parts === null || parts.join("") !== args.replace(/^\+/, "")) return 0;
    let total = 0;
    for (const part of parts) {
      const match = /^([+-]?)(\d*\.?\d+)(px|em|%)?$/i.exec(part);
      if (match === null) return 0;
      const n = Number(match[2]) * (match[1] === "-" ? -1 : 1);
      const unit = (match[3] ?? "").toLowerCase();
      if (unit === "em") total += n * opt.em;
      else if (unit === "%") total += (n / 100) * opt.breadth;
      else total += n;
    }
    return total;
  }
  return null;
}

function isFixedBreadth(breadth: Breadth): boolean {
  return breadth.kind === "px" || breadth.kind === "em" || breadth.kind === "pct" || breadth.kind === "calc";
}

/** Size used to count auto-fill/fit copies: definite max, otherwise definite min. */
function repeatSize(track: Track, opt: TrackResolve): number {
  const chosen = isFixedBreadth(track.max) ? track.max : isFixedBreadth(track.min) ? track.min : null;
  if (chosen === null) return 0;
  return Math.max(0, evalBreadth(chosen, opt) ?? 0);
}

/** Sum of every track that is not the auto-repeat, using repeat sizes. */
function outsideRepeatSize(tokens: readonly string[], opt: TrackResolve): number {
  let sum = 0;
  for (const token of tokens) {
    if (token.startsWith("[")) continue;
    const repeat = fnArgs(token, "repeat");
    if (repeat !== null) {
      const parts = splitComma(repeat);
      if (parts === null) continue;
      const which = parts[0].toLowerCase();
      if (which === "auto-fill" || which === "auto-fit") continue;
      const times = Number(which);
      const body = lex(parts[1]);
      if (body === null || !Number.isInteger(times)) continue;
      const inner = parseBody(body, false);
      if (inner === null) continue;
      sum += times * inner.slots.reduce((acc, slot) => acc + repeatSize(slot.track, opt), 0);
      continue;
    }
    const track = parseTrack(token);
    if (track !== null) sum += repeatSize(track, opt);
  }
  return sum;
}

function expandAuto(parsed: Parsed, tokens: readonly string[], opt: TrackResolve): Slot[] {
  const autoIndex = tokens.findIndex((token) => /^repeat\(\s*auto-(fill|fit)/i.test(token));
  if (autoIndex < 0) return parsed.slots;
  const token = tokens[autoIndex]!;
  const fit = /auto-fit/i.test(token);
  const args = fnArgs(token, "repeat");
  const parts = args === null ? null : splitComma(args);
  const body = parts === null ? null : lex(parts[1]);
  const inner = body === null ? null : parseBody(body, false);
  if (inner === null) return parsed.slots;
  const patternMin = inner.slots.reduce((sum, slot) => sum + repeatSize(slot.track, opt), 0);
  const fixed = outsideRepeatSize(tokens, opt);
  const available = opt.breadth - fixed;
  const count = patternMin > 0 ? Math.max(1, Math.floor(available / patternMin)) : 1;
  const slots: Slot[] = [];
  let pending: string[] = [];
  let copied = false;
  for (const token of tokens) {
    if (/^repeat\(\s*auto-/i.test(token)) {
      // The single item sits in the first track. An auto-fit copy collapses
      // when that track is not inside it.
      const tracksBefore = slots.length;
      for (let n = 0; n < count; n += 1) {
        const occupiedCopy = opt.items > 0 && tracksBefore === 0 && n === 0;
        inner.slots.forEach((slot, index) => {
          const collapse = fit && !occupiedCopy;
          slots.push({
            names: index === 0 ? [...pending, ...slot.names] : [...slot.names],
            track: slot.track,
            fitCollapse: collapse,
          });
        });
        pending = [...inner.tail];
      }
      copied = true;
      continue;
    }
    const repeated = fnArgs(token, "repeat");
    if (repeated !== null) {
      const parts = splitComma(repeated);
      const times = parts === null ? Number.NaN : Number(parts[0]);
      const body = parts === null ? null : lex(parts[1]);
      const repeatedBody = body === null ? null : parseBody(body, false);
      if (repeatedBody !== null && Number.isInteger(times) && times > 0) {
        for (let n = 0; n < times; n += 1) {
          repeatedBody.slots.forEach((slot, index) => {
            slots.push({
              names: index === 0 ? [...pending, ...slot.names] : [...slot.names],
              track: slot.track,
              fitCollapse: false,
            });
          });
          pending = [...repeatedBody.tail];
        }
      }
      continue;
    }
    if (token.startsWith("[")) {
      pending = [...pending, ...lineNames(token)];
      continue;
    }
    const track = parseTrack(token);
    if (track === null) continue;
    slots.push({ names: pending, track, fitCollapse: false });
    pending = [];
  }
  if (!copied) return parsed.slots;
  // Trailing names after the auto-repeat sit on `pending`.
  return attachTail(slots, pending);
}

function attachTail(slots: Slot[], tail: string[]): Slot[] {
  if (tail.length === 0 || slots.length === 0) return slots;
  const last = slots[slots.length - 1]!;
  slots[slots.length - 1] = { ...last, names: last.names };
  (slots as Array<Slot & { tail?: string[] }>)[slots.length - 1]!.tail = tail;
  return slots;
}

function pxText(n: number): string {
  const rounded = Math.round(Math.max(0, n) * 1000) / 1000;
  return `${rounded}px`;
}

interface Sized {
  base: number;
  growth: number;
  flex: number;
  autoMax: boolean;
}

function definiteBreadth(breadth: Breadth, opt: TrackResolve): number | null {
  if (!isFixedBreadth(breadth)) return null;
  return Math.max(0, evalBreadth(breadth, opt) ?? 0);
}

/**
 * Base size and growth limit after the intrinsic pass.
 * One auto-placed item occupies the first track; `content` is that item's
 * min-content and max-content contribution (they match for these values).
 * An empty intrinsic max collapses to the base size, matching step 5 of the
 * track sizing algorithm. Flexible and `auto` maxima then take leftover space.
 */
function prepareTrack(track: Track, occupied: boolean, opt: TrackResolve): Sized {
  if (track.fit !== null) {
    const limit = Math.max(0, evalBreadth(track.fit, opt) ?? 0);
    let base = 0;
    let growth = Number.POSITIVE_INFINITY;
    if (occupied) {
      base = opt.content;
      growth = Math.min(opt.content, limit);
    }
    if (growth < base) growth = base;
    if (!Number.isFinite(growth)) growth = base;
    return { base, growth, flex: 0, autoMax: false };
  }
  const minFixed = definiteBreadth(track.min, opt);
  const maxFixed = definiteBreadth(track.max, opt);
  let base = minFixed ?? 0;
  let growth = maxFixed ?? Number.POSITIVE_INFINITY;
  if (growth < base) growth = base;
  if (occupied) {
    if (track.min.kind === "auto" || track.min.kind === "min" || track.min.kind === "max") {
      base = Math.max(base, opt.content);
    }
    if (track.max.kind === "min" || track.max.kind === "max" || track.max.kind === "auto") {
      growth = opt.content;
    }
    if (growth < base) growth = base;
  }
  if (!Number.isFinite(growth)) growth = base;
  return {
    base,
    growth,
    flex: track.max.kind === "fr" ? track.max.fr : 0,
    autoMax: track.max.kind === "auto",
  };
}

/** Distribute positive free space equally, freezing a track at its growth limit. */
function applyMaximize(states: Sized[], breadth: number): void {
  let free = breadth - states.reduce((sum, state) => sum + state.base, 0);
  if (free <= 0) return;
  const growable = new Set(states.filter((state) => state.base < state.growth));
  while (free > 1e-6 && growable.size > 0) {
    const share = free / growable.size;
    let consumed = 0;
    const frozen: Sized[] = [];
    for (const state of growable) {
      const add = Math.min(state.growth - state.base, share);
      state.base += add;
      consumed += add;
      if (state.growth - state.base <= 1e-6) frozen.push(state);
    }
    for (const state of frozen) growable.delete(state);
    if (consumed <= 1e-6) break;
    free -= consumed;
  }
}

/** CSS Grid §12.7. Tracks whose fr share is below their base stay inflexible. */
function applyFlex(states: Sized[], breadth: number): void {
  const flexible = new Set<number>();
  states.forEach((state, index) => {
    if (state.flex > 0) flexible.add(index);
  });
  while (flexible.size > 0) {
    let leftover = breadth;
    let factor = 0;
    states.forEach((state, index) => {
      if (flexible.has(index)) factor += state.flex;
      else leftover -= state.base;
    });
    if (factor < 1) factor = 1;
    const fr = leftover / factor;
    let restart = false;
    for (const index of [...flexible]) {
      const state = states[index];
      if (state !== undefined && fr * state.flex < state.base) {
        flexible.delete(index);
        restart = true;
      }
    }
    if (restart) continue;
    for (const index of flexible) {
      const state = states[index];
      if (state === undefined) continue;
      const sized = fr * state.flex;
      if (sized > state.base) state.base = sized;
    }
    return;
  }
}

/** Default `normal` content distribution stretches `auto` maxima into leftover space. */
function applyStretch(states: Sized[], breadth: number): void {
  const free = breadth - states.reduce((sum, state) => sum + state.base, 0);
  if (free <= 0) return;
  const autos = states.filter((state) => state.autoMax);
  if (autos.length === 0) return;
  const share = free / autos.length;
  for (const state of autos) state.base += share;
}

/**
 * Resolved track list. `null` when `value` is not a track list (`none` is
 * resolved by the caller, because an item creates an implicit track).
 */
export function resolveTrackList(value: string, opt: TrackResolve): string | null {
  const text = value.trim();
  if (text.toLowerCase() === "none") return null;
  const tokens = lex(text);
  if (tokens === null) return null;
  const parsed = parseBody(tokens, true);
  if (parsed === null) return null;
  const slots = expandAuto(parsed, tokens, opt);
  const states = slots.map((slot, index) =>
    slot.fitCollapse
      ? { base: 0, growth: 0, flex: 0, autoMax: false }
      : prepareTrack(slot.track, opt.items > 0 && index === 0, opt),
  );
  applyMaximize(states, opt.breadth);
  applyFlex(states, opt.breadth);
  applyStretch(states, opt.breadth);
  const parts: string[] = [];
  slots.forEach((slot, index) => {
    if (slot.names.length > 0) parts.push(`[${slot.names.join(" ")}]`);
    const size = states[index]?.base ?? 0;
    parts.push(pxText(size));
    const tail = (slot as Slot & { tail?: string[] }).tail;
    if (index === slots.length - 1 && tail !== undefined && tail.length > 0) parts.push(`[${tail.join(" ")}]`);
  });
  if (parsed.tail.length > 0 && !parts[parts.length - 1]?.startsWith("[")) {
    parts.push(`[${parsed.tail.join(" ")}]`);
  }
  return parts.join(" ");
}
