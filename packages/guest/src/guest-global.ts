/**
 * Build the guest-visible global object across the kernel/guest boundary
 * (task 7.6; design.md §10; Requirements 16.3, 7.3).
 *
 * The injected guest global exposes ONLY the generated web surface — the DOM
 * interface CONSTRUCTORS named in `DOM_SURFACE` — and nothing engine-internal
 * (Requirement 7.3). It is the object handed to V8 as the guest context's
 * `globalThis` (see `./runtime.ts`), so whatever is NOT placed here is
 * unreachable by guest code:
 *
 *   - the module-private `INTERNAL` symbol and every engine handle (NodeId, Db,
 *     fragment indices) are never referenced here, so a guest cannot enumerate
 *     or reach them (Requirement 7.2 / 7.4, proven in `./isolation.test.ts`);
 *   - Node host objects (`require`, `process`, `module`) are not placed on the
 *     global either, so the V8 context starts from a clean, surface-only global.
 *
 * Each generated interface becomes a non-enumerable, non-writable constructor
 * function on the global, carrying its generated member descriptors on the
 * prototype as loud `NotImplemented` throwers (via {@link installSurface}) until
 * a concrete engine implementation is wired in. A guest can therefore see that
 * `Element`, `Document`, etc. EXIST (and inherit correctly across the
 * `DOM_SURFACE` chain) without any path to engine internals.
 *
 * The guest package is not a pipeline stage, so it may import the generated
 * surface table from `@browser-engine/generator` directly.
 */
import { DOM_SURFACE, type InterfaceDescriptor } from "@browser-engine/generator";

import { installSurface } from "./surface-members.js";

/** A plain object usable as a V8 context global (string-keyed surface members). */
export type GuestGlobal = Record<string, unknown>;

/** Options controlling which generated surface is exposed to the guest. */
export interface GuestGlobalOptions {
  /**
   * The generated DOM surface to expose. Defaults to the committed
   * {@link DOM_SURFACE}; injectable so tests can exercise a smaller surface.
   */
  readonly surface?: readonly InterfaceDescriptor[];
}

/**
 * Construct the guest `globalThis`: one constructor per generated interface,
 * each with its flattened (inherited) member surface installed on its prototype
 * as `NotImplemented` throwers. The returned object contains ONLY these
 * generated constructors — no engine-internal state — so it is safe to hand to
 * V8 as the guest context global (Requirement 7.3, 16.3).
 *
 * `globalThis` is made a self-reference (as in a real JS global) so guest code
 * can name `globalThis`; it is a plain alias to the surface object, exposing
 * nothing extra.
 */
export function buildGuestGlobal(options: GuestGlobalOptions = {}): GuestGlobal {
  const surface = options.surface ?? DOM_SURFACE;
  const guestGlobal: GuestGlobal = {};

  for (const descriptor of surface) {
    // A fresh constructor per interface. It throws if a guest tries to `new` it
    // directly — engine-built wrappers are minted by trusted in-package code
    // (e.g. createElementWrapper), never by guest construction — but it carries
    // the generated member surface on its prototype so the interface shape is
    // visible (and inherited members resolve) across the boundary.
    const ctor = makeInterfaceConstructor(descriptor.name);
    installSurface(ctor.prototype, descriptor.name, new Map(), surface);
    Object.defineProperty(guestGlobal, descriptor.name, {
      value: ctor,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  // A real global names itself; expose only the surface object, nothing more.
  Object.defineProperty(guestGlobal, "globalThis", {
    value: guestGlobal,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return guestGlobal;
}

/**
 * Build a named constructor function for a generated interface. Guests receive
 * the constructor (so `Element`, `Document`, … are visible and `instanceof`
 * works against engine-built wrappers once wired), but constructing one directly
 * is not a supported guest operation — engine code mints wrappers from internal
 * handles. The function is named for good guest-facing diagnostics.
 */
function makeInterfaceConstructor(name: string): { new (): object; prototype: object } {
  const ctor = {
    [name]: function () {
      // Constructed only via the engine's wrapper factories, never by guests.
      throw new TypeError(`Illegal constructor: ${name} is not guest-constructable`);
    },
  }[name] as unknown as { new (): object; prototype: object };
  return ctor;
}
