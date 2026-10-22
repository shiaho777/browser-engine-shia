/**
 * form-state.ts — the single source of truth for form-control semantics,
 * shared by the cascade's state pseudo-classes (`:checked`, `:valid`, …)
 * and the script bridge's constraint-validation API (ValidityState,
 * checkValidity). Everything here is a PURE function of the DomTree
 * (attrs + the live `control` override map).
 *
 * Local rules (`local/no-cross-stage-import`): imports IR types only.
 */
import type { DomNode, DomTree, NodeId } from "@browser-engine/ir";

/** The HTML form controls `:enabled`/`:disabled`/`:read-write` apply to. */
export function isFormControl(node: DomNode): boolean {
  return (
    node.tag === "input" ||
    node.tag === "button" ||
    node.tag === "select" ||
    node.tag === "textarea" ||
    node.tag === "option" ||
    node.tag === "fieldset" ||
    node.tag === "optgroup" ||
    node.tag === "output"
  );
}

function attr(node: DomNode, name: string): string | undefined {
  return node.attrs?.get(name);
}

function hasAttr(node: DomNode, name: string): boolean {
  return node.attrs?.has(name) === true;
}

/**
 * "Actually disabled" (HTML §4.10.18.1): the `disabled` attribute, OR a
 * `fieldset[disabled]` ancestor whose FIRST `legend` child does NOT contain
 * the element. Fieldset disabling is inherited through nested fieldsets.
 */
export function controlDisabled(node: DomNode, dom: DomTree): boolean {
  if (hasAttr(node, "disabled")) return true;
  let cur = node.parent;
  const seen = new Set<NodeId>();
  while (cur !== null && cur !== undefined && seen.add(cur)) {
    const anc = dom.nodes.get(cur);
    if (anc === undefined) return false;
    if (anc.tag === "fieldset" && hasAttr(anc, "disabled")) {
      // Exempt: the element is inside the fieldset's FIRST legend child.
      const firstLegend = (anc.children ?? []).find(
        (c) => dom.nodes.get(c)?.tag === "legend",
      );
      if (firstLegend === undefined || !isSelfOrDescendantOf(dom, node.id, firstLegend)) {
        return true;
      }
    }
    cur = anc.parent;
  }
  return false;
}

function isSelfOrDescendantOf(dom: DomTree, id: NodeId, ancestor: NodeId): boolean {
  let cur: NodeId | null | undefined = id;
  const seen = new Set<NodeId>();
  while (cur !== null && cur !== undefined) {
    if (cur === ancestor) return true;
    if (!seen.add(cur)) return false;
    cur = dom.nodes.get(cur)?.parent;
  }
  return false;
}

/**
 * The sanitized `input[type]` (HTML §4.10.5.1): an unrecognized value
 * computes as `text` — mirrors the `input.type` IDL reflection.
 */
export function inputType(node: DomNode): string {
  const raw = (attr(node, "type") ?? "text").toLowerCase().trim();
  return KNOWN_INPUT_TYPES.has(raw) ? raw : "text";
}

const KNOWN_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden", "text", "search", "tel", "url", "email", "password",
  "date", "month", "week", "time", "datetime-local",
  "number", "range", "color", "file",
  "checkbox", "radio",
  "submit", "image", "reset", "button",
]);

/** Text-entry input types that carry an editable string value. */
const TEXT_VALUE_TYPES: ReadonlySet<string> = new Set([
  "text", "search", "tel", "url", "email", "password",
]);
/** Value-as-number-capable input types. */
const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "number", "range", "date", "month", "week", "time", "datetime-local",
]);
/** Types barred from constraint validation (HTML §4.10.21.3). */
const BARRED_TYPES: ReadonlySet<string> = new Set([
  "hidden", "reset", "button",
]);

/** The element's text content concatenated (textarea seed, option label). */
function textOf(dom: DomTree, node: DomNode): string {
  let out = "";
  for (const c of node.children ?? []) {
    const ch = dom.nodes.get(c);
    if (ch === undefined) continue;
    if (ch.kind === "text") out += ch.text ?? "";
    else if (ch.kind === "element") out += textOf(dom, ch);
  }
  return out;
}

