/**
 * Storage — the Web Storage API (localStorage / sessionStorage).
 *
 * A simple in-memory `Map<string, string>` backend. Data does not persist
 * across runtime restarts (no disk serialization), which is acceptable for
 * a headless engine. The interface matches the spec: length, key(), getItem(),
 * setItem(), removeItem(), clear().
 */
export class StorageImpl {
  readonly #data = new Map<string, string>();
  readonly #order: string[] = [];

  get length(): number {
    return this.#data.size;
  }

  key(index: number): string | null {
    if (index < 0 || index >= this.#order.length) return null;
    return this.#order[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const str = String(value);
    if (!this.#data.has(key)) {
      this.#order.push(key);
    }
    this.#data.set(key, str);
  }

  removeItem(key: string): void {
    if (this.#data.delete(key)) {
      const idx = this.#order.indexOf(key);
      if (idx !== -1) this.#order.splice(idx, 1);
    }
  }

  clear(): void {
    this.#data.clear();
    this.#order.length = 0;
  }
}
