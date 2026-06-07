/**
 * dom-codegen.ts — emit the guest-visible DOM surface from the IDL table
 * (design.md §4.2; Requirements 6.3, 16.2).
 *
 * Reads the WebIDL-style `DOM_INTERFACES` table and emits `dom-surface.ts`: a
 * TypeScript interface per IDL interface (attributes as typed fields, operations
 * as typed methods) plus a runtime descriptor table the boundary uses to build
 * the injected guest global (the actual injection lands in task 7.4). Task 7.3
 * grew the table to the COMPLETE mainstream surface (Requirement 16.2); the
 * emitter maps the full IDL type vocabulary — primitives, interface references,
 * nullable wrappers and sequences — onto TypeScript via `tsTypeOf`. All
 * interfaces are emitted into one module, so interface-typed members resolve
 * regardless of declaration order.
 *
 * This emitter shares NO input with the CSS emitter — it consumes only
 * `DOM_INTERFACES`. That is what makes DOM-surface generation independent of
 * CSS-parser generation (Requirement 6.4): see `generate.ts`, which runs the two
 * paths in isolation so a CSS-emit failure cannot block DOM emission.
 */
import type {
  IdlInterface,
  IdlMember,
  IdlType,
} from "../dom-interfaces.idl.js";
import { banner, quote, type GeneratedFile } from "./emit-support.js";

/** Path (relative to the generated dir) of the emitted DOM-surface module. */
export const DOM_SURFACE_FILE = "dom-surface.ts";

/** Map a WebIDL primitive keyword to its TypeScript surface type. */
function tsPrimitiveOf(primitive: string): string {
  switch (primitive) {
    case "DOMString":
      return "string";
    case "boolean":
      return "boolean";
    case "long":
    case "unsigned long":
    case "unrestricted double":
      return "number";
    case "any":
      return "unknown";
    case "void":
      return "void";
    default:
      // A runtime value outside the `IdlPrimitive` union — fail loudly so a
      // malformed table row never silently emits a bogus surface (this is what
      // `independence.test.ts`'s "failing DOM path" case exercises).
      throw new Error(`unknown IDL type: ${JSON.stringify(primitive)}`);
  }
}

/**
 * Map a WebIDL type to its TypeScript surface type:
 *   - a primitive keyword via {@link tsPrimitiveOf};
 *   - an interface reference → the generated interface's own name;
 *   - a nullable wrapper → `T | null`;
 *   - a sequence → `T[]` (parenthesised when `T` is a union so `(A | null)[]`).
 */
function tsTypeOf(idlType: IdlType): string {
  if (typeof idlType === "string") {
    return tsPrimitiveOf(idlType);
  }
  switch (idlType.kind) {
    case "interface":
      return idlType.name;
    case "nullable":
      return `${tsTypeOf(idlType.inner)} | null`;
    case "sequence": {
      const element = tsTypeOf(idlType.element);
      return `${element.includes("|") ? `(${element})` : element}[]`;
    }
    default: {
      const never: never = idlType;
      throw new Error(`unknown IDL type: ${JSON.stringify(never)}`);
    }
  }
}

/** Emit one interface member as a TypeScript interface-body line. */
function emitMember(member: IdlMember): string {
  if (member.kind === "attribute") {
    const ro = member.readonly ? "readonly " : "";
    return `  ${ro}${member.name}: ${tsTypeOf(member.type)};`;
  }
  const params = member.args
    .map((arg) => `${arg.name}: ${tsTypeOf(arg.type)}`)
    .join(", ");
  return `  ${member.name}(${params}): ${tsTypeOf(member.returnType)};`;
}

/** Emit the full TypeScript interface declaration for one IDL interface. */
function emitInterface(iface: IdlInterface): string {
  const heritage = iface.inherits === undefined ? "" : ` extends ${iface.inherits}`;
  const lines = iface.members.map(emitMember);
  return [
    `/** Guest-visible \`${iface.name}\` interface (generated from the IDL table). */`,
    `export interface ${iface.name}${heritage} {`,
    ...lines,
    `}`,
  ].join("\n");
}

/** Emit a member descriptor object literal for the runtime table. */
function emitMemberDescriptor(member: IdlMember): string {
  if (member.kind === "attribute") {
    return `{ kind: "attribute", name: ${quote(member.name)}, readonly: ${
      member.readonly ? "true" : "false"
    } }`;
  }
  const args = member.args.map((arg) => quote(arg.name)).join(", ");
  return `{ kind: "operation", name: ${quote(member.name)}, args: [${args}] }`;
}

/** Emit the runtime descriptor entry for one interface. */
function emitInterfaceDescriptor(iface: IdlInterface): string {
  const members = iface.members
    .map((member) => `      ${emitMemberDescriptor(member)},`)
    .join("\n");
  const inherits = iface.inherits === undefined ? "null" : quote(iface.inherits);
  return [
    `  {`,
    `    name: ${quote(iface.name)},`,
    `    inherits: ${inherits},`,
    `    members: [`,
    members,
    `    ],`,
    `  },`,
  ].join("\n");
}

/**
 * Emit `dom-surface.ts` from the IDL interface table (Requirement 6.3): one
 * TypeScript interface per IDL interface, the descriptor types, and the runtime
 * `DOM_SURFACE` descriptor table (the only thing exposed to guests —
 * Requirement 7.3, enforced at injection time in task 7.4).
 */
export function emitDomSurface(
  interfaces: readonly IdlInterface[],
): GeneratedFile {
  const ifaceDecls = interfaces.map(emitInterface).join("\n\n");
  const descriptors = interfaces.map(emitInterfaceDescriptor).join("\n");

  const contents = `${banner(
    "Guest-visible DOM surface, one interface per IDL row (Requirement 6.3).",
  )}
/** A descriptor for one attribute member of a DOM interface. */
export interface AttributeDescriptor {
  readonly kind: "attribute";
  readonly name: string;
  readonly readonly: boolean;
}

/** A descriptor for one operation member of a DOM interface. */
export interface OperationDescriptor {
  readonly kind: "operation";
  readonly name: string;
  readonly args: readonly string[];
}

/** A descriptor for one member of a DOM interface. */
export type MemberDescriptor = AttributeDescriptor | OperationDescriptor;

/** A descriptor for one DOM interface in the guest surface. */
export interface InterfaceDescriptor {
  readonly name: string;
  readonly inherits: string | null;
  readonly members: readonly MemberDescriptor[];
}

${ifaceDecls}

/**
 * The runtime description of the guest-visible DOM surface. The kernel/guest
 * boundary (task 7.4) builds the injected guest global from exactly this table
 * and nothing else, so engine-internal state is never exposed (Requirement 7.3).
 */
export const DOM_SURFACE: readonly InterfaceDescriptor[] = [
${descriptors}
];

/** The names of every interface in the guest surface, in table order. */
export const DOM_INTERFACE_NAMES: readonly string[] = [
${interfaces.map((iface) => `  ${quote(iface.name)},`).join("\n")}
];
`;

  return { path: DOM_SURFACE_FILE, contents };
}

/** Emit all DOM artifacts from the interface table (Requirement 6.3). */
export function emitDomArtifacts(
  interfaces: readonly IdlInterface[],
): readonly GeneratedFile[] {
  return [emitDomSurface(interfaces)];
}
