/**
 * import-idl.mjs — import Ladybird's WebIDL files into our IDL data-table format.
 *
 * Reads every `.idl` file under `ladybird-master/Libraries/LibWeb/`, parses it
 * with the `webidl2` npm package, and converts interface definitions into the
 * `IdlInterface` shape used by `packages/generator/src/dom-interfaces.idl.ts`.
 *
 * This is a DATA PORT only: it never edits the hand-written table, the
 * emitters, or any exposure-policy code. Its outputs are:
 *
 *   - packages/generator/src/generated/ladybird-idl.data.ts
 *       LADYBIRD_IDL_INTERFACES      — interfaces we do NOT have yet
 *       LADYBIRD_IDL_MEMBER_ADDITIONS — members on interfaces we DO have that
 *                                       Ladybird declares and we lack
 *   - tools/ladybird-import/idl-import-report.json
 *       totals, per-reason skip counts, top-20 member additions.
 *
 * Conflict policy: a Ladybird interface whose name already exists in our
 * `DOM_INTERFACES` table is NEVER replaced; only its incremental members are
 * extracted (LADYBIRD_IDL_MEMBER_ADDITIONS), and then only when the member
 * expresses a DIFFERENT shape than ours (exact-shape matches are recorded as
 * "already-expressed" and dropped).
 *
 * Run from the repo root: `node tools/ladybird-import/import-idl.mjs`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as webidl2 from "webidl2";

import { DOM_INTERFACES } from "../../packages/generator/dist/dom-interfaces.idl.js";

// ---- paths ------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LADYBIRD_IDL_ROOT = path.join(REPO_ROOT, "ladybird-master/Libraries/LibWeb");
const OUTPUT_TS = path.join(REPO_ROOT, "packages/generator/src/generated/ladybird-idl.data.ts");
const OUTPUT_REPORT = path.join(REPO_ROOT, "tools/ladybird-import/idl-import-report.json");

// ---- our vocabulary ----------------------------------------------------------

const PRIMITIVES = new Set([
  "DOMString",
  "boolean",
  "long",
  "unsigned long",
  "unrestricted double",
  "any",
  "void",
]);

/** WebIDL primitive/keyword aliases we fold onto our primitive vocabulary. */
const PRIMITIVE_ALIASES = new Map([
  ["USVString", "DOMString"],
  ["ByteString", "DOMString"],
  ["CSSOMString", "DOMString"],
  ["undefined", "void"],
  ["short", "long"],
  ["unsigned short", "unsigned long"],
  ["long long", "long"],
  ["unsigned long long", "unsigned long"],
  ["byte", "long"],
  ["octet", "unsigned long"],
  ["double", "unrestricted double"],
  ["float", "unrestricted double"],
  ["unrestricted float", "unrestricted double"],
  ["object", "any"],
  ["symbol", "any"],
  ["bigint", "any"],
  ["ArrayBuffer", "any"],
  ["SharedArrayBuffer", "any"],
  ["DataView", "any"],
  ["Int8Array", "any"],
  ["Int16Array", "any"],
  ["Int32Array", "any"],
  ["Uint8Array", "any"],
  ["Uint16Array", "any"],
  ["Uint32Array", "any"],
  ["Uint8ClampedArray", "any"],
  ["Float16Array", "any"],
  ["Float32Array", "any"],
  ["Float64Array", "any"],
  ["BigInt64Array", "any"],
  ["BigUint64Array", "any"],
  ["Function", "any"],
]);

/**
 * typedef name → webidl2 type AST, collected in a first pass so use sites
 * (`GLenum`, `DOMHighResTimeStamp`, ...) resolve to the aliased type. Union /
 * generic targets simply fail conversion and land in the skipped tables.
 */
const typedefTargets = new Map();

/** Track which typedefs actually resolved (for the report). */
const resolvedTypedefs = new Map();

/**
 * Map a webidl2 type AST node to our `IdlType`, or return null when the type
 * uses a WebIDL feature our vocabulary cannot express (promise, union, record,
 * generic other than sequence, ...).
 */