/**
 * The live control value (HTML §4.10 — the `value` IDL): the control-state
 * override wins; otherwise `textarea` seeds from text children, `option`
 * from `value`-attr-or-text, `input` from the `value` attribute, `select`
 * from its selected option (first when nothing is selected and not
 * `multiple`).
 */
export function controlValueOf(dom: DomTree, node: DomNode): string {
  const live = dom.control?.get(node.id)?.value;
  if (live !== undefined) return live;
  switch (node.tag) {
    case "textarea":
      return textOf(dom, node);
    case "option":
      return attr(node, "value") ?? textOf(dom, node).trim().replace(/\s+/g, " ");
    case "select": {
      // HTMLSelectElement.value: the FIRST selected option's value; "" when
      // nothing is selected (the submit-time "first option" fallback lives
      // in the form-data construction, not in this getter).
      const options = selectOptions(dom, node);
      const selected = options.find((o) => controlSelected(dom, o));
      return selected === undefined ? "" : controlValueOf(dom, selected);
    }
    case "input": {
      const t = inputType(node);
      if (t === "file") return ""; // no file picker — the list is empty.
      return attr(node, "value") ?? "";
    }
    case "output":
      return textOf(dom, node);
    default:
      return "";
  }
}

/** Live checkedness: control-state override wins, then the attribute. */
export function controlChecked(dom: DomTree, node: DomNode): boolean {
  const live = dom.control?.get(node.id)?.checked;
  if (live !== undefined) return live;
  return hasAttr(node, "checked");
}

/** Live selectedness (option): control-state override, then `selected`. */
export function controlSelected(dom: DomTree, node: DomNode): boolean {
  const live = dom.control?.get(node.id)?.selected;
  if (live !== undefined) return live;
  return hasAttr(node, "selected");
}

/** `:checked` (Selectors §16): checkable inputs' checkedness, options'
 * selectedness. */
export function matchesChecked(dom: DomTree, node: DomNode): boolean {
  if (node.tag === "option") return controlSelected(dom, node);
  if (node.tag === "input") {
    const t = inputType(node);
    return (t === "checkbox" || t === "radio") && controlChecked(dom, node);
  }
  return false;
}

