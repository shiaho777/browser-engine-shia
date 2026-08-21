import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseTrueType } from "./truetype.js";
import type { FontFace } from "./types.js";

export function loadTrueTypeFontFromBytes(bytes: Uint8Array): FontFace | null {
  try {
    return parseTrueType(bytes);
  } catch {
    return null;
  }
}

export async function loadTrueTypeFontFromUrl(
  url: string,
  fetchFn: (url: string) => Promise<Uint8Array>,
): Promise<FontFace | null> {
  try {
    const bytes = await fetchFn(url);
    return loadTrueTypeFontFromBytes(bytes);
  } catch {
    return null;
  }
}

export function discoverSystemFontDirs(): string[] {
  const platform = process.platform;
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  switch (platform) {
    case "darwin":
      return [
        "/System/Library/Fonts",
        "/Library/Fonts",
        `${home}/Library/Fonts`,
        "/System/Library/Fonts/Supplemental",
      ];
    case "linux":
      return [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        `${home}/.fonts`,
        `${home}/.local/share/fonts`,
      ];
    case "win32":
      return ["C:\\Windows\\Fonts"];
    default:
      return [];
  }
}

const PREFERRED_SYSTEM_TTF_PATHS: readonly string[] = [
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "C:\\Windows\\Fonts\\arialuni.ttf",
  "C:\\Windows\\Fonts\\msyh.ttf",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

export function preferredSystemTrueTypePaths(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const p of PREFERRED_SYSTEM_TTF_PATHS) push(p);
  for (const dir of discoverSystemFontDirs()) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!/\.ttf$/i.test(name)) continue;
        if (/arial unicode|notosanscjk|notoserifcjk|sourcehansans|wqy|droidsansfallback|uming|ukai/i.test(name)) {
          push(join(dir, name));
        }
      }
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
  }
  return out;
}

export function loadTrueTypeFontFromPath(path: string): FontFace | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (!/\.ttf$/i.test(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    return loadTrueTypeFontFromBytes(bytes);
  } catch {
    return null;
  }
}

export function loadPreferredSystemFont(): FontFace | null {
  let latin: FontFace | null = null;
  for (const path of preferredSystemTrueTypePaths()) {
    const face = loadTrueTypeFontFromPath(path);
    if (face === null || face.numGlyphs <= 200) continue;
    if (face.glyphIdForCodePoint(0x4e2d) !== 0) return face;
    if (latin === null) latin = face;
  }
  return latin;
}

const PREFERRED_SYSTEM_BOLD_TTF_PATHS: readonly string[] = [
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
  "C:\\Windows\\Fonts\\msyhbd.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
];

export function loadPreferredSystemBoldFont(): FontFace | null {
  for (const path of PREFERRED_SYSTEM_BOLD_TTF_PATHS) {
    const face = loadTrueTypeFontFromPath(path);
    if (face === null || face.numGlyphs <= 200) continue;
    return face;
  }
  for (const dir of discoverSystemFontDirs()) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!/\.ttf$/i.test(name)) continue;
        if (!/bold|bd|heavy|black/i.test(name)) continue;
        if (/italic|oblique/i.test(name)) continue;
        const face = loadTrueTypeFontFromPath(join(dir, name));
        if (face !== null && face.numGlyphs > 200) return face;
      }
    } catch {
      // Guest/page code may throw here; swallowed by design.
    }
  }
  return null;
}