function toIdlType(idlType, seenTypedefs = new Set()) {
  if (idlType === undefined || idlType === null) return null;
  if (Array.isArray(idlType)) return null; // union member list — handled by caller as union
  if (idlType.union) return null;
  if (idlType.generic !== "") {
    // The only generic our vocabulary expresses is sequence<T>.
    if (idlType.generic === "sequence") {
      const inner = Array.isArray(idlType.idlType) ? idlType.idlType[0] : idlType.idlType;
      const element = toIdlType(inner, seenTypedefs);
      if (element === null) return null;
      return { kind: "sequence", element };
    }
    return null; // FrozenArray / ObservableArray / Promise / record — inexpressible
  }
  let raw = typeof idlType.idlType === "string" ? idlType.idlType : null;
  if (raw === null) return null;
  // Resolve typedef alias chains (e.g. GLuint → unsigned long).
  const seen = new Set(seenTypedefs);
  while (
    !PRIMITIVES.has(raw) &&
    !PRIMITIVE_ALIASES.has(raw) &&
    typedefTargets.has(raw) &&
    !seen.has(raw)
  ) {
    seen.add(raw);
    const target = typedefTargets.get(raw);
    if (target.union || target.generic !== "" || typeof target.idlType !== "string") {
      // The alias target itself needs full conversion (sequence / union / ...).
      const resolved = toIdlType(target, seen);
      if (resolved === null) return null;
      resolvedTypedefs.set(raw, typeToSource(target));
      if (!idlType.nullable) return resolved;
      return resolved.kind === "nullable" ? resolved : { kind: "nullable", inner: resolved };
    }
    resolvedTypedefs.set(raw, target.idlType);
    raw = target.idlType;
  }
  let base;
  if (PRIMITIVES.has(raw)) {
    base = raw;
  } else if (PRIMITIVE_ALIASES.has(raw)) {
    base = PRIMITIVE_ALIASES.get(raw);
  } else {
    // Everything else is treated as an interface reference (enum / dictionary /
    // callback names reach here too — the member-conversion layer does not know
    // the symbol tables, so unknown names degrade gracefully to `iface(name)`,
    // which is how the hand-written table treats e.g. init dictionaries).
    base = { kind: "interface", name: raw };
  }
  if (idlType.nullable) return { kind: "nullable", inner: base };
  return base;
}

// ---- member extraction --------------------------------------------------------

const IGNORED_EXTENDED_ATTRIBUTES = new Set([
  "Exposed", "CEReactions", "SameObject", "PutForwards", "Unscopable",
  "Reflect", "ReflectOnly", "LegacyNullToEmptyString", "LegacyLenientSetter",
  "LegacyLenientThis", "LegacyUnforgeable", "LegacyOverrideBuiltIns",
  "SecureContext", "CrossOriginCallable", "Throws", "NewObject",
  "CallWith", "ImplementedAs", "ImplementedInBindings", "DirectGetter",
  "FlyString", "FIXME", "Export", "Experimental", "Clamp", "EnforceRange",
  "LegacyFactoryFunction", "LegacyWindowAlias", "Global", "LegacyPlatformObjectGetOwnProperty",
  "HTMLConstructor", "Serializable", "Transferable", "Cached",
  "WebGLHandlesContextLoss", "AllowShared", "LegacyTreatNonObjectAsNull",
]);

function extAttrNames(member) {
  return (member.extAttrs ?? []).map((a) => a.name);
}

/** True when the member carries an extended attribute that changes its nature. */
function hasBlockingExtAttrs(member) {
  for (const name of extAttrNames(member)) {
    if (!IGNORED_EXTENDED_ATTRIBUTES.has(name)) return true;
  }
  return false;
}

function convertArguments(args) {
  const out = [];
  for (const a of args ?? []) {
    if (a.variadic) return null; // variadic inexpressible
    const t = toIdlType(a.idlType);
    if (t === null) return null;
    out.push({ name: a.name, type: t });
  }
  return out;
}

