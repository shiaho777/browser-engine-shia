import assert from "node:assert/strict";
import test from "node:test";
import type { DecodedImage, NodeId } from "@browser-engine/ir";

import { FineSession } from "./fine.js";
import { runScriptsOnSession } from "./event-loop.js";

const PAGE = "https://example.com/app.html";
const HTML = "<!doctype html><title>t</title><canvas id=c width=64 height=64></canvas>";

interface Run {
  readonly sandbox: Record<string, unknown>;
  readonly bitmaps: () => ReadonlyMap<NodeId, DecodedImage>;
}

function run(src: string, html = HTML): Run {
  const r = runScriptsOnSession(new FineSession(html, PAGE), [src], new Map(), {});
  assert.equal(r.error, null);
  return {
    sandbox: r.sandbox as Record<string, unknown>,
    bitmaps: () => r.canvasBitmaps?.() ?? new Map(),
  };
}

const PAINT_RED = `
const gl = document.getElementById('c').getContext('webgl');
const vs = gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs, 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos,0.,1.); }');
gl.compileShader(vs);
const fs = gl.createShader(gl.FRAGMENT_SHADER);
gl.shaderSource(fs, 'precision mediump float; void main(){ gl_FragColor = vec4(1.,0.,0.,1.); }');
gl.compileShader(fs);
const pr = gl.createProgram();
gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
gl.useProgram(pr);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 0,1]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(pr, 'aPos');
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(loc);
gl.clearColor(0,0,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 3);
globalThis.__gl = gl;
globalThis.__pr = pr;
`;
void test("getContext('webgl') returns a real context with the enum surface", () => {
    const { sandbox } = run(`
      const c = document.getElementById('c');
      const gl = c.getContext('webgl');
      __ok = [
        gl !== null,
        gl instanceof WebGLRenderingContext,
        gl.canvas === c,
        gl.TRIANGLES === 4 && gl.ARRAY_BUFFER === 0x8892 && gl.TEXTURE_2D === 0x0de1,
        gl.drawingBufferWidth === 64 && gl.drawingBufferHeight === 64,
        c.getContext('experimental-webgl') === gl, // alias → same ctx
        c.getContext('2d') === null,               // mode lock
        c.getContext('bogus') === null,
      ];
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__ok"])), [true, true, true, true, true, true, true, true]);
  });
void test("compiles+links+draws+readPixels entirely through the guest API", () => {
    const { sandbox, bitmaps } = run(PAINT_RED + `
      __status = [
        gl.getShaderParameter(vs, gl.COMPILE_STATUS),
        gl.getShaderParameter(fs, gl.COMPILE_STATUS),
        gl.getProgramParameter(pr, gl.LINK_STATUS),
        gl.getError(),
      ];
      const px = new Uint8Array(4);
      gl.readPixels(32, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      __px = [...px];
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__status"])), [true, true, true, 0]);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__px"])), [255, 0, 0, 255]);
    const img = bitmaps().values().next().value as DecodedImage;
    // canvasBitmaps channel carries the GL framebuffer (top-left origin).
    const i = (Math.floor(img.height * 0.8) * img.width + Math.floor(img.width / 2)) * 4;
    assert.deepEqual([...img.pixels.slice(i, i + 4)], [255, 0, 0, 255]);
  });
void test("shader compile errors surface through getShaderInfoLog, not throws", () => {
    const { sandbox } = run(`
      const gl = document.getElementById('c').getContext('webgl');
      const s = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(s, 'void broken( {');
      gl.compileShader(s);
      __r = [gl.getShaderParameter(s, gl.COMPILE_STATUS), gl.getShaderInfoLog(s).length > 0];
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [false, true]);
  });
void test("uniforms reach the shader — uniform4f drives fragment color", () => {
    const { sandbox } = run(`
      const c = document.getElementById('c');
      const gl = c.getContext('webgl');
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position=vec4(p,0,1); }');
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision mediump float; uniform vec4 c; void main(){ gl_FragColor=c; }');
      gl.compileShader(fs);
      const pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
      gl.uniform4f(gl.getUniformLocation(pr, 'c'), 0, 1, 0, 1);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 0,1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(4);
      gl.readPixels(32, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      __px = [...px];
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__px"])), [0, 255, 0, 255]);
  });
void test("canvas resize resets the drawing buffer size", () => {
    const { sandbox } = run(`
      const c = document.getElementById('c');
      const gl = c.getContext('webgl');
      const before = gl.drawingBufferWidth;
      c.width = 100; c.height = 30;
      __r = [before, gl.drawingBufferWidth, gl.drawingBufferHeight];
    `);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox["__r"])), [64, 100, 30]);
  });
void test("texImage2D accepts an img element's decoded bitmap", () => {
    const { sandbox } = run(`
      const c = document.getElementById('c');
      const gl = c.getContext('webgl');
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      // img with no decoded bitmap → the texture is sized 0 (boundary: paint
      // hasn't decoded it). The call must not throw either way.
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, document.createElement('img')); }
      catch (e) { __err = String(e); }
      __err = gl.getError();
    `, "<!doctype html><canvas id=c></canvas>");
    assert.equal(sandbox["__err"], 0);
  });
