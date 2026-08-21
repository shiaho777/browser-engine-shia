export interface EngineViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio?: number;
}

export interface EngineFrame {
  readonly url: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly pngBase64: string;
  readonly frameRev?: number;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface EngineNavState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly url: string;
}

export interface EngineHitInfo {
  readonly x: number;
  readonly y: number;
  readonly nodeId: string | null;
  readonly tag: string | null;
  readonly href: string | null;
  readonly cursor: "default" | "pointer";
}

export interface EngineClickResult {
  readonly hit: EngineHitInfo;
  readonly navigated: boolean;
  readonly frame: EngineFrame;
}

export interface EngineHost {
  navigate(target: string, viewport?: EngineViewport): Promise<EngineFrame>;
  loadHtml(html: string, title?: string, viewport?: EngineViewport): Promise<EngineFrame>;
  back(viewport?: EngineViewport): Promise<EngineFrame | null>;
  forward(viewport?: EngineViewport): Promise<EngineFrame | null>;
  reload(viewport?: EngineViewport): Promise<EngineFrame | null>;
  setViewport(viewport: EngineViewport): Promise<EngineFrame | null>;
  hitTest(x: number, y: number): Promise<EngineHitInfo> | EngineHitInfo;
  click(x: number, y: number, viewport?: EngineViewport): Promise<EngineClickResult>;
  navState(): EngineNavState;
}

export const DEFAULT_APP_VIEWPORT: EngineViewport = Object.freeze({
  width: 1024,
  height: 720,
});

export function normalizeViewport(
  input: Partial<EngineViewport> | null | undefined,
  fallback: EngineViewport = DEFAULT_APP_VIEWPORT,
): EngineViewport {
  const width = Number(input?.width);
  const height = Number(input?.height);
  const dprIn = Number(input?.devicePixelRatio ?? fallback.devicePixelRatio ?? 1);
  const devicePixelRatio =
    Number.isFinite(dprIn) && dprIn >= 1 ? Math.min(Math.max(dprIn, 1), 3) : 1;
  return {
    width: Number.isFinite(width) && width >= 200 ? Math.min(Math.floor(width), 4096) : fallback.width,
    height: Number.isFinite(height) && height >= 200 ? Math.min(Math.floor(height), 4096) : fallback.height,
    devicePixelRatio,
  };
}

export function viewportChanged(a: EngineViewport, b: EngineViewport, tolerance = 2): boolean {
  return Math.abs(a.width - b.width) > tolerance || Math.abs(a.height - b.height) > tolerance;
}