/**
 * Convert a Ladybird interface member to one of our IdlMembers plus an
 * optional metadata line. Returns null when the member is silently droppable
 * (stringifier); returns { skipReason } when it must be counted as skipped.
 */
function convertMember(member) {
  switch (member.type) {
    case "attribute": {
      if (hasBlockingExtAttrs(member)) return { skipReason: "extended-attribute" };
      if (member.special === "static") return { skipReason: "static-member" };
      const type = toIdlType(member.idlType);
      if (type === null) return { skipReason: "inexpressible-type" };
      return {
        member: { kind: "attribute", name: member.name, type, readonly: Boolean(member.readonly) },
        metaLine: `${member.readonly ? "readonly attribute" : "attribute"} ${typeToSource(member.idlType)} ${member.name};`,
      };
    }
    case "operation": {
      // Regular operations only (special === ""); statics land here too with
      // special "static" — both are worth keeping, statics are skipped per the
      // no-vocabulary rule below.
      if (member.special === "static") return { skipReason: "static-member" };
      if (member.special === "getter" || member.special === "setter" || member.special === "deleter") {
        return { skipReason: `special-operation:${member.special}` };
      }
      if (hasBlockingExtAttrs(member)) return { skipReason: "extended-attribute" };
      if (member.name === undefined) return { skipReason: "unnamed-operation" };
      const returnType = toIdlType(member.idlType);
      if (returnType === null) return { skipReason: "inexpressible-type" };
      const args = convertArguments(member.arguments);
      if (args === null) return { skipReason: "inexpressible-type" };
      const metaSig = `${typeToSource(member.idlType)} ${member.name}(${(member.arguments ?? [])
        .map((a) => `${a.variadic ? "..." : ""}${typeToSource(a.idlType)} ${a.name}`)
        .join(", ")});`;
      return {
        member: { kind: "operation", name: member.name, returnType, args },
        metaLine: metaSig,
      };
    }
    case "const":
      return { skipReason: "constant" };
    case "constructor":
      return { skipReason: "constructor" };
    case "stringifier":
      return null; // pure marker, nothing to preserve
    case "iterable":
    case "maplike":
    case "setlike":
    case "async-iterable":
      return { skipReason: member.type };
    default:
      return { skipReason: `unknown-member:${member.type}` };
  }
}

/** Render a webidl2 type AST back to its source-ish spelling for metadata. */
function typeToSource(idlType) {
  if (idlType === undefined || idlType === null) return "void";
  if (Array.isArray(idlType)) return idlType.map(typeToSource).join(" or ");
  const inner = idlType.union
    ? `(${(idlType.idlType ?? []).map(typeToSource).join(" or ")})`
    : idlType.generic !== ""
      ? `${idlType.generic}<${(Array.isArray(idlType.idlType) ? idlType.idlType : [idlType.idlType])
          .map(typeToSource)
          .join(", ")}>`
      : String(idlType.idlType);
  return idlType.nullable ? `${inner}?` : inner;
}

function memberKey(member) {
  if (member.kind === "attribute") return `attribute ${member.name}`;
  return `operation ${member.name}`;
}

/** Exact-shape equality between one of our members and a converted one. */
function membersEqual(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.name !== b.name) return false;
  if (a.kind === "attribute") {
    return a.readonly === b.readonly && typesEqual(a.type, b.type);
  }
  return (
    typesEqual(a.returnType, b.returnType) &&
    a.args.length === b.args.length &&
    a.args.every((arg, i) => typesEqual(arg.type, b.args[i].type))
  );
}

function typesEqual(a, b) {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "interface":
      return a.name === b.name;
    case "nullable":
      return typesEqual(a.inner, b.inner);
    case "sequence":
      return typesEqual(a.element, b.element);
    default:
      return false;
  }
}

// ---- TypeScript emission ------------------------------------------------------

/** Helpers referenced by the emitted data (imports are pruned to this set). */
const usedHelpers = new Set();

