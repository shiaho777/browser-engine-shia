/**
 * `navigator.preferences` — per-document overrides that `matchMedia` reads.
 *
 * Each preference has a fallback (the engine default), an override that starts
 * unset, and a change callback. `requestOverride` rejects values outside
 * `validValues`. Clearing the override restores the fallback. `matchMedia`
 * sees the effective value on the next call.
 */
import { DOMException } from "@browser-engine/guest";
import type { MediaEnvironment } from "@browser-engine/css-parser";

interface Preference {
  readonly value: string;
  readonly override: string | null;
  readonly validValues: readonly string[];
  onchange: ((event: { readonly type: "change" }) => void) | null;
  requestOverride(value: unknown): Promise<void>;
  clearOverride(): Promise<void>;
}

export interface MediaPreferences {
  readonly api: {
    readonly colorScheme: Preference;
    readonly contrast: Preference;
    readonly reducedData: Preference;
    readonly reducedMotion: Preference;
    readonly reducedTransparency: Preference;
  };
  environment(base: MediaEnvironment): MediaEnvironment;
}

export function createMediaPreferences(): MediaPreferences {
  const colorScheme = preference(["light", "dark"], "light");
  const contrast = preference(["more", "less", "no-preference"], "no-preference");
  const reducedData = preference(["reduce", "no-preference"], "no-preference");
  const reducedMotion = preference(["reduce", "no-preference"], "no-preference");
  const reducedTransparency = preference(["reduce", "no-preference"], "no-preference");
  return {
    api: { colorScheme, contrast, reducedData, reducedMotion, reducedTransparency },
    environment(base) {
      const scheme = colorScheme.value === "dark" ? "dark" : "light";
      const contrastValue = contrast.value;
      return {
        ...base,
        prefersColorScheme: scheme,
        prefersContrast: contrastValue === "more" || contrastValue === "less" || contrastValue === "custom"
          ? contrastValue
          : "no-preference",
        prefersReducedMotion: reducedMotion.value === "reduce",
        prefersReducedTransparency: reducedTransparency.value === "reduce",
        prefersReducedData: reducedData.value === "reduce",
      };
    },
  };
}

function preference(validValues: readonly string[], fallback: string): Preference {
  let override: string | null = null;
  const pref: Preference = {
    get value() {
      return override ?? fallback;
    },
    get override() {
      return override;
    },
    validValues,
    onchange: null,
    requestOverride(value: unknown) {
      if (value === null || value === "") {
        override = null;
        emit(pref);
        return Promise.resolve();
      }
      if (typeof value !== "string" || !validValues.includes(value)) {
        return Promise.reject(new DOMException(`Invalid preference value`, "TypeError"));
      }
      override = value;
      emit(pref);
      return Promise.resolve();
    },
    clearOverride() {
      override = null;
      emit(pref);
      return Promise.resolve();
    },
  };
  return pref;
}

function emit(pref: Preference): void {
  const handler = pref.onchange;
  if (typeof handler === "function") handler({ type: "change" });
}