/** The option descendants of a `select`/`datalist` (DOM order). */
export function selectOptions(dom: DomTree, select: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const walk = (id: NodeId): void => {
    const n = dom.nodes.get(id);
    if (n === undefined) return;
    if (n.tag === "option") out.push(n);
    else if (n.tag === "optgroup" || n.tag === "hr") {
      for (const c of n.children ?? []) walk(c);
    } else {
      for (const c of n.children ?? []) walk(c);
    }
  };
  for (const c of select.children ?? []) {
    const n = dom.nodes.get(c);
    if (n?.tag === "datalist") continue; // datalist children aren't options of the select
    walk(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constraint validation (HTML §4.10.21.2)
// ---------------------------------------------------------------------------

/** The ValidityState flag set — same key names as the IDL dictionary. */
export interface ValidityFlags {
  readonly valueMissing: boolean;
  readonly typeMismatch: boolean;
  readonly patternMismatch: boolean;
  readonly tooLong: boolean;
  readonly tooShort: boolean;
  readonly rangeUnderflow: boolean;
  readonly rangeOverflow: boolean;
  readonly stepMismatch: boolean;
  readonly badInput: boolean;
  readonly customError: boolean;
}

const VALID_OK: ValidityFlags = {
  valueMissing: false, typeMismatch: false, patternMismatch: false,
  tooLong: false, tooShort: false, rangeUnderflow: false,
  rangeOverflow: false, stepMismatch: false, badInput: false,
  customError: false,
};

/** Whether the element is a candidate for constraint validation
 * (willValidate — HTML §4.10.21.5): submittable, not disabled, not
 * readonly (for value-based types), not a datalist descendant. */
export function willValidate(dom: DomTree, node: DomNode): boolean {
  const tag = node.tag;
  if (tag !== "input" && tag !== "select" && tag !== "textarea" && tag !== "button" && tag !== "fieldset" && tag !== "output") {
    return false;
  }
  if (controlDisabled(node, dom)) return false;
  if (tag === "input") {
    const t = inputType(node);
    if (BARRED_TYPES.has(t)) return false;
    if (hasAttr(node, "readonly") && TEXT_VALUE_TYPES.has(t)) return false;
  }
  if (tag === "textarea" && hasAttr(node, "readonly")) return false;
  if (tag === "button") return false; // buttons are barred.
  // barred: a control whose ancestor is a datalist.
  let cur = node.parent;
  const seen = new Set<NodeId>();
  while (cur !== null && cur !== undefined && seen.add(cur)) {
    const anc = dom.nodes.get(cur);
    if (anc === undefined) return false;
    if (anc.tag === "datalist") return false;
    cur = anc.parent;
  }
  return true;
}

/** Whether `required` applies to this control type. */
function supportsRequired(node: DomNode): boolean {
  if (node.tag === "select" || node.tag === "textarea") return true;
  if (node.tag !== "input") return false;
  const t = inputType(node);
  return !BARRED_TYPES.has(t) && t !== "image" && t !== "file";
}

/**
 * Compute the ValidityState flags for a control (HTML §4.10.21.2 — the
 * subset this engine's value model supports). `customError` comes from the
 * live control state (`setCustomValidity`).
 */
export function computeValidity(dom: DomTree, node: DomNode): ValidityFlags {
  if (!willValidate(dom, node)) return VALID_OK;
  const live = dom.control?.get(node.id);
  const value = controlValueOf(dom, node);
  const type = node.tag === "input" ? inputType(node) : (node.tag ?? "");
  const flags: Record<keyof ValidityFlags, boolean> = { ...VALID_OK };

  // customError — setCustomValidity.
  flags.customError = (live?.customError ?? "") !== "";

  // valueMissing — required + empty value (checkable: unchecked).
  if (hasAttr(node, "required") && supportsRequired(node)) {
    if (type === "checkbox") {
      flags.valueMissing = !controlChecked(dom, node);
    } else if (type === "radio") {
      // The GROUP is satisfied when any same-name radio in the same form
      // owner is checked (HTML §4.10.5.3.16).
      flags.valueMissing = !radioGroupSatisfied(dom, node);
    } else {
      flags.valueMissing = value === "";
    }
  }

  // typeMismatch — email/url against their type grammars.
  if (value !== "") {
    if (type === "email") flags.typeMismatch = !EMAIL_RE.test(value);
    else if (type === "url") flags.typeMismatch = !isAbsoluteUrl(value);
  }

  // patternMismatch — full-match pattern (anchored both ends, JS 'v' feel).
  const pattern = attr(node, "pattern");
  if (pattern !== undefined && value !== "" && TEXT_VALUE_TYPES.has(type)) {
    flags.patternMismatch = !fullMatch(pattern, value);
  }

  // tooLong / tooShort — minlength/maxlength in code points. A value
  // longer than maxlength is only tooLong when the USER typed it (the
  // attr-seeded default may exceed maxlength legitimately) — we track
  // that as "live value present" (script/user wrote it).
  const codepoints = [...value].length;
  const maxlen = attr(node, "maxlength");
  if (maxlen !== undefined && live?.value !== undefined) {
    const ml = parseInt(maxlen, 10);
    if (Number.isFinite(ml) && ml >= 0 && codepoints > ml) flags.tooLong = true;
  }
  const minlen = attr(node, "minlength");
  if (minlen !== undefined) {
    const ml = parseInt(minlen, 10);
    if (Number.isFinite(ml) && ml >= 0 && value !== "" && codepoints < ml) flags.tooShort = true;
  }

  // Numeric constraints — rangeUnder/Over + stepMismatch + badInput.
  if (NUMERIC_TYPES.has(type) || type === "range") {
    const num = valueAsNumber(type, value);
    if (value !== "" && num === null) {
      flags.badInput = true; // input[type=number] holding unparsable text
    } else if (num !== null) {
      const min = numberAttr(node, "min");
      const max = numberAttr(node, "max");
      if (min !== null && num < min) flags.rangeUnderflow = true;
      if (max !== null && num > max) flags.rangeOverflow = true;
      const step = stepAttr(node, min);
      if (step !== null) {
        const base = min ?? (type === "range" ? 0 : null) ?? 0;
        const steps = (num - base) / step;
        if (Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) > 1e-7) {
          flags.stepMismatch = true;
        }
      }
    }
  }
  return flags;
}

/** The radio group's satisfied state: any checked same-name radio sharing
 * the same form owner (a nameless group is just this radio). */
function radioGroupSatisfied(dom: DomTree, node: DomNode): boolean {
  if (controlChecked(dom, node)) return true;
  const name = attr(node, "name");
  if (name === undefined || name === "") return false;
  const owner = ownerFormOf(dom, node);
  for (const [id, n] of dom.nodes) {
    if (n?.tag !== "input" || inputType(n) !== "radio" || id === node.id) continue;
    if (attr(n, "name") !== name) continue;
    if (ownerFormOf(dom, n) !== owner) continue;
    if (controlChecked(dom, n)) return true;
  }
  return false;
}

/** The control's owning form (`form=` attr wins, then ancestor). */
export function ownerFormOf(dom: DomTree, node: DomNode): NodeId | null {
  const explicit = attr(node, "form");
  if (explicit !== undefined) {
    for (const [id, n] of dom.nodes) {
      if (n?.kind === "element" && n.tag === "form" && attr(n, "id") === explicit) return id;
    }
  }
  let cur = node.parent;
  const seen = new Set<NodeId>();
  while (cur !== null && cur !== undefined && seen.add(cur)) {
    const anc = dom.nodes.get(cur);
    if (anc === undefined) return null;
    if (anc.tag === "form") return cur;
    cur = anc.parent;
  }
  return null;
}

/** Other radios in the same group (same name, same form owner). */
export function radioGroupPeers(dom: DomTree, node: DomNode): NodeId[] {
  const name = attr(node, "name");
  if (name === undefined || name === "") return [];
  const owner = ownerFormOf(dom, node);
  const out: NodeId[] = [];
  for (const [id, n] of dom.nodes) {
    if (n?.tag !== "input" || inputType(n) !== "radio" || id === node.id) continue;
    if (attr(n, "name") !== name) continue;
    if (ownerFormOf(dom, n) !== owner) continue;
    out.push(id);
  }
  return out;
}

// ---- value parsing helpers (shared by validity + valueAsNumber) ----------

/** Parse the control value into its numeric domain: number/range → float;
 * date types → epoch-ms-ish scalars. Returns null when unparseable. */
export function valueAsNumber(type: string, value: string): number | null {
  if (value === "") return null;
  switch (type) {
    case "number":
    case "range": {
      if (!/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(value.trim())) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
      if (m === null) return null;
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(t) ? null : t;
    }
    case "month": {
      const m = /^(\d{4,})-(\d{2})$/.exec(value);
      if (m === null) return null;
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
      return Number.isNaN(t) ? null : t;
    }
    case "time": {
      const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
      if (m === null) return null;
      const ms = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0)) * 1000
        + Number((m[4] ?? "0").padEnd(3, "0"));
      return Number.isFinite(ms) ? ms : null;
    }
    case "week": {
      const m = /^(\d{4,})-W(\d{2})$/.exec(value);
      if (m === null) return null;
      // Week 1 = the week with Jan 4. Milliseconds of Monday.
      const jan4 = Date.UTC(Number(m[1]), 0, 4);
      const dow = (new Date(jan4).getUTCDay() + 6) % 7;
      const w1monday = jan4 - dow * 86400000;
      return w1monday + (Number(m[2]) - 1) * 7 * 86400000;
    }
    case "datetime-local": {
      const m = /^(\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
      if (m === null) return null;
      const t = Date.UTC(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
        Number((m[7] ?? "0").padEnd(3, "0")),
      );
      return Number.isNaN(t) ? null : t;
    }
    default:
      return null;
  }
}

/** `min`/`max` parsed in the control's numeric domain (dates parse ISO). */
function numberAttr(node: DomNode, name: string): number | null {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  const t = inputType(node);
  if (NUMERIC_TYPES.has(t) && t !== "number" && t !== "range") {
    return valueAsNumber(t, raw);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The `step` value: explicit attr or the type's default (1; range also 1;
 * date = 1 day, time = 60s, week = 1 week, month ≈ 1 month-in-ms). */
function stepAttr(node: DomNode, min: number | null): number | null {
  const raw = attr(node, "step");
  if (raw !== undefined) {
    if (raw.toLowerCase() === "any") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      // Invalid step → default per type.
    } else {
      return n * stepScale(inputType(node));
    }
    return defaultStep(inputType(node));
  }
  void min;
  return defaultStep(inputType(node));
}

function defaultStep(type: string): number | null {
  switch (type) {
    case "number": case "range": return 1;
    case "date": return 86400000;
    case "week": return 604800000;
    case "month": return null; // month steps are month-granular — approximated away.
    case "time": case "datetime-local": return 60000;
    default: return null;
  }
}

function stepScale(type: string): number {
  switch (type) {
    case "date": return 86400000;
    case "week": return 604800000;
    case "time": case "datetime-local": return 60000;
    default: return 1;
  }
}

/** Spec-lite email: one @, non-empty labels, dot in the domain (HTML's
 * willful violation regex trimmed to a readable subset). */
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

function isAbsoluteUrl(value: string): boolean {
  try {
     
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** JS-regex full match (pattern attr wraps as `^(?:…)$` per HTML). */
function fullMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, "v").test(value);
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`, "u").test(value);
    } catch {
      return false; // an uncompilable pattern never matches (spec: skipped).
    }
  }
}

// ---------------------------------------------------------------------------
// Pseudo-class deciders (Selectors §15–16 — form/validity state)
// ---------------------------------------------------------------------------

/** `:valid` / `:invalid` — the control passes/suffers constraint validation.
 * `form` elements aggregate their controls. */
export function matchesValid(dom: DomTree, node: DomNode): boolean {
  if (node.tag === "form") {
    return !formHasInvalidControl(dom, node);
  }
  if (!willValidate(dom, node)) return false;
  return isValid(computeValidity(dom, node));
}

export function matchesInvalid(dom: DomTree, node: DomNode): boolean {
  if (node.tag === "form") return formHasInvalidControl(dom, node);
  return willValidate(dom, node) && !isValid(computeValidity(dom, node));
}

function isValid(f: ValidityFlags): boolean {
  return Object.values(f).every((v) => !v);
}

function formHasInvalidControl(dom: DomTree, form: DomNode): boolean {
  for (const [, n] of dom.nodes) {
    if (n === undefined || n.kind !== "element") continue;
    if (ownerFormOf(dom, n) !== form.id) continue;
    if (!willValidate(dom, n)) continue;
    if (!isValid(computeValidity(dom, n))) return true;
  }
  return false;
}

/** `:in-range` / `:out-of-range` — numeric control with min/max bounds. */
export function matchesRange(dom: DomTree, node: DomNode, inside: boolean): boolean {
  if (node.tag !== "input" || !willValidate(dom, node)) return false;
  const t = inputType(node);
  if (!NUMERIC_TYPES.has(t)) return false;
  const bounded =
    numberAttr(node, "min") !== null || numberAttr(node, "max") !== null;
  if (!bounded) return false;
  const f = computeValidity(dom, node);
  if (f.rangeUnderflow || f.rangeOverflow) return !inside;
  return inside && !f.badInput && !f.valueMissing;
}

/** `:default` (Selectors §16.5): the pre-checked checkable input, the
 * pre-selected option, the form's default button (first submit submitter). */
export function matchesDefault(dom: DomTree, node: DomNode): boolean {
  if (node.tag === "option") return hasAttr(node, "selected");
  if (node.tag === "input") {
    const t = inputType(node);
    if ((t === "checkbox" || t === "radio") && hasAttr(node, "checked")) return true;
    if (t === "submit" || t === "image") return isDefaultButton(dom, node);
  }
  if (node.tag === "button") {
    const t = (attr(node, "type") ?? "submit").toLowerCase();
    if (t === "" || t === "submit") return isDefaultButton(dom, node);
  }
  return false;
}

/** The form's default button = the FIRST submit-button submitter in tree
 * order belonging to the control's form (HTML §4.10.20.2). */
function isDefaultButton(dom: DomTree, node: DomNode): boolean {
  const form = ownerFormOf(dom, node);
  if (form === null) return false;
  for (const [id, n] of dom.nodes) {
    if (n?.kind !== "element") continue;
    const isSubmitter =
      (n.tag === "input" && ["submit", "image"].includes(inputType(n))) ||
      (n.tag === "button" && ["", "submit"].includes((attr(n, "type") ?? "submit").toLowerCase()));
    if (!isSubmitter) continue;
    return ownerFormOf(dom, n) === form && id === node.id;
  }
  return false;
}

/** `:indeterminate`: checkbox with the indeterminate flag; a radio GROUP
 * with no checked member; `<progress>` without a value. */
export function matchesIndeterminate(dom: DomTree, node: DomNode): boolean {
  if (node.tag === "progress") return attr(node, "value") === undefined;
  if (node.tag !== "input") return false;
  const t = inputType(node);
  if (t === "checkbox") {
    return dom.control?.get(node.id)?.indeterminate === true;
  }
  if (t === "radio") return !radioGroupSatisfied(dom, node);
  return false;
}

/** `:placeholder-shown`: a text-capable input/textarea carrying
 * `placeholder` whose CURRENT value is empty. */
export function matchesPlaceholderShown(dom: DomTree, node: DomNode): boolean {
  if (node.tag !== "input" && node.tag !== "textarea") return false;
  if ((attr(node, "placeholder") ?? "") === "") return false;
  return controlValueOf(dom, node) === "";
}

/** `:user-valid` / `:user-invalid` — committed (touched) controls only. */
export function matchesUserValidity(dom: DomTree, node: DomNode, wantValid: boolean): boolean {
  if (dom.control?.get(node.id)?.touched !== true) return false;
  if (!willValidate(dom, node)) return false;
  return isValid(computeValidity(dom, node)) === wantValid;
}

/**
 * `:read-write` (Selectors §15.6 + HTML §4.10.18.5): an element is mutable
 * when it is a form control that is neither disabled nor readonly-locked
 * (readonly only locks the types it applies to — checkbox/radio/submit are
 * mutable when enabled), or it is an editing host via `contenteditable`
 * (inherited ancestor state; plaintext-only counts as editable).
 */
export function matchesReadWrite(dom: DomTree, node: DomNode): boolean {
  if (isFormControl(node)) {
    if (controlDisabled(node, dom)) return false;
    if (node.tag === "textarea") return !hasAttr(node, "readonly");
    if (node.tag === "input") {
      const t = inputType(node);
      const readonlyApplies =
        TEXT_VALUE_TYPES.has(t) ||
        t === "date" || t === "month" || t === "week" ||
        t === "time" || t === "datetime-local" || t === "number";
      return !(readonlyApplies && hasAttr(node, "readonly"));
    }
    return true;
  }
  return isContentEditable(dom, node);
}

/** `contenteditable` resolution — inherited; the nearest ancestor's
 * enumerated value governs (`true`/""/`plaintext-only` ⇒ editable). */
function isContentEditable(dom: DomTree, node: DomNode): boolean {
  let cur: NodeId | null | undefined = node.id;
  const seen = new Set<NodeId>();
  while (cur !== null && cur !== undefined) {
    if (!seen.add(cur)) return false;
    const n = dom.nodes.get(cur);
    if (n === undefined) return false;
    if (n.kind === "element") {
      const ce = attr(n, "contenteditable");
      if (ce !== undefined) {
        return ce !== "false" && ce !== "inherit";
      }
    }
    cur = n.parent;
  }
  return false;
}