function tsType(idlType) {
  if (typeof idlType === "string") return JSON.stringify(idlType);
  switch (idlType.kind) {
    case "interface":
      usedHelpers.add("iface");
      return `iface(${JSON.stringify(idlType.name)})`;
    case "nullable":
      usedHelpers.add("nullable");
      return `nullable(${tsType(idlType.inner)})`;
    case "sequence":
      usedHelpers.add("sequence");
      return `sequence(${tsType(idlType.element)})`;
    default:
      throw new Error(`unknown IdlType kind: ${idlType.kind}`);
  }
}

function tsMember(member) {
  if (member.kind === "attribute") {
    usedHelpers.add("attribute");
    const opts = member.readonly ? ", { readonly: true }" : "";
    return `attribute(${JSON.stringify(member.name)}, ${tsType(member.type)}${opts})`;
  }
  usedHelpers.add("operation");
  if (member.args.length > 0) usedHelpers.add("arg");
  const args = member.args
    .map((a) => `arg(${JSON.stringify(a.name)}, ${tsType(a.type)})`)
    .join(", ");
  return `operation(${JSON.stringify(member.name)}, ${tsType(member.returnType)}, [${args}])`;
}

function tsInterface(iface) {
  const lines = [];
  lines.push(`  {`);
  lines.push(`    name: ${JSON.stringify(iface.name)},`);
  if (iface.inherits !== undefined) {
    lines.push(`    inherits: ${JSON.stringify(iface.inherits)},`);
  }
  lines.push(`    members: [`);
  for (const member of iface.members) {
    lines.push(`      ${tsMember(member)},`);
  }
  lines.push(`    ],`);
  lines.push(
    `    ladybirdSource: [${iface.ladybirdSource.map((s) => JSON.stringify(s)).join(", ")}],`,
  );
  lines.push(`  },`);
  return lines.join("\n");
}

function banner(summary) {
  return [
    "/**",
    " * @generated by tools/ladybird-import/import-idl.mjs — DO NOT EDIT BY HAND.",
    " *",
    ` * ${summary}`,
    " *",
    " * Derived from Ladybird Browser's WebIDL files (BSD-2-Clause),",
    " * https://github.com/LadybirdBrowser/ladybird",
    " *",
    " * Regenerate with `node tools/ladybird-import/import-idl.mjs`.",
    " */",
  ].join("\n");
}

// ---- main ----------------------------------------------------------------------

async function* walkIdlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkIdlFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".idl")) {
      yield full;
    }
  }
}

const ourInterfaces = new Map(DOM_INTERFACES.map((i) => [i.name, i]));

const report = {
  generatedAt: new Date().toISOString(),
  source: "ladybird-master/Libraries/LibWeb (BSD-2-Clause)",
  files: { total: 0, parsed: 0, parseErrors: [] },
  definitions: {
    total: 0,
    interfacesConverted: 0,
    partialInterfacesMerged: 0,
    memberAdditionsOnExistingInterfaces: 0,
    skipped: {},
    skippedDetails: [],
  },
  members: {
    converted: 0,
    additionsConverted: 0,
    dropped: 0,
    skipped: {},
  },
  topAdditions: [],
};

// Count with explicit own-key maps so a reason literally named "constructor"
// never collides with Object.prototype.
const definitionSkipCounts = new Map();
const memberSkipCounts = new Map();

function bumpSkipped(reason, name) {
  definitionSkipCounts.set(reason, (definitionSkipCounts.get(reason) ?? 0) + 1);
  report.definitions.skippedDetails.push({ reason, name });
}

function bumpMemberSkipped(reason) {
  memberSkipCounts.set(reason, (memberSkipCounts.get(reason) ?? 0) + 1);
}

/** interface name → { interface?, inherits?, members: Map<key, member>, metaLines: Map<key, line> } */
const ifaceAccumulators = new Map();

