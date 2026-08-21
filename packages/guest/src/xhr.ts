/**
 * XMLHttpRequest — the classic AJAX API.
 *
 * Built on top of the existing `NetworkStack` (the same stack `fetch` uses).
 * Supports the core XHR lifecycle: open → send → readystatechange → load/error.
 *
 * Events: loadstart, progress, abort, error, load, loadend, readystatechange.
 * Properties: readyState, status, statusText, responseText, response, responseURL.
 */
import type { NetworkStack, NetworkRequest, NetworkResponse } from "./network.js";

export type XMLHttpRequestReadyState = 0 | 1 | 2 | 3 | 4;

interface XHREventListener {
  (this: XMLHttpRequestImpl, ev: Event): void;
}

export class XMLHttpRequestImpl {
  readonly #networkStack: NetworkStack;
  #readyState: XMLHttpRequestReadyState = 0;
  #status = 0;
  #statusText = "";
  #responseText = "";
  #responseURL = "";
  #method = "GET";
  #url = "";
  #headers = new Map<string, string>();
  #listeners = new Map<string, XHREventListener[]>();
  #aborted = false;

  constructor(networkStack: NetworkStack) {
    this.#networkStack = networkStack;
  }

  get readyState(): XMLHttpRequestReadyState { return this.#readyState; }
  get status(): number { return this.#status; }
  get statusText(): string { return this.#statusText; }
  get responseText(): string { return this.#responseText; }
  get response(): unknown { return this.#responseText; }
  get responseURL(): string { return this.#responseURL; }

  open(method: string, url: string): void {
    this.#method = method.toUpperCase();
    this.#url = url;
    this.#readyState = 1;
    this.#dispatch("readystatechange");
  }

  setRequestHeader(name: string, value: string): void {
    this.#headers.set(name.toLowerCase(), value);
  }

  async send(body?: string): Promise<void> {
    if (this.#readyState !== 1) return;
    this.#readyState = 2;
    this.#dispatch("readystatechange");
    this.#dispatch("loadstart");

    try {
      const request: NetworkRequest = {
        method: this.#method,
        url: this.#url,
        headers: Object.fromEntries(this.#headers),
        ...(body !== undefined ? { body: new TextEncoder().encode(body) } : {}),
      };
      const response: NetworkResponse = await this.#networkStack.request(request);

      this.#status = response.status;
      this.#statusText = response.ok ? "OK" : "Error";
      this.#responseText = new TextDecoder().decode(response.body);
      this.#responseURL = this.#url;
      this.#readyState = 3;
      this.#dispatch("readystatechange");
      this.#readyState = 4;
      this.#dispatch("readystatechange");
      this.#dispatch("load");
      this.#dispatch("loadend");
    } catch {
      this.#readyState = 4;
      this.#dispatch("readystatechange");
      this.#dispatch("error");
      this.#dispatch("loadend");
    }
  }

  abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#readyState = 4;
    this.#dispatch("readystatechange");
    this.#dispatch("abort");
    this.#dispatch("loadend");
  }

  addEventListener(type: string, listener: XHREventListener): void {
    let arr = this.#listeners.get(type);
    if (arr === undefined) {
      arr = [];
      this.#listeners.set(type, arr);
    }
    arr.push(listener);
  }

  removeEventListener(type: string, listener: XHREventListener): void {
    const arr = this.#listeners.get(type);
    if (arr === undefined) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  #dispatch(type: string): void {
    const listeners = this.#listeners.get(type);
    if (listeners === undefined) return;
    const event = { type, target: this, currentTarget: this } as unknown as Event;
    for (const listener of [...listeners]) {
      try {
        listener.call(this, event);
      } catch {
        // Continue dispatching even if a listener throws.
      }
    }
  }
}

/** Minimal Event type for XHR (avoids circular import with event-system). */
interface Event {
  readonly type: string;
  readonly target: unknown;
  readonly currentTarget: unknown;
}
