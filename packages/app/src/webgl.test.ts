/**
 * RFC 0036 — `<canvas>` + `getContext("webgl")` end-to-end: a guest script
 * drives the software GL device (GLSL compile → vertex shading → barycentric
 * raster → depth/blend → framebuffer); the framebuffer rides the same
 * `imageOf` canvas channel as Canvas 2D into the rendered page PNG.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodePng } from "@browser-engine/test-harness";

import { loadPage } from "./page.js";

const VIEWPORT = { width: 800, height: 600, devicePixelRatio: 1 };

function pixelAt(png: Uint8Array, w: number, x: number, y: number): [number, number, number, number] {
  const d = decodePng(png).data;
  const i = (y * w + x) * 4;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

void test("a guest WebGL triangle paints into the rendered page PNG", async () => {
  const html = `<!doctype html><title>t</title><body style="margin:0">
    <canvas id="c" width="64" height="64"></canvas>
    <script>
      const gl = document.getElementById("c").getContext("webgl");
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, "attribute vec2 p; void main(){ gl_Position=vec4(p,0.,1.); }");
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, "precision mediump float; void main(){ gl_FragColor=vec4(1.,0.,0.,1.); }");
      gl.compileShader(fs);
      const pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      gl.useProgram(pr);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 0,1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, "p");
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc);
      gl.clearColor(0,0,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    </script></body>`;
  const page = await loadPage(html, { viewport: VIEWPORT, runScripts: true });
  assert.ok(page !== null && page.pngBytes !== undefined);
  // Locate the painted canvas box by its blue clear color, then assert
  // relative to it (inline canvas can shift with the text run before it).
  const d = decodePng(page.pngBytes).data;
  let cx = -1;
  let cy = -1;
  outer: for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 160; x++) {
      const i = (y * VIEWPORT.width + x) * 4;
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 255 && d[i + 3] === 255) {
        cx = x;
        cy = y;
        break outer;
      }
    }
  }
  assert.ok(cx >= 0 && cy >= 0, "blue-cleared canvas should appear in the PNG");
  // bottom-center of the canvas: inside the triangle → red.
  const inside = pixelAt(page.pngBytes, VIEWPORT.width, cx + 30, cy + 55);
  assert.deepEqual(inside, [255, 0, 0, 255], `inside px ${inside.join(",")}`);
  // top-left of the canvas box: outside the triangle → blue clear color.
  const outside = pixelAt(page.pngBytes, VIEWPORT.width, cx, cy);
  assert.deepEqual(outside, [0, 0, 255, 255], `outside px ${outside.join(",")}`);
});

void test("varyings + depth test reach the page PNG (gradient, nearer wins)", async () => {
  const html = `<!doctype html><title>t</title><body style="margin:0">
    <canvas id="c" width="32" height="32"></canvas>
    <script>
      const gl = document.getElementById("c").getContext("webgl");
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs,
        "attribute vec4 p; attribute vec3 c; varying vec3 v; void main(){ v=c; gl_Position=p; }");
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs,
        "precision mediump float; varying vec3 v; void main(){ gl_FragColor=vec4(v,1.); }");
      gl.compileShader(fs);
      const pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      gl.useProgram(pr);
      gl.enable(gl.DEPTH_TEST);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      // two overlapping tris: far blue, near green — near must win.
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1,-1, 0.6,1,  0,0,1,   1,-1, 0.6,1,  0,0,1,   0,1, 0.6,1,  0,0,1,
        -1,-1, 0.0,1,  0,1,0,   1,-1, 0.0,1,  0,1,0,   0,1, 0.0,1,  0,1,0,
      ]), gl.STATIC_DRAW);
      const pl = gl.getAttribLocation(pr, "p");
      const cl = gl.getAttribLocation(pr, "c");
      gl.vertexAttribPointer(pl, 4, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(pl);
      gl.vertexAttribPointer(cl, 3, gl.FLOAT, false, 28, 16);
      gl.enableVertexAttribArray(cl);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    </script></body>`;
  const page = await loadPage(html, { viewport: VIEWPORT, runScripts: true });
  assert.ok(page !== null);
  const p = pixelAt(page.pngBytes, VIEWPORT.width, 16, 26);
  assert.ok(p[1] > 150 && p[0] < 60, `near green should win, got ${p.join(",")}`);
});
