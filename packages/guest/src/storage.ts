/**
 * Storage — the Web Storage API (localStorage / sessionStorage).
 *
 * A simple in-memory `Map<string, string>` backend. Data does not persist
 * across runtime restarts (no disk serialization), which is acceptable for
 * a headless engine. The interface matches the spec: length, key(), getItem(),
 * setItem(), removeItem(), clear().
 */
import { Event } from "./event-system.js";
import { DOMException } from "./abort.js";

/**
 * Per-area quota in UTF-16 code units of (key + value) — the Web Storage
 * spec suggests 5 MiB; we enforce it so `setItem` in a loop terminates with
 * QuotaExceededError instead of growing without bound (as WPT requires).
 */
const STORAGE_QUOTA = 5 * 1024 * 1024;

export class StorageImpl {
  readonly #data = new Map<string, string>();
  readonly #order: string[] = [];
  readonly #quota: number;
  #used = 0;

  constructor(quota: number = STORAGE_QUOTA) {
    this.#quota = quota;
  }

  get length(): number {
    return this.#data.size;
  }

  /** Bytes currently stored (UTF-16 code units of keys + values). */
  get usage(): number {
    return this.#used;
  }

  /** This storage area's quota in UTF-16 code units. */
  get quota(): number {
    return this.#quota;
  }

  key(index: number): string | null {
    const i = Number(index);
    if (!Number.isFinite(i) || i < 0 || i >= this.#order.length) return null;
    return this.#order[Math.trunc(i)] ?? null;
  }

  getItem(key: string): string | null {
    return this.#data.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    const k = String(key);
    const str = String(value);
    const prior = this.#data.get(k);
    const next = this.#used - (prior === undefined ? 0 : prior.length) + str.length
      + (prior === undefined ? k.length : 0);
    if (next > this.#quota) {
      throw new DOMException(
        `Failed to execute 'setItem' on 'Storage': Setting the value of '${k}' exceeded the quota.`,
        "QuotaExceededError",
      );
    }
    if (prior === undefined) {
      this.#order.push(k);
    }
    this.#data.set(k, str);
    this.#used = next;
  }

  removeItem(key: string): void {
    const k = String(key);
    const prior = this.#data.get(k);
    if (prior !== undefined) {
      this.#data.delete(k);
      this.#used -= k.length + prior.length;
      const idx = this.#order.indexOf(k);
      if (idx !== -1) this.#order.splice(idx, 1);
    }
  }

  clear(): void {
    this.#data.clear();
    this.#order.length = 0;
    this.#used = 0;
  }
}

/**
 * `navigator.storage` — StorageManager (Storage Standard). Reports the
 * combined usage of the storage areas it was constructed over and the
 * site quota; `persist()`/`persisted()` model an always-best-effort site.
 */
export class StorageManagerImpl {
  readonly #areas: readonly StorageImpl[];

  constructor(...areas: StorageImpl[]) {
    this.#areas = areas;
  }

  estimate(): Promise<{ usage: number; quota: number }> {
    let usage = 0;
    let quota = STORAGE_QUOTA;
    for (const area of this.#areas) {
      usage += area.usage;
      quota = Math.max(quota, area.quota);
    }
    return Promise.resolve({ usage, quota });
  }

  persisted(): Promise<boolean> {
    return Promise.resolve(false);
  }

