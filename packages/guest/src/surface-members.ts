/**
 * Resolve and install the guest-visible DOM surface from the generated
 * `DOM_SURFACE` table (design.md §10; Requirement 7.3).
 *
 * The kernel/guest boundary builds every guest-facing member from EXACTLY the
 * generated `DOM_SURFACE` descriptors and nothing else. This module turns those
 * descriptors into real, non-enumerable prototype members:
 *
 *   - an `attribute` descriptor becomes a getter (plus a setter when it is not
 *     `readonly`);
 *   - an `operation` descriptor becomes a method.
 *
 * Where the engine has a concrete implementation, it is supplied via the
 * `impls` map; every other member is installed as a loud `NotImplemented`
 * thrower (design.md §12; Requirement 5.1) — never a silent placeholder.
 *
 * Members are installed **non-enumerable**, mirroring real web platform objects
 * (whose members live on non-enumerable accessor properties on the prototype).
 * That is what keeps `Object.keys` / `for…in` / `Reflect.ownKeys` over an
 * instance free of any surface *or* internal key (Requirement 7.2).
 */
import { NotImplemented, notImplemented } from "@browser-engine/ir";
import {
  DOM_SURFACE,
  type AttributeDescriptor,
  type InterfaceDescriptor,
  type MemberDescriptor,
  type OperationDescriptor,
} from "@browser-engine/generator";

/** A concrete implementation for one generated surface member. */
export type MemberImpl =
  | { readonly kind: "attribute"; readonly get: (this: object) => unknown; readonly set?: (this: object, value: unknown) => void }
  | { readonly kind: "operation"; readonly call: (this: object, ...args: unknown[]) => unknown };

/** Map from member name to its concrete implementation, if any. */
export type MemberImpls = ReadonlyMap<string, MemberImpl>;

/** Index `DOM_SURFACE` by interface name for inheritance resolution. */
function indexByName(surface: readonly InterfaceDescriptor[]): ReadonlyMap<string, InterfaceDescriptor> {
  const byName = new Map<string, InterfaceDescriptor>();
  for (const descriptor of surface) {
    byName.set(descriptor.name, descriptor);
  }
  return byName;
}

/**
 * Flatten an interface's members across its `inherits` chain (base members
 * first), with a more-derived member overriding a base member of the same name
 * — e.g. `Comment.nodeType` shadows `Node.nodeType`.
 */
export function resolveMembers(
  interfaceName: string,
  surface: readonly InterfaceDescriptor[] = DOM_SURFACE,
): readonly MemberDescriptor[] {
  const byName = indexByName(surface);
  const byMemberName = new Map<string, MemberDescriptor>();

  // Walk base → derived so a derived member wins the Map insertion.
  const chain: InterfaceDescriptor[] = [];
  let current = byName.get(interfaceName);
  while (current !== undefined) {
    chain.unshift(current);
    current = current.inherits === null ? undefined : byName.get(current.inherits);
  }
  if (chain.length === 0) {
    notImplemented(`dom-api:${interfaceName}`, {
      category: "dom-api",
      detail: "interface is not present in the generated DOM surface",
    });
  }

  for (const descriptor of chain) {
    for (const member of descriptor.members) {
      byMemberName.set(member.name, member);
    }
  }
  return [...byMemberName.values()];
}

/** Build the `NotImplemented`-throwing fallback for an attribute getter. */
function notImplementedGetter(interfaceName: string, member: AttributeDescriptor): () => never {
  return function notImplementedAttributeGet(): never {
    throw new NotImplemented(`dom-api:${interfaceName}.${member.name}`, {
      category: "dom-api",
      detail: "guest-visible attribute is declared in the DOM surface but not yet implemented",
    });
  };
}

/** Build the `NotImplemented`-throwing fallback for an attribute setter. */
function notImplementedSetter(interfaceName: string, member: AttributeDescriptor): () => never {
  return function notImplementedAttributeSet(): never {
    throw new NotImplemented(`dom-api:${interfaceName}.${member.name}=`, {
      category: "dom-api",
      detail: "guest-visible attribute is declared in the DOM surface but not yet implemented",
    });
  };
}

/** Build the `NotImplemented`-throwing fallback for an operation. */
function notImplementedOperation(interfaceName: string, member: OperationDescriptor): () => never {
  return function notImplementedOperationCall(): never {
    throw new NotImplemented(`dom-api:${interfaceName}.${member.name}()`, {
      category: "dom-api",
      detail: "guest-visible operation is declared in the DOM surface but not yet implemented",
    });
  };
}

/**
 * Install the flattened surface of `interfaceName` onto `target` (a prototype).
 * Already-present members are left untouched, so a class may define concrete
 * implementations directly and let this fill in the rest from `DOM_SURFACE`.
 *
 * Every installed property is non-enumerable and configurable:false, so guests
 * can neither enumerate it away nor redefine it.
 */
export function installSurface(
  target: object,
  interfaceName: string,
  impls: MemberImpls = new Map(),
  surface: readonly InterfaceDescriptor[] = DOM_SURFACE,
): void {
  for (const member of resolveMembers(interfaceName, surface)) {
    if (Object.prototype.hasOwnProperty.call(target, member.name)) {
      continue; // a concrete implementation already defined this member.
    }
    const impl = impls.get(member.name);

    if (member.kind === "attribute") {
      const get =
        impl !== undefined && impl.kind === "attribute"
          ? impl.get
          : notImplementedGetter(interfaceName, member);
      const set =
        impl !== undefined && impl.kind === "attribute" && impl.set !== undefined
          ? impl.set
          : member.readonly
            ? undefined
            : notImplementedSetter(interfaceName, member);
      Object.defineProperty(target, member.name, {
        enumerable: false,
        configurable: false,
        get,
        ...(set === undefined ? {} : { set }),
      });
    } else {
      const call =
        impl !== undefined && impl.kind === "operation"
          ? impl.call
          : notImplementedOperation(interfaceName, member);
      Object.defineProperty(target, member.name, {
        enumerable: false,
        configurable: false,
        writable: false,
        value: call,
      });
    }
  }
}