function accumulatorFor(name) {
  let acc = ifaceAccumulators.get(name);
  if (acc === undefined) {
    acc = { inherits: undefined, members: new Map(), metaLines: new Map(), seenPartial: false };
    ifaceAccumulators.set(name, acc);
  }
  return acc;
}

const files = [];
for await (const file of walkIdlFiles(LADYBIRD_IDL_ROOT)) files.push(file);
files.sort();
report.files.total = files.length;

// Pass 1: parse every file, collect typedef alias targets.
const parsedFiles = [];
for (const file of files) {
  const rel = path.relative(LADYBIRD_IDL_ROOT, file);
  const text = readFileSync(file, "utf8");
  let ast;
  try {
    ast = webidl2.parse(text);
  } catch (error) {
    report.files.parseErrors.push({ file: rel, error: String(error).split("\n")[0] });
    continue;
  }
  report.files.parsed += 1;
  for (const def of ast) {
    if (def.type === "typedef" && !typedefTargets.has(def.name)) {
      typedefTargets.set(def.name, def.idlType);
    }
  }
  parsedFiles.push({ rel, ast });
}

// Pass 2: convert definitions (typedef aliases now resolvable at use sites).
for (const { ast } of parsedFiles) {
  for (const def of ast) {
    report.definitions.total += 1;
    switch (def.type) {
      case "interface": {
        const acc = accumulatorFor(def.name);
        if (def.partial) {
          acc.seenPartial = true;
        } else if (def.inheritance !== null && acc.inherits === undefined) {
          acc.inherits = def.inheritance;
        }
        for (const member of def.members ?? []) {
          const result = convertMember(member);
          if (result === null) continue;
          if (result.skipReason !== undefined) {
            bumpMemberSkipped(`${result.skipReason}${def.partial ? " (partial)" : ""}`);
            continue;
          }
          const key = memberKey(result.member);
          if (!acc.members.has(key)) {
            acc.members.set(key, result.member);
            acc.metaLines.set(key, result.metaLine);
          }
          report.members.converted += 1;
        }
        break;
      }
      case "interface mixin":
        bumpSkipped("interface-mixin", def.name);
        break;
      case "namespace":
        bumpSkipped("namespace", def.name);
        break;
      case "dictionary":
        bumpSkipped("dictionary", def.name);
        break;
      case "enum":
        bumpSkipped("enum", def.name);
        break;
      case "callback":
        bumpSkipped("callback", def.name);
        break;
      case "callback interface":
        bumpSkipped("callback-interface", def.name);
        break;
      case "typedef":
        bumpSkipped("typedef", def.name);
        break;
      case "includes":
        bumpSkipped("includes-statement", `${def.target} includes ${def.includes}`);
        break;
      default:
        bumpSkipped(`unknown-definition:${def.type}`, def.name ?? "(anonymous)");
    }
  }
}

// ---- split into new interfaces vs member additions ----------------------------

const newInterfaces = [];
const memberAdditions = [];

const sortedNames = [...ifaceAccumulators.keys()].sort();
for (const name of sortedNames) {
  const acc = ifaceAccumulators.get(name);
  if (acc.seenPartial) report.definitions.partialInterfacesMerged += 1;
  const members = [...acc.members.values()];
  const metaLines = [...acc.members.keys()].map((k) => acc.metaLines.get(k));
  if (members.length === 0) {
    bumpSkipped("interface-without-expressible-members", name);
    continue;
  }
  const ours = ourInterfaces.get(name);
  if (ours === undefined) {
    const entry = { name, members, ladybirdSource: metaLines };
    if (acc.inherits !== undefined) entry.inherits = acc.inherits;
    newInterfaces.push(entry);
    report.definitions.interfacesConverted += 1;
    continue;
  }
  // Existing interface: extract only the incremental members.
  const additions = [];
  const additionMeta = [];
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const match = ours.members.find((m) => memberKey(m) === memberKey(member));
    if (match === undefined) {
      additions.push(member);
      additionMeta.push(metaLines[i]);
    } else if (membersEqual(match, member)) {
      report.members.dropped += 1; // already expressed with the same shape
    } else {
      report.members.dropped += 1; // same member, different shape — ours wins
    }
  }
  if (additions.length > 0) {
    const entry = { name, members: additions, ladybirdSource: additionMeta };
    memberAdditions.push(entry);
    report.definitions.memberAdditionsOnExistingInterfaces += 1;
    report.members.additionsConverted += additions.length;
  }
}