  persist(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------------------
// StorageEvent (HTML §12.3 / Web Storage §5)
// ---------------------------------------------------------------------------

export interface StorageEventInit {
  key?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  url?: string;
  storageArea?: StorageImpl | null;
}

export class StorageEvent extends Event {
  #key: string | null;
  #oldValue: string | null;
  #newValue: string | null;
  #url: string;
  #storageArea: StorageImpl | null;

  constructor(type: string, init: StorageEventInit & { bubbles?: boolean; cancelable?: boolean } = {}) {
    if (arguments.length === 0) {
      throw new TypeError("Failed to construct 'StorageEvent': 1 argument required, but only 0 present.");
    }
    super(type, init);
    // WebIDL dictionary semantics: absent/undefined members take the
    // dictionary default; explicit null converts per the member type
    // (nullable DOMString? stays null; url is non-nullable → "null").
    this.#key = init?.key === undefined ? null : init.key === null ? null : String(init.key);
    this.#oldValue = init?.oldValue === undefined ? null : init.oldValue === null ? null : String(init.oldValue);
    this.#newValue = init?.newValue === undefined ? null : init.newValue === null ? null : String(init.newValue);
    this.#url = init?.url === undefined ? "" : String(init.url);
    this.#storageArea = init?.storageArea ?? null;
  }

  get key(): string | null { return this.#key; }
  get oldValue(): string | null { return this.#oldValue; }
  get newValue(): string | null { return this.#newValue; }
  get url(): string { return this.#url; }
  get storageArea(): StorageImpl | null { return this.#storageArea; }

  /**
   * Legacy initializer (Web Storage §5.3). WebIDL conversions:
   *   - 0 arguments → TypeError (type is required; `.length` is 1)
   *   - type/url are non-nullable DOMString → String(v); url default ""
   *   - key/oldValue/newValue are DOMString? → null/undefined stay null
   *   - storageArea is Storage? → null/undefined stay null
   */
  initStorageEvent(
    type: string,
    bubbles = false,
    cancelable = false,
    key: string | null = null,
    oldValue: string | null = null,
    newValue: string | null = null,
    url = "",
    storageArea: StorageImpl | null = null,
  ): void {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'initStorageEvent': 1 argument required, but only 0 present.");
    }
    this.initEvent(String(type), Boolean(bubbles), Boolean(cancelable));
    this.#key = key === null || key === undefined ? null : String(key);
    this.#oldValue = oldValue === null || oldValue === undefined ? null : String(oldValue);
    this.#newValue = newValue === null || newValue === undefined ? null : String(newValue);
    this.#url = url === undefined ? "" : String(url);
    this.#storageArea = storageArea === undefined ? null : storageArea;
  }
}

// ---------------------------------------------------------------------------
// Named-property access — the legacy storage key Proxy
// ---------------------------------------------------------------------------

/**
 * Web Storage is a legacy platform object: `storage[k]` gets/sets stored
 * keys, `delete storage[k]` removes them, `Object.defineProperty(storage, k)`
 * stores, and enumeration exposes exactly the stored keys — prototype members
 * (`getItem`, `length`, …) stay reachable but are never enumerated. Symbols
 * bypass storage entirely and land as ordinary own properties.
 */
/** WebIDL DOMString coercion for proxied writes (`storage[k] = v`). */
const domString = (v: unknown): string => String(v);

export function createStorageProxy(storage: StorageImpl): StorageImpl {
  // Symbols bypass storage entirely: they delegate to the real target as
  // ordinary own properties (so a non-configurable symbol defined via
  // defineProperty is a REAL non-configurable own property — the proxy
  // invariants then make `delete storage[sym]` correctly return false).
  const isKey = (p: unknown): p is string => typeof p === "string";
  /**
   * Storage has NO [LegacyOverrideBuiltIns]: a property defined anywhere on
   * the prototype chain shadows a stored key of the same name (the key is
   * still reachable via getItem, and assignment still stores).
   */
  const onProtoChain = (target: StorageImpl, prop: string | symbol): boolean => {
    let proto = Reflect.getPrototypeOf(target);
    while (proto !== null) {
      if (Reflect.getOwnPropertyDescriptor(proto, prop) !== undefined) return true;
      proto = Reflect.getPrototypeOf(proto);
    }
    return false;
  };
  const storedValue = (target: StorageImpl, prop: string | symbol): string | null =>
    isKey(prop) && !onProtoChain(target, prop) ? target.getItem(prop) : null;
  const handler: ProxyHandler<StorageImpl> = {
    get(target, prop) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, target) as unknown;
      const stored = storedValue(target, prop);
      if (stored !== null) return stored;
      // Private fields (#data/#order) reject `this` being the proxy: bind
      // methods and evaluate accessors against the real target.
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
    set(target, prop, value) {
      if (typeof prop === "symbol") return Reflect.set(target, prop, value, target);
      storage.setItem(prop, domString(value));
      return true;
    },
    has(target, prop) {
      if (storedValue(target, prop) !== null) return true;
      return Reflect.has(target, prop);
    },
    deleteProperty(target, prop) {
      if (isKey(prop)) {
        storage.removeItem(prop);
        return true;
      }
      return Reflect.deleteProperty(target, prop);
    },
    defineProperty(target, prop, descriptor) {
      if (typeof prop === "symbol") return Reflect.defineProperty(target, prop, descriptor);
      storage.setItem(prop, "value" in descriptor ? domString(descriptor.value) : "");
      return true;
    },
    ownKeys(target) {
      const keys: string[] = [];
      for (let i = 0; i < target.length; i += 1) {
        const k = target.key(i);
        if (k !== null && !onProtoChain(target, k)) keys.push(k);
      }
      return [...keys, ...Reflect.ownKeys(target).filter((k) => typeof k === "symbol")];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "symbol") return Reflect.getOwnPropertyDescriptor(target, prop);
      const stored = storedValue(target, prop);
      if (stored !== null) {
        return { value: stored, writable: true, enumerable: true, configurable: true };
      }
      return undefined;
    },
  };
  return new Proxy(storage, handler);
}
