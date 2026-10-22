import assert from "node:assert/strict";
import test from "node:test";

import { GL, WebGLCore } from "./gl/context.js";
import { compileGlsl } from "./gl/glsl.js";

const VS_POS = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";
const FS_SOLID = "precision mediump float; uniform vec4 uColor; void main(){ gl_FragColor = uColor; }";
const VS_VARY = "attribute vec2 aPos; attribute vec3 aCol; varying vec3 vCol; void main(){ vCol = aCol; gl_Position = vec4(aPos,0,1); }";
const FS_VARY = "precision mediump float; varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol, 1.0); }";

function program(gl: WebGLCore, vsSrc: string, fsSrc: string): ReturnType<WebGLCore["createProgram"]> {
  const vs = gl.createShader(GL.VERTEX_SHADER);
  assert.ok(vs !== null);
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  assert.equal(gl.getShaderParameter(vs, GL.COMPILE_STATUS), true, gl.getShaderInfoLog(vs));
  const fs = gl.createShader(GL.FRAGMENT_SHADER);
  assert.ok(fs !== null);
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  assert.equal(gl.getShaderParameter(fs, GL.COMPILE_STATUS), true, gl.getShaderInfoLog(fs));
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  assert.equal(gl.getProgramParameter(p, GL.LINK_STATUS), true, gl.getProgramInfoLog(p));
  return p;
}

function fullTri(gl: WebGLCore, p: NonNullable<ReturnType<WebGLCore["createProgram"]>>): void {
  gl.useProgram(p);
  const buf = gl.createBuffer();
  gl.bindBuffer(GL.ARRAY_BUFFER, buf);
  gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), GL.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, "aPos");
  gl.vertexAttribPointer(loc, 2, GL.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(loc);
}

function pixel(gl: WebGLCore, x: number, y: number): number[] {
  const out = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, out);
  return [...out];
}
void test("reports GLSL compile errors through infoLog and refuses to link", () => {
    const gl = new WebGLCore(8, 8);
    const vs = gl.createShader(GL.VERTEX_SHADER);
    assert.ok(vs !== null);
    gl.shaderSource(vs, "attribute vec2 aPos void main() {}");
    gl.compileShader(vs);
    assert.equal(gl.getShaderParameter(vs, GL.COMPILE_STATUS), false);
    assert.match(gl.getShaderInfoLog(vs), /GLSL/u);
    const p = gl.createProgram();
    const fs = gl.createShader(GL.FRAGMENT_SHADER);
    assert.ok(fs !== null);
    gl.shaderSource(fs, FS_SOLID);
    gl.compileShader(fs);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    assert.equal(gl.getProgramParameter(p, GL.LINK_STATUS), false);
    assert.match(gl.getProgramInfoLog(p), /compile/u);
  });
void test("rejects a program without main()", () => {
    const r = compileGlsl("attribute vec2 p; void helper() {}");
    assert.equal(r.ok, false);
    assert.match(r.infoLog, /main/u);
  });
void test("rasterizes a triangle — inside lit, clear color outside", () => {
    const gl = new WebGLCore(64, 64);
    const p = program(gl, VS_POS, FS_SOLID);
    fullTri(gl, p);
    gl.uniform4f(gl.getUniformLocation(p, "uColor"), 1, 0, 0, 1);
    gl.clearColor(0, 0, 1, 1);
    gl.clear(GL.COLOR_BUFFER_BIT);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.getError(), GL.NO_ERROR);
    // GL bottom-up: y=2 is near bottom → inside the -1..1 triangle.
    assert.deepEqual(pixel(gl, 32, 2), [255, 0, 0, 255]);
    assert.deepEqual(pixel(gl, 3, 60), [0, 0, 255, 255]);
  });
void test("interpolates varyings across the triangle (barycentric)", () => {
    const gl = new WebGLCore(64, 64);
    const p = program(gl, VS_VARY, FS_VARY);
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(GL.ARRAY_BUFFER, buf);
    gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, 0, 0,
      1, -1, 0, 1, 0,
      0, 1, 0, 0, 1,
    ]), GL.STATIC_DRAW);
    const aPos = gl.getAttribLocation(p, "aPos");
    const aCol = gl.getAttribLocation(p, "aCol");
    gl.vertexAttribPointer(aPos, 2, GL.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aCol, 3, GL.FLOAT, false, 20, 8);
    gl.enableVertexAttribArray(aCol);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const [r, g, b] = pixel(gl, 32, 2); // bottom-center: r+g mix
    assert.ok((r ?? 0) > 60 && (r ?? 0) < 200);
    assert.ok((g ?? 0) > 60 && (g ?? 0) < 200);
    assert.ok((b ?? 0) < 60);
    const top = pixel(gl, 32, 60); // near apex → blue dominant
    assert.ok((top[2] ?? 0) > 150 && (top[0] ?? 0) < 100);
  });
