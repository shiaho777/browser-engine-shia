# RFC 0035 — `<video>`/`<audio>`: real decode + playback through a platform codec bridge

Status: implemented. `<video>` and `<audio>` fetch their resource through the
document's real network stack (`destination: "video"|"audio"`, `media-src`
gated, `crossorigin`→CORS, COEP honored), probe it through a decoder layer
(pure-TS RIFF/WAVE + an ffmpeg/ffprobe subprocess bridge), and drive the
full HTMLMediaElement state machine — resource selection, events, seeking,
looping, `ended` — on the page's own virtual event-loop clock. Decoded video
frames ride the same `DecodedImage`/`imageOf` channel as `<img>`/`<canvas>`
into paint.

## Decision

**One invariant: media bytes never reach a decoder without passing every
request-level gate — the fetch adapter IS `BrowserNetworkStack.request()`,
not a side channel.**

### The decoder layer (`cli/media.ts`)

`MediaDecoder` is a capability interface:

```ts
probe(bytes) → MediaProbeResult | null   // duration, A/V streams, mime
frameAt(bytes, tSec) → DecodedImage | null
decodeAudio(bytes) → DecodedAudio | null // interleaved float32 PCM
```

Two ship:

- `wavDecoder()` — pure-TS RIFF/WAVE: parses `fmt`/`data` chunks, decodes
  PCM 8/16/24/32-int and float32 to interleaved float32. No subprocess.
- `ffmpegDecoder()` — shells to `ffprobe`/`ffmpeg` when on PATH (probed
  once, self-disables absent): JSON stream/format probe, `frameAt` extracts
  one frame as raw RGBA via `-f rawvideo -pix_fmt rgba`, audio via
  `-f f32le`. MP4/H.264+AAC, WebM, OGG, MP3, FLAC — whatever the host
  ffmpeg supports.

`canPlayType` consults the LIVE decoder set: `""` / `maybe` / `probably`
(per spec: `probably` iff the mime+codecs string is fully understood —
a container without a `codecs=` hint only earns `maybe`).

### The MediaEngine

Per-document (created unconditionally in `engine-runtime` — a scriptless
page still loads/probes/frames `<video>` through the same pass that fetches
`<img>`):

- **Resource selection** — HTML §"concept: media element load algorithm":
  `src` wins; else first `<source>` child whose `type` passes
  `canPlayMime` and whose `media` list matches `mediaQueryListMatches`
  against the page's `MediaEnvironment`. Failure walks the remaining
  `<source>`s; exhaustion → `MEDIA_ERR_SRC_NOT_SUPPORTED` + `error` event
  + `source-error` on the rejected child.
- **Fetch** — through the injected `fetchMedia` (engine-runtime builds it
  on `network.request`): `no-cors`+include default; `crossorigin` upgrades
  to `cors` (`anonymous`→omit-creds, `use-credentials`→include). `mediaAllowed`
  is the CSP `media-src` check — consulted BEFORE any bytes move. COEP
  `initiatorCoep` and the document referrer policy ride the same adapter.
- **The clock** — `MediaClock` is injected from the page's
  `VirtualEventLoop` (`loop.now()` + `loop.setTimeout`): `currentTime`
  advances exactly with the virtual timeline, `ended` fires on a real
  loop timer, `timeupdate` ticks ~4Hz — playback is fully deterministic in
  tests and in headless runs there is no second clock to drift.
- **Events** — `loadstart`, `loadedmetadata`, `loadeddata`, `canplay`,
  `canplaythrough`, `play`, `playing`, `pause`, `seeking`, `seeked`,
  `timeupdate`, `ended`, `volumechange`, `ratechange`, `durationchange`,
  `emptied`, `error` — dispatched through the document API's ordinary
  event channel so guest listeners and IDL `on*` handlers both fire.
- **Frames** — `materialize()` pulls `frameAt(currentTime)` (or the poster
  image when present/earlier) into `st.paintFrame`; `frames()` is the
  paint-time view `page.ts` merges into the decoded-image map. Frame
  results cache per-millisecond — repaint at the same `currentTime` is free.
