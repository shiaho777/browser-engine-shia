export const HOME_URL = "engine://home";

export const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>browser-engine-shia</title>
<style>
  body {
    margin: 0;
    background-color: #0f172a;
    color: #e2e8f0;
    font-family: sans-serif;
  }
  main {
    width: 640px;
    margin: 48px auto;
    padding: 28px 32px;
    background-color: #1e293b;
    border: 1px solid #475569;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 32px;
    color: #f8fafc;
  }
  p {
    margin: 10px 0;
    font-size: 15px;
    color: #cbd5e1;
  }
  a.demo {
    display: block;
    width: 280px;
    margin: 10px 0;
    padding: 14px 16px;
    background-color: #38bdf8;
    color: #0f172a;
    text-decoration: none;
    font-weight: 700;
  }
  a.alt { background-color: #a78bfa; }
  a.green { background-color: #34d399; }
  a.amber { background-color: #fbbf24; }
  #boot-badge {
    margin-top: 12px;
    padding: 6px 10px;
    background-color: #14532d;
    color: #bbf7d0;
    font-size: 12px;
    font-weight: 700;
  }
  .hint {
    margin-top: 18px;
    font-size: 13px;
    color: #94a3b8;
  }
</style>
</head>
<body>
  <main>
    <h1>browser-engine-shia</h1>
    <p>Engine shell: layout, paint, hit-test. Page scripts run on FineSession before paint.</p>
    <p>中文渲染测试：你好，浏览器内核。</p>
    <div id="boot-badge">scripts idle</div>
    <p>
      <a class="demo" href="https://example.com">Open example.com</a>
      <a class="demo alt" href="engine://demo">Open engine demo page</a>
      <a class="demo amber" href="engine://live">Open live JS demo</a>
      <a class="demo green" href="engine://home">Reload home</a>
      <a class="demo amber" href="engine://fonts">Open font / 中文测试</a>
      <a class="demo green" href="engine://form">Open form / 输入测试</a>
    </p>
    <p class="hint">Click links for hit-testing. Prefer engine:// pages and example.com. Fonts: system TTF + builtin fallback.</p>
  </main>
  <script>
    var badge = document.getElementById("boot-badge");
    if (badge) {
      badge.setAttribute("style", "background-color:#1d4ed8;color:#dbeafe");
      badge.textContent = "engine JS booted";
    }
  </script>
</body>
</html>
`;

export const DEMO_URL = "engine://demo";

export const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Engine Demo</title>
<style>
  body {
    margin: 24px;
    background-color: #f8fafc;
    color: #0f172a;
    font-family: sans-serif;
  }
  h1 {
    color: #1d4ed8;
    font-size: 28px;
    margin: 0 0 12px;
  }
  p {
    font-size: 16px;
    margin: 0 0 12px;
  }
  a {
    display: inline-block;
    margin-top: 12px;
    padding: 12px 16px;
    background-color: #2563eb;
    color: #ffffff;
    text-decoration: none;
  }
  .box {
    width: 160px;
    height: 70px;
    margin-top: 18px;
    background-color: #f59e0b;
  }
</style>
</head>
<body>
  <h1 id="title">Demo page</h1>
  <p id="msg">This page was laid out and painted by browser-engine-shia.</p>
  <p id="zh">中文：布局与绘制由本内核完成。</p>
  <a href="engine://home">Back to home</a>
  <div class="box" id="box"></div>
  <script>
    var title = document.getElementById("title");
    if (title) title.textContent = "Demo page (JS ok)";
    var msg = document.getElementById("msg");
    if (msg) msg.textContent = "FineSession ran page scripts, then re-painted.";
    var zh = document.getElementById("zh");
    if (zh) zh.textContent = "中文：脚本已运行，页面已重绘。";
    var box = document.getElementById("box");
    if (box) box.setAttribute("style", "background-color:#10b981");
  </script>
</body>
</html>
`;

export const LIVE_URL = "engine://live";

export const LIVE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Live JS Engine</title>
<style>
  body {
    margin: 0;
    background-color: #0b1220;
    color: #e2e8f0;
    font-family: sans-serif;
  }
  main {
    width: 720px;
    margin: 0 auto;
    padding: 40px 24px;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 30px;
    color: #f8fafc;
  }
  p {
    color: #cbd5e1;
  }
  .panel {
    margin-top: 20px;
    padding: 18px;
    background-color: #111827;
    border: 1px solid #334155;
  }
  #counter {
    font-size: 42px;
    font-weight: 800;
    color: #38bdf8;
  }
  #status {
    margin-top: 10px;
    color: #86efac;
    font-weight: 600;
  }
  a {
    display: inline-block;
    margin-top: 18px;
    margin-right: 10px;
    padding: 12px 16px;
    background-color: #2563eb;
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
  }
  a.purple { background-color: #7c3aed; }
  .chip {
    display: inline-block;
    margin-right: 8px;
    margin-top: 8px;
    padding: 6px 10px;
    background-color: #1e293b;
    color: #93c5fd;
    font-size: 13px;
  }
</style>
</head>
<body>
  <main>
    <h1>Live JS on FineSession</h1>
    <p>This page runs classic scripts with timers before the engine paints the frame.</p>
    <div class="panel">
      <div id="counter">0</div>
      <div id="status">waiting...</div>
      <div>
        <span class="chip" id="chip-a">timer pending</span>
        <span class="chip" id="chip-b">mutation pending</span>
      </div>
    </div>
    <a href="engine://home">Back home</a>
    <a class="purple" href="engine://demo">Demo page</a>
  </main>
  <script>
    var counter = document.getElementById("counter");
    var status = document.getElementById("status");
    var chipA = document.getElementById("chip-a");
    var chipB = document.getElementById("chip-b");
    var n = 0;
    function tick() {
      n = n + 1;
      if (counter) counter.textContent = String(n);
      if (n < 3) {
        setTimeout(tick, 0);
      } else {
        if (status) status.textContent = "event loop drained · counter=" + n;
        if (chipA) chipA.textContent = "timers fired";
        if (chipB) {
          chipB.textContent = "dom mutated";
          chipB.setAttribute("style", "background-color:#14532d;color:#bbf7d0");
        }
      }
    }
    setTimeout(tick, 0);
  </script>
</body>
</html>
`;

export const FONTS_URL = "engine://fonts";

export const FONTS_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Font Lab</title>
<style>
  body {
    margin: 0;
    background-color: #0f172a;
    color: #e2e8f0;
    font-family: sans-serif;
  }
  main {
    width: 720px;
    margin: 0 auto;
    padding: 36px 24px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 34px;
    color: #f8fafc;
  }
  h2 {
    margin: 22px 0 8px;
    font-size: 22px;
    color: #93c5fd;
  }
  p {
    margin: 8px 0;
    font-size: 16px;
    color: #cbd5e1;
  }
  .big {
    font-size: 28px;
    color: #fbbf24;
  }
  .mixed {
    font-size: 20px;
    color: #86efac;
  }
  .box {
    margin-top: 16px;
    padding: 14px 16px;
    background-color: #1e293b;
    border: 1px solid #475569;
  }
  a {
    display: inline-block;
    margin-top: 20px;
    margin-right: 10px;
    padding: 12px 16px;
    background-color: #2563eb;
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
  }
  a.alt { background-color: #7c3aed; }
</style>
</head>
<body>
  <main>
    <h1>Font Lab / 字体实验室</h1>
    <p>Font stack: <strong id="stack">{{FONT_STACK}}</strong></p>
    <p>Primary system TrueType (CJK when available) plus builtin glyph fallback.</p>
    <div class="box">
      <h2>Latin</h2>
      <p class="big">ABCDEFG abcdefg 0123456789</p>
      <p>The quick brown fox jumps over the lazy dog.</p>
    </div>
    <div class="box">
      <h2>中文</h2>
      <p class="big">你好，浏览器内核。</p>
      <p class="mixed">Mixed 混合: Hello 世界 — 布局 Layout + 绘制 Paint</p>
      <p>常用字：天地玄黄 宇宙洪荒 日月盈昃 辰宿列张</p>
      <p id="dyn">脚本待运行</p>
    </div>
    <a href="engine://home">Back home</a>
    <a class="alt" href="engine://demo">Demo</a>
  </main>
  <script>
    var dyn = document.getElementById("dyn");
    if (dyn) dyn.textContent = "脚本已运行：中文 + Latin 重绘完成。";
  </script>
</body>
</html>
`;

export const ERROR_URL = "engine://error";

export function errorPageHtml(target: string, message: string): string {
  const safeTarget = escapeHtml(target);
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Load error</title>
<style>
  body {
    margin: 0;
    background-color: #0f172a;
    color: #e2e8f0;
    font-family: sans-serif;
  }
  main {
    width: 640px;
    margin: 48px auto;
    padding: 28px 32px;
    background-color: #1e293b;
    border: 1px solid #7f1d1d;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 28px;
    color: #fecaca;
  }
  p {
    margin: 10px 0;
    font-size: 15px;
    color: #cbd5e1;
  }
  code {
    color: #fde68a;
  }
  a {
    display: inline-block;
    margin-top: 16px;
    margin-right: 10px;
    padding: 12px 16px;
    background-color: #2563eb;
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
  }
  a.alt { background-color: #7c3aed; }
</style>
</head>
<body>
  <main>
    <h1>Load failed</h1>
    <p>Target: <code>${safeTarget}</code></p>
    <p>${safeMessage}</p>
    <p>Complex SPA sites (scripts, XHR, modules) are out of scope for this kernel demo. Prefer engine:// pages or simple static HTML.</p>
    <a href="engine://home">Home</a>
    <a class="alt" href="engine://fonts">Font lab</a>
  </main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const FORM_URL = "engine://form";

export const FORM_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Form Lab</title>
<style>
  body {
    margin: 0;
    background-color: #0b1220;
    color: #e2e8f0;
    font-family: sans-serif;
  }
  main {
    width: 720px;
    margin: 0 auto;
    padding: 36px 24px;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 30px;
    color: #f8fafc;
  }
  p {
    margin: 8px 0 14px;
    color: #94a3b8;
    font-size: 15px;
  }
  label {
    display: block;
    margin: 14px 0 6px;
    color: #93c5fd;
    font-size: 14px;
  }
  input, textarea, .box {
    display: block;
    width: 420px;
    padding: 10px 12px;
    background-color: #1e293b;
    color: #f8fafc;
    border: 2px solid #38bdf8;
    font-size: 16px;
  }
  textarea, .box {
    height: 90px;
  }
  .box {
    margin-top: 0;
  }
  #mirror {
    margin-top: 18px;
    padding: 12px 14px;
    background-color: #14532d;
    color: #bbf7d0;
    font-size: 15px;
  }
  a {
    display: inline-block;
    margin-top: 22px;
    margin-right: 10px;
    padding: 12px 16px;
    background-color: #2563eb;
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
  }
</style>
</head>
<body>
  <main>
    <h1>Form Lab / 输入测试</h1>
    <p>Click a field, type in the shell overlay, press Enter or blur to commit into the engine DOM and repaint.</p>
    <label>Name input</label>
    <input id="name" value="browser-engine-shia">
    <label>Notes textarea</label>
    <textarea id="notes">中文也可以输入。Click and type.</textarea>
    <label>Editable box</label>
    <div id="box" class="box" data-editable="multiline">edit me</div>
    <div id="mirror">mirror idle</div>
    <a href="engine://home">Back home</a>
    <a href="engine://fonts">Fonts</a>
  </main>
  <script>
    var mirror = document.getElementById("mirror");
    if (mirror) mirror.textContent = "form scripts booted";
  </script>
</body>
</html>
`;
