/**
 * Event system: Event, EventTarget (addEventListener/removeEventListener/
 * dispatchEvent), MouseEvent, KeyboardEvent, and related event types.
 *
 * Event dispatch follows the DOM spec: capture phase (root → target),
 * target phase, bubble phase (target → root). Listeners can be registered
 * for capture or bubble. `stopPropagation()` halts dispatch; `preventDefault()`
 * cancels the default action.
 *
 * All event classes are guest-constructible (new Event("click"), etc.) so
 * guest JS can create and dispatch synthetic events.
 */
// No IR imports needed — the event system is self-contained.

// ---------------------------------------------------------------------------
// EventImpl
// ---------------------------------------------------------------------------

export class EventImpl {
  #type: string;
  #bubbles: boolean;
  #cancelable: boolean;
  #defaultPrevented = false;
  #propagationStopped = false;
  #immediatePropagationStopped = false;
  #target: unknown = null;
  #currentTarget: unknown = null;
  #eventPhase = 0; // 0=none, 1=capturing, 2=at_target, 3=bubbling
  #trusted = false;
  readonly #timeStamp = performance.now();

  constructor(type?: string, init?: EventInit) {
    // WebIDL: the `type` argument is mandatory and converted via DOMString,
    // so a non-string (or its exotic toString) coerces here.
    if (type === undefined) {
      throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
    }
    this.#type = String(type);
    this.#bubbles = init?.bubbles ?? false;
    this.#cancelable = init?.cancelable ?? false;
  }