- **`prime()`** — called inside `page.ts`'s resource pass (alongside
  stylesheets/fonts/images): kicks `ensureLoaded` per element per
  `preload`/`autoplay`, and — critically — awaits any load already in
  flight from a script's `play()` so the paint pass sees materialized
  frames, not a race.

### The IDL surface (`mediaDescriptors`)

`script.ts` installs own-property descriptors on `<video>`/`<audio>`
wrappers when a MediaEngine is present (absent → the elements degrade to
plain HTMLElement behavior, honest):

`src`/`currentSrc`, `crossOrigin`, `preload`, `autoplay`, `loop`,
`controls`, `defaultMuted`/`muted`, `volume`, `playbackRate`,
`defaultPlaybackRate`, `currentTime`, `duration`, `paused`, `ended`,
`seeking`, `readyState`, `networkState`, `error`, `play()`, `pause()`,
`load()`, `canPlayType()`, `buffered`/`seekable`/`played` (real
`TimeRanges`-shaped objects), `videoWidth`/`videoHeight`, `poster`,
`addTextTrack` (stubbed honest — returns a dead TextTrack). Prototype chain:
`HTMLVideoElement`/`HTMLAudioElement` → `HTMLMediaElement` → `HTMLElement`
— `el instanceof HTMLMediaElement` holds. `new Audio(src)` builds a
detached `<audio>` per spec.

### Layout + UA sheet

- `<video>` is a replaced element: intrinsic size = probed dimensions,
  falling back to the HTML default-object size 300×150.
- `<audio>` is a replaced box ONLY with `controls` (300×54 placeholder —
  no widget toolkit exists to paint); UA `audio:not([controls]){display:none}`.
- `video { object-fit: contain }` — decoded frames letterbox through the
  existing image-paint fit path.

### Teardown

`MediaEngine.dispose()` clears every pending loop timer and drops state;
`BrowsingContext.dispose()` calls it next to `disposeWorkers` — a playing
`<video>` leaves no timers or subprocesses behind (decoder subprocesses are
already request-scoped `execFile`).

## Honest boundaries

- **Whole-file buffering** — no Range/streaming: `buffered`/`seekable`
  report `[0, duration]` once loaded; `stalled`/`waiting` never fire.
- **No audible output** — audio decodes to PCM (`decodeAudio`) and the
  timeline/events advance like a muted tab. `muted`/`volume` are stateful
  but nothing reaches a speaker.
- **Frames decode on demand** — each repaint shows the frame at
  `currentTime`; no autonomous decoder-side repaint loop.
- **No text tracks/EME/remote playback** — `addTextTrack` returns an inert
  TextTrack; no `<track>` fetching, cues, DRM, or `remote` object.
- **ffmpeg bridge is a host dependency** — absent ffmpeg, only WAV decodes;
  `canPlayType`/`canPlaySource` narrow accordingly (an honest
  capability probe, not a stub).
- **`captureStream`/`MediaSource`/`MediaStream` absent** — MSE/DASH live
  streaming and media capture are out of scope.
- **Poster paints before first frame** and only while `readyState` is
  below HAVE_CURRENT_DATA — matching the spec's poster-show rules.

## Verified

- `cli/media.test.ts` 10/10 — WAV parse, ffmpeg probe/frame/PCM,
  `canPlayType`, play→ended on the loop clock, pause/seek clamp + events,
  `<source>` type/media fallback, loop replay, `preload=none`, autoplay,
  `media-src` refusal, `frames()` after `prime()`.
- `app/media.test.ts` 4/4 — real HTTP server: page `<video>` fetches
  through the stack and paints a decoded red frame in the PNG;
  play/playing/ended ordered delivery on the real-time loop; `media-src
  'none'` produces zero wire hits + element error; `preload="none"` fetches
  only after `play()`.