report.topAdditions = memberAdditions
  .map((e) => ({ interface: e.name, addedMembers: e.members.length }))
  .sort((a, b) => b.addedMembers - a.addedMembers || a.interface.localeCompare(b.interface))
  .slice(0, 20);
report.definitions.skipped = Object.fromEntries(definitionSkipCounts);
report.members.skipped = Object.fromEntries(memberSkipCounts);
report.typedefsResolved = Object.fromEntries(
  [...resolvedTypedefs.entries()].sort((a, b) => a[0].localeCompare(b[0])),
);

// ---- emit the .ts data file -----------------------------------------------------

function emitArray(exportName, entries, docComment) {
  const lines = [];
  lines.push(docComment);
  lines.push(`export const ${exportName}: readonly LadybirdIdlInterface[] = [`);
  for (const entry of entries) {
    lines.push(tsInterface(entry));
  }
  lines.push(`];`);
  return lines.join("\n");
}

// Pre-render so `usedHelpers` is populated before the import line is built.
const interfacesBlock = emitArray(
  "LADYBIRD_IDL_INTERFACES",
  newInterfaces,
  `/**
 * Interfaces Ladybird declares that our hand-written DOM table does not have
 * (sorted by name). NOT wired into the generation pipeline — exposure policy
 * is a separate, later decision.
 */`,
);
const additionsBlock = emitArray(
  "LADYBIRD_IDL_MEMBER_ADDITIONS",
  memberAdditions,
  `/**
 * Members Ladybird declares on interfaces we ALREADY have, restricted to the
 * ones our table lacks (exact-shape matches are dropped as already expressed;
 * same-name different-shape members are dropped in our favour — the
 * hand-written table always wins).
 */`,
);

const HELPER_ORDER = ["arg", "attribute", "iface", "nullable", "operation", "sequence"];
const helperImport = HELPER_ORDER.filter((h) => usedHelpers.has(h)).join(", ");

const ts = `${banner(
  "Ladybird WebIDL import: interfaces we lack, plus incremental members on interfaces we have.",
)}
import type { IdlInterface } from "../dom-interfaces.idl.js";
import { ${helperImport} } from "../dom-interfaces.idl.js";

/**
 * A data row carrying the Ladybird source line of each converted member as
 * read-only metadata (members our IDL vocabulary cannot express are listed in
 * the import report's skipped tables instead — nothing is silently dropped).
 */
export interface LadybirdIdlInterface extends IdlInterface {
  /** Ladybird WebIDL source spelling per member, parallel to \`members\`. */
  readonly ladybirdSource: readonly string[];
}

${interfacesBlock}

${additionsBlock}
`;

mkdirSync(path.dirname(OUTPUT_TS), { recursive: true });
writeFileSync(OUTPUT_TS, ts);
writeFileSync(OUTPUT_REPORT, JSON.stringify(report, null, 2) + "\n");

console.log(`files: ${report.files.parsed}/${report.files.total} parsed (${report.files.parseErrors.length} parse errors)`);
console.log(`new interfaces: ${newInterfaces.length}`);
console.log(`interfaces with member additions: ${memberAdditions.length} (${report.members.additionsConverted} members)`);
console.log(`members dropped (already expressed / shape differs): ${report.members.dropped}`);
console.log(`definition skips: ${JSON.stringify(report.definitions.skipped)}`);
console.log(`member skips: ${JSON.stringify(report.members.skipped)}`);
console.log(`wrote ${OUTPUT_TS}`);
console.log(`wrote ${OUTPUT_REPORT}`);