  get type(): string { return this.#type; }
  get bubbles(): boolean { return this.#bubbles; }
  get cancelable(): boolean { return this.#cancelable; }
  get defaultPrevented(): boolean { return this.#defaultPrevented; }
  get target(): unknown { return this.#target; }
  /** Legacy alias of {@link target}. */
  get srcElement(): unknown { return this.#target; }
  get currentTarget(): unknown { return this.#currentTarget; }
  get eventPhase(): number { return this.#eventPhase; }
  get isTrusted(): boolean { return this.#trusted; }

  /** Platform-dispatched events are trusted; guest-constructed ones are not. @internal */
  _setTrusted(value: boolean): void { this.#trusted = value; }
  get timeStamp(): number { return this.#timeStamp; }

  /** Legacy `returnValue`: mirrors (and can clear) the canceled flag. */
  get returnValue(): boolean { return !this.#defaultPrevented; }
  set returnValue(value: unknown) {
    if (!value) this.preventDefault();
  }

  /**
   * Legacy `cancelBubble`: reads the stop-propagation flag; setting `true`
   * stops propagation (setting `false` never revives a stopped event).
   */
  get cancelBubble(): boolean { return this.#propagationStopped || this.#immediatePropagationStopped; }
  set cancelBubble(value: unknown) {
    if (value) this.stopPropagation();
  }

  /** @internal */
  _setTarget(t: unknown): void { this.#target = t; }
  /** @internal */
  _setCurrentTarget(t: unknown): void { this.#currentTarget = t; }
  /** @internal */
  _setPhase(p: number): void { this.#eventPhase = p; }
  /** @internal */
  _propagationStopped(): boolean { return this.#propagationStopped || this.#immediatePropagationStopped; }
  /** @internal */
  _immediatePropagationStopped(): boolean { return this.#immediatePropagationStopped; }
  /** @internal */
  _resetDispatchState(): void {
    this.#propagationStopped = false;
    this.#immediatePropagationStopped = false;
    this.#eventPhase = 0;
  }

  preventDefault(): void {
    if (this.#cancelable) this.#defaultPrevented = true;
  }

  stopPropagation(): void {
    this.#propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.#propagationStopped = true;
    this.#immediatePropagationStopped = true;
  }

  /**
   * The legacy initializer (DOM §2.2 initEvent): re-type the event and reset
   * every dispatch flag. A no-op while the event is being dispatched.
   */
  initEvent(type?: unknown, bubbles?: unknown, cancelable?: unknown): void {
    if (this.#eventPhase !== 0) return;
    this.#type = String(type);
    this.#bubbles = Boolean(bubbles);
    this.#cancelable = Boolean(cancelable);
    this.#defaultPrevented = false;
    this.#propagationStopped = false;
    this.#immediatePropagationStopped = false;
    this.#eventPhase = 0;
  }

  /** Phase constants shared with EventTarget (DOM §3.1). */
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;
}

export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
}

// ---------------------------------------------------------------------------
// UIEventImpl
// ---------------------------------------------------------------------------

export class UIEventImpl extends EventImpl {
  readonly #detail: number;
  readonly #view: unknown;

  constructor(type?: string, init?: UIEventInit & EventInit) {
    super(type, init);
    this.#detail = init?.detail ?? 0;
    this.#view = init?.view ?? null;
  }

  get detail(): number { return this.#detail; }
  get view(): unknown { return this.#view; }
}

export interface UIEventInit extends EventInit {
  detail?: number;
  view?: unknown;
}

// ---------------------------------------------------------------------------
// MouseEventImpl
// ---------------------------------------------------------------------------

export class MouseEventImpl extends UIEventImpl {
  readonly #screenX: number;
  readonly #screenY: number;
  readonly #clientX: number;
  readonly #clientY: number;
  readonly #button: number;
  readonly #buttons: number;
  readonly #ctrlKey: boolean;
  readonly #shiftKey: boolean;
  readonly #altKey: boolean;
  readonly #metaKey: boolean;
  readonly #relatedTarget: unknown;

  constructor(type?: string, init?: MouseEventInit & UIEventInit & EventInit) {
    super(type, init);
    this.#screenX = init?.screenX ?? 0;
    this.#screenY = init?.screenY ?? 0;
    this.#clientX = init?.clientX ?? 0;
    this.#clientY = init?.clientY ?? 0;
    this.#button = init?.button ?? 0;
    this.#buttons = init?.buttons ?? 0;
    this.#ctrlKey = init?.ctrlKey ?? false;
    this.#shiftKey = init?.shiftKey ?? false;
    this.#altKey = init?.altKey ?? false;
    this.#metaKey = init?.metaKey ?? false;
    this.#relatedTarget = init?.relatedTarget ?? null;
  }

  get screenX(): number { return this.#screenX; }
  get screenY(): number { return this.#screenY; }
  get clientX(): number { return this.#clientX; }
  get clientY(): number { return this.#clientY; }
  get pageX(): number { return this.#clientX; }
  get pageY(): number { return this.#clientY; }
  get button(): number { return this.#button; }
  get buttons(): number { return this.#buttons; }
  get ctrlKey(): boolean { return this.#ctrlKey; }
  get shiftKey(): boolean { return this.#shiftKey; }
  get altKey(): boolean { return this.#altKey; }
  get metaKey(): boolean { return this.#metaKey; }
  get relatedTarget(): unknown { return this.#relatedTarget; }

  getModifierState(keyArg: string): boolean {
    switch (keyArg) {
      case "Control": return this.#ctrlKey;
      case "Shift": return this.#shiftKey;
      case "Alt": return this.#altKey;
      case "Meta": return this.#metaKey;
      default: return false;
    }
  }
}

export interface MouseEventInit extends UIEventInit {
  screenX?: number;
  screenY?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
  buttons?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  relatedTarget?: unknown;
}

// ---------------------------------------------------------------------------
// KeyboardEventImpl
// ---------------------------------------------------------------------------

export class KeyboardEventImpl extends UIEventImpl {
  readonly #key: string;
  readonly #code: string;
  readonly #location: number;
  readonly #ctrlKey: boolean;
  readonly #shiftKey: boolean;
  readonly #altKey: boolean;
  readonly #metaKey: boolean;
  readonly #repeat: boolean;
  readonly #isComposing: boolean;

  constructor(type?: string, init?: KeyboardEventInit & UIEventInit & EventInit) {
    super(type, init);
    this.#key = init?.key ?? "";
    this.#code = init?.code ?? "";
    this.#location = init?.location ?? 0;
    this.#ctrlKey = init?.ctrlKey ?? false;
    this.#shiftKey = init?.shiftKey ?? false;
    this.#altKey = init?.altKey ?? false;
    this.#metaKey = init?.metaKey ?? false;
    this.#repeat = init?.repeat ?? false;
    this.#isComposing = init?.isComposing ?? false;
  }

  get key(): string { return this.#key; }
  get code(): string { return this.#code; }
  get location(): number { return this.#location; }
  get ctrlKey(): boolean { return this.#ctrlKey; }
  get shiftKey(): boolean { return this.#shiftKey; }
  get altKey(): boolean { return this.#altKey; }
  get metaKey(): boolean { return this.#metaKey; }
  get repeat(): boolean { return this.#repeat; }
  get isComposing(): boolean { return this.#isComposing; }

  getModifierState(keyArg: string): boolean {
    switch (keyArg) {
      case "Control": return this.#ctrlKey;
      case "Shift": return this.#shiftKey;
      case "Alt": return this.#altKey;
      case "Meta": return this.#metaKey;
      default: return false;
    }
  }
}

export interface KeyboardEventInit extends UIEventInit {
  key?: string;
  code?: string;
  location?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

// ---------------------------------------------------------------------------
// CustomEventImpl
// ---------------------------------------------------------------------------

export class CustomEventImpl extends EventImpl {
  #detail: unknown = null;

  constructor(type?: string, init?: CustomEventInit & EventInit) {
    super(type, init);
    this.#detail = init?.detail ?? null;
  }

  get detail(): unknown { return this.#detail; }

  /** The legacy initializer; `type` is mandatory (WebIDL required argument). */
  initCustomEvent(type?: unknown, bubbles?: unknown, cancelable?: unknown, detail?: unknown): void {
    if (type === undefined) {
      throw new TypeError("Failed to execute 'initCustomEvent': 1 argument required, but only 0 present.");
    }
    this.initEvent(type, bubbles, cancelable);
    this.#detail = detail ?? null;
  }
}

export interface CustomEventInit extends EventInit {
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// FocusEventImpl
// ---------------------------------------------------------------------------

export class FocusEventImpl extends UIEventImpl {
  readonly #relatedTarget: unknown;

  constructor(type?: string, init?: FocusEventInit & UIEventInit & EventInit) {
    super(type, init);
    this.#relatedTarget = init?.relatedTarget ?? null;
  }

  get relatedTarget(): unknown { return this.#relatedTarget; }
}

export interface FocusEventInit extends UIEventInit {
  relatedTarget?: unknown;
}

// ---------------------------------------------------------------------------
// InputEventImpl
// ---------------------------------------------------------------------------

export class InputEventImpl extends UIEventImpl {
  readonly #data: string | null;
  readonly #inputType: string;
  readonly #isComposing: boolean;

  constructor(type?: string, init?: InputEventInit & UIEventInit & EventInit) {
    super(type, init);
    this.#data = init?.data ?? null;
    this.#inputType = init?.inputType ?? "";
    this.#isComposing = init?.isComposing ?? false;
  }

  get data(): string | null { return this.#data; }
  get inputType(): string { return this.#inputType; }
  get isComposing(): boolean { return this.#isComposing; }
}

export interface InputEventInit extends UIEventInit {
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
}

// ---------------------------------------------------------------------------
// EventTargetImpl — the event registration + dispatch engine
// ---------------------------------------------------------------------------

interface EventListenerEntry {
  readonly type: string;
  readonly listener: EventListenerCallback;
  readonly capture: boolean;
  readonly once: boolean;
  readonly passive: boolean;
}

type EventListenerCallback = (event: EventImpl) => void;

/**
 * A mixin/implementation of EventTarget. Any object can have event listeners
 * by delegating to an EventTargetImpl instance.
 */
export class EventTargetImpl {
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;

  readonly #listeners = new Map<string, EventListenerEntry[]>();

  addEventListener(type: string, listener: unknown, options?: AddEventListenerOptions | boolean): void {
    if (typeof listener !== "function") return;
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const once = typeof options === "boolean" ? false : (options?.once ?? false);
    const passive = typeof options === "boolean" ? false : (options?.passive ?? false);
    const signal = typeof options === "boolean" ? undefined : options?.signal;

    // DOM §3.2: an already-aborted signal means the listener is never added.
    if (signal?.aborted) return;

    let entries = this.#listeners.get(type);
    if (entries === undefined) {
      entries = [];
      this.#listeners.set(type, entries);
    }
    // Avoid duplicate registration of the same listener+capture combination.
    for (const e of entries) {
      if (e.listener === listener && e.capture === capture) return;
    }
    entries.push({ type, listener: listener as EventListenerCallback, capture, once, passive });
    signal?.addEventListener("abort", () => {
      this.removeEventListener(type, listener, capture);
    }, { once: true });
  }

  removeEventListener(type: string, listener: unknown, options?: AddEventListenerOptions | boolean): void {
    if (typeof listener !== "function") return;
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const entries = this.#listeners.get(type);
    if (entries === undefined) return;
    const idx = entries.findIndex((e) => e.listener === listener && e.capture === capture);
    if (idx !== -1) entries.splice(idx, 1);
  }

  dispatchEvent(event: EventImpl): boolean {
    // Build the propagation path: from target up to root (for bubble).
    // The target and its ancestors are determined by the event's target.
    // For now, we implement a simplified dispatch: invoke listeners on this
    // target, then bubble to parent targets if the event bubbles.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const target = this;
    event._setTarget(target);
    event._setCurrentTarget(target);
    event._setPhase(2); // AT_TARGET

    // Invoke listeners on this target.
    invokeListeners(this.#listeners, event.type, event, false); // bubble listeners

    // If the event bubbles and propagation hasn't stopped, walk up ancestors.
    if (event.bubbles && !event._propagationStopped()) {
      // Walk up the parent chain. We need a way to get the parent EventTarget.
      // This is done via the _parent property if set.
      let parent = this.#parent;
      event._setPhase(3); // BUBBLING_PHASE
      while (parent !== null && !event._propagationStopped()) {
        event._setCurrentTarget(parent);
        parent.dispatchEventInternal(event);
        parent = parent.#parent;
      }
    }

    event._setCurrentTarget(null);
    event._setPhase(0);
    return !event.defaultPrevented;
  }

  /**
   * Internal dispatch: invoke listeners without re-bubbling (the caller
   * manages the bubble walk). Invokes both capture and bubble listeners
   * depending on the current phase.
   */
  dispatchEventInternal(event: EventImpl): void {
    const phase = event.eventPhase;
    if (phase === 1) {
      // Capturing: invoke capture listeners.
      invokeListeners(this.#listeners, event.type, event, true);
    } else if (phase === 3) {
      // Bubbling: invoke bubble listeners.
      invokeListeners(this.#listeners, event.type, event, false);
    }
  }

  /**
   * Dispatch an event in capture phase from root to target.
   * Called by the top-level dispatchEvent to walk the capture path.
   */
  dispatchEventCapture(event: EventImpl): void {
    event._setPhase(1); // CAPTURING_PHASE
    event._setCurrentTarget(this);
    invokeListeners(this.#listeners, event.type, event, true);
  }

  /** Parent in the event propagation path. Set by the DOM integration. */
  #parent: EventTargetImpl | null = null;

  /** @internal */
  _setParent(p: EventTargetImpl | null): void { this.#parent = p; }

  /** @internal */
  _getListeners(): Map<string, EventListenerEntry[]> { return this.#listeners; }
}

function invokeListeners(
  listeners: Map<string, EventListenerEntry[]>,
  type: string,
  event: EventImpl,
  capture: boolean,
): void {
  const entries = listeners.get(type);
  if (entries === undefined) return;
  // Copy to allow removal during iteration.
  const copy = [...entries];
  for (const entry of copy) {
    if (entry.capture !== capture) continue;
    if (event._immediatePropagationStopped()) break;
    if (entry.once) {
      const idx = entries.indexOf(entry);
      if (idx !== -1) entries.splice(idx, 1);
    }
    try {
      entry.listener.call(undefined, event);
    } catch {
      // Listeners that throw should not prevent other listeners from running.
      // In a real browser, the error is reported but dispatch continues.
    }
  }
}

export interface AddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  /** Structurally typed so the event system does not import the abort module. */
  signal?: {
    readonly aborted: boolean;
    addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  EventImpl as Event,
  UIEventImpl as UIEvent,
  MouseEventImpl as MouseEvent,
  KeyboardEventImpl as KeyboardEvent,
  CustomEventImpl as CustomEvent,
  FocusEventImpl as FocusEvent,
  InputEventImpl as InputEvent,
  EventTargetImpl as EventTarget,
};
