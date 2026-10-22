/**
 * `window.matchMedia` — one MediaQueryList implementation for the page runtime
 * and the WPT sandbox. Evaluation and serialization live in the CSS parser;
 * this module only builds the guest object.
 */
import {
  DEFAULT_MEDIA_ENVIRONMENT,
  mediaQueryListMatches,
  serializeMediaQueryList,
  type MediaEnvironment,
} from "@browser-engine/css-parser";

export interface MediaQueryListLike {
  readonly matches: boolean;
  readonly media: string;
  onchange: ((event: { readonly type: string }) => void) | null;
  addListener: () => void;
  removeListener: () => void;
  addEventListener(type?: unknown, fn?: unknown): void;
  removeEventListener(type?: unknown, fn?: unknown): void;
  dispatchEvent: () => boolean;
}

export interface LiveMatchMedia {
  matchMedia(query: unknown): MediaQueryListLike;
  /** Schedule one animation frame that reports lists whose match bit changed. */
  viewportChanged(): void;
}

/**
 * A `matchMedia` whose `matches` getter re-reads the environment. Change
 * listeners run on the next animation frame, after the caller has painted
 * the resize, not in the style mutation that caused them.
 */
export function createLiveMatchMedia(
  read: () => MediaEnvironment,
  scheduleFrame: (flush: () => void) => void,
): LiveMatchMedia {
  const lists: LiveList[] = [];
  let queued = false;
  const current = (media: string): boolean => mediaQueryListMatches(media, read());
  return {
    matchMedia(query: unknown): MediaQueryListLike {
      const media = serializedQuery(query);
      const list: LiveList = { media, last: current(media), listeners: new Set(), onchange: null };
      lists.push(list);
      return {
        get matches() {
          return current(list.media);
        },
        get media() {
          return list.media;
        },
        get onchange() {
          return list.onchange;
        },
        set onchange(handler) {
          list.onchange = handler;
        },
        addListener: () => {},
        removeListener: () => {},
        addEventListener(type, fn) {
          if (type === "change" && typeof fn === "function") {
            list.listeners.add(fn as (event: { readonly type: string }) => void);
          }
        },
        removeEventListener(type, fn) {
          if (type === "change" && typeof fn === "function") {
            list.listeners.delete(fn as (event: { readonly type: string }) => void);
          }
        },
        dispatchEvent: () => false,
      };
    },
    viewportChanged() {
      if (queued || !lists.some((list) => current(list.media) !== list.last)) return;
      queued = true;
      scheduleFrame(() => {
        queued = false;
        for (const list of lists) {
          const now = current(list.media);
          if (now === list.last) continue;
          list.last = now;
          const event = { type: "change", matches: now, media: list.media };
          for (const fn of list.listeners) fn(event);
          if (typeof list.onchange === "function") list.onchange(event);
        }
      });
    },
  };
}

interface LiveList {
  readonly media: string;
  last: boolean;
  readonly listeners: Set<(event: { readonly type: string }) => void>;
  onchange: ((event: { type: string }) => void) | null;
}

function serializedQuery(query: unknown): string {
  const raw = typeof query === "string"
    ? query
    : typeof query === "number" || typeof query === "boolean" || typeof query === "bigint"
      ? String(query)
      : "";
  return serializeMediaQueryList(raw);
}

export function createMatchMedia(
  env: MediaEnvironment | (() => MediaEnvironment) = DEFAULT_MEDIA_ENVIRONMENT,
): (query: unknown) => MediaQueryListLike {
  const read = typeof env === "function" ? env : () => env;
  return (query: unknown) => {
    const media = serializedQuery(query);
    return {
      matches: mediaQueryListMatches(media, read()),
      media,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  };
}