void test("honors DEPTH_TEST — nearer fragment wins, LESS is default", () => {
    const gl = new WebGLCore(16, 16);
    const vs = "attribute vec4 aPos; void main(){ gl_Position = aPos; }";
    const p = program(gl, vs, FS_SOLID);
    gl.useProgram(p);
    gl.enable(GL.DEPTH_TEST);
    const loc = gl.getAttribLocation(p, "aPos");
    const draw = (z: number, r: number, g: number, b: number): void => {
      const buf = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buf);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([
        -1, -1, z, 1, 1, -1, z, 1, 0, 1, z, 1,
      ]), GL.STATIC_DRAW);
      gl.vertexAttribPointer(loc, 4, GL.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(loc);
      gl.uniform4f(gl.getUniformLocation(p, "uColor"), r, g, b, 1);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
    };
    gl.clearColor(0, 0, 0, 1);
    gl.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    draw(0.5, 0, 1, 0); // far green first
    draw(0.0, 1, 0, 0); // near red second → wins
    assert.deepEqual(pixel(gl, 8, 2), [255, 0, 0, 255]);
    gl.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    draw(0.0, 1, 0, 0); // near first
    draw(0.5, 0, 1, 0); // far second → rejected
    assert.deepEqual(pixel(gl, 8, 2), [255, 0, 0, 255]);
    gl.disable(GL.DEPTH_TEST);
    draw(0.5, 0, 1, 0); // no depth → last writer wins
    assert.deepEqual(pixel(gl, 8, 2), [0, 255, 0, 255]);
  });
void test("blends SRC_ALPHA/ONE_MINUS_SRC_ALPHA over the clear color", () => {
    const gl = new WebGLCore(16, 16);
    const p = program(gl, VS_POS, FS_SOLID);
    fullTri(gl, p);
    gl.enable(GL.BLEND);
    gl.blendFunc(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 1, 1);
    gl.clear(GL.COLOR_BUFFER_BIT);
    gl.uniform4f(gl.getUniformLocation(p, "uColor"), 1, 0, 0, 0.5);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const [r, g, b, a] = pixel(gl, 8, 2);
    assert.ok(Math.abs((r ?? 0) - 128) <= 4, `r=${r}`);
    assert.equal(g, 0);
    assert.ok(Math.abs((b ?? 0) - 128) <= 4, `b=${b}`);
    // a = srcA*SRC_ALPHA + dstA*ONE_MINUS_SRC_ALPHA = .25 + .5 = .75 → 191
    assert.ok(Math.abs((a ?? 0) - 191) <= 4, `a=${a}`);
  });
void test("samples a texture via texture2D + sampler2D", () => {
    const gl = new WebGLCore(16, 16);
    const vs = "attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos,0,1); }";
    const fs = "precision mediump float; varying vec2 vUv; uniform sampler2D tex; void main(){ gl_FragColor = texture2D(tex, vUv); }";
    const p = program(gl, vs, fs);
    fullTri(gl, p);
    // 2x2 texture: TL red, TR green, BL blue, BR white
    const tex = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_2D, tex);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
      new Uint8Array([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255,
      ]));
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(p, "tex"), 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    // GL textures are bottom-up: data row 0 (red|green) is v≈0, row 1 (blue|white) v≈1.
    const bottom = pixel(gl, 8, 1); // v≈0, u≈0.5 → row 0 → red/green (b≈0)
    assert.ok((bottom[0] ?? 0) + (bottom[1] ?? 0) > 150 && (bottom[2] ?? 0) < 60);
    const top = pixel(gl, 8, 14); // v≈0.9 → row 1 → blue/white (b high)
    assert.ok((top[2] ?? 0) > 200);
  });
void test("drawElements indexes ELEMENT_ARRAY_BUFFER", () => {
    const gl = new WebGLCore(16, 16);
    const p = program(gl, VS_POS, FS_SOLID);
    gl.useProgram(p);
    const vb = gl.createBuffer();
    gl.bindBuffer(GL.ARRAY_BUFFER, vb);
    // quad corners
    gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, 1,
    ]), GL.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(GL.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), GL.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, "aPos");
    gl.vertexAttribPointer(loc, 2, GL.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(loc);
    gl.uniform4f(gl.getUniformLocation(p, "uColor"), 0, 1, 0, 1);
    gl.drawElements(GL.TRIANGLES, 6, GL.UNSIGNED_SHORT, 0);
    assert.equal(gl.getError(), GL.NO_ERROR);
    assert.deepEqual(pixel(gl, 8, 8), [0, 255, 0, 255]); // center covered
  });
void test("snapshot() hands the framebuffer out as a DecodedImage", () => {
    const gl = new WebGLCore(8, 8);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(GL.COLOR_BUFFER_BIT);
    const img = gl.snapshot();
    assert.equal(img.width, 8);
    assert.equal(img.pixels[0], 255);
    assert.equal(img.pixels[3], 255);
  });
void test("records INVALID_ENUM/INVALID_OPERATION in getError", () => {
    const gl = new WebGLCore(8, 8);
    gl.bindBuffer(0xdead, null);
    assert.equal(gl.getError(), GL.INVALID_ENUM);
    gl.drawArrays(GL.TRIANGLES, 0, 3); // no program
    assert.equal(gl.getError(), GL.INVALID_OPERATION);
    assert.equal(gl.getError(), GL.NO_ERROR);
  });
