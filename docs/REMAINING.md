# 剩余工作

状态只有四种：`未完成`、`已完成`、`先不做`、`不做`。

永久 `不做`：自研 JavaScript 引擎（继续嵌 V8）、系统弹窗、跨源 DOM 放进同一个进程。

当前 `先不做`：SVG 绘制树、容器查询、WebGL2、操作系统无障碍 IPC、自研 JavaScript 引擎。

官方 WPT 还没接上。仓库里的 462 条是自带夹具，不是 WPT 通过率。

## 模块

| 包 | 状态 | 管什么 | 还剩的任务 |
|---|---|---|---|
| `html-parser` | 未完成 | HTML 进 DOM | 声明式 Shadow DOM、`<picture>` / `<source>`、`<track>` |
| `css-parser` | 未完成 | CSS 语法 | 容器查询、`::slotted` / `::part` / `::before` / `::after` 的选择器语义、`conic-gradient`、`image-set()` |
| `cascade` | 未完成 | 计算样式 | 伪元素生成内容、`is=` / `extends` 匹配、`:host-context`；容器查询先不做 |
| `layout` | 未完成 | 唯一几何来源 | 行内多子节点拆行、flex / grid / table 的内在尺寸缺口、ruby 配对、直排字形、滚动驱动动画 |
| `paint` | 未完成 | DisplayList | 渐变位置与尺寸、`border-image`、混合模式、`::before` / `::after` 绘制 |
| `ir` | 未完成 | DOM / 片段 / 绘制命令 | 多行行内盒子、径向渐变的位置字段、损伤区域从单矩形变成区域集 |
| `font` | 未完成 | 字体与 HarfBuzz | WOFF2、CFF、`unicode-range`、`vert` / `vrt2`、可变字体、彩色表情 |
| `backend` | 未完成 | 软件光栅 / Skia / GPU 条带 | 图层保留表面；合成斜体以外的合成仍薄 |
| `gpu` | 未完成 | 软件 GL、WebGPU 机会设备 | WebGL1 的十二条边界；WebGL2 先不做 |
| `guest` | 未完成 | fetch、CORS、cookie、缓存、WebSocket | 请求策略、不透明响应、上传进度、预检重定向、PNA |
| `cli` | 未完成 | 页面管线、脚本 realm、Worker、画布、媒体 | DOM、Web API、安全隔离、平台能力里的大部分缺口 |
| `app` | 未完成 | 壳、标签进程、站点隔离 | 联合历史、崩溃重启、观察者在应用运行时的占位几何 |
| `ipc` | 未完成 | 生成的线协议 | 结构化克隆与可转移对象还没进线协议 |
| `kernel` | 未完成 | 调度与失效 | 样式仍按帧全量算；损伤只收窄边界子树 |
| `generator` | 未完成 | CSS 属性表 | 新属性要先加表再进解析和级联 |
| `benchmark` | 未完成 | 增量布局与绘制证据 | 还没证明热路径比冷路径快 |
| `scoreboard` | 未完成 | 证据门 | 官方 WPT 百分比和对照 Chromium 的截图还没做 |
| `test-harness` | 未完成 | 证据门 | 官方 WPT 百分比和对照 Chromium 的截图还没做 |

## 1. 排版与绘制

这些任务主要落在 `cascade`、`layout`、`paint`、`ir`、`backend`、`font`。

### 行内格式

1. `未完成` 一个 `display: inline` 有多个子节点时，仍是一整块原子盒，不会按父级行折行。要拆成每行一段，同时每个节点仍只有一个片段。
2. `未完成` `radial-gradient` 只认中心的 `circle` / `ellipse` 和色标。`at`、半径、`closest-side`、`farthest-side` 都还没建模。
3. `未完成` 线性渐变的斜角方向（`to bottom right`）会直接丢掉，不画。色标提示（color hint）也没有。
4. `未完成` `conic-gradient`、`image-set()`、`background-blend-mode`、`border-image` 不画。
5. `未完成` `::before` / `::after` 能写进样式表，但不会匹配，也不会生成盒子。
6. `未完成` 滚动驱动动画（`animation-timeline`、`view-timeline`）没有模型。`will-change` 只提升 `transform`、`opacity`、`filter`。

### Flex

7. `未完成` `auto` 列宽仍按 `1fr` 近似，没有真正的 `min-content` / `max-content` 遍。
8. `未完成` 列方向的 `flex-wrap` 只在高度确定时换列。高度不定就保持一列。

### Grid

9. `未完成` `repeat()` 里的命名线被跳过，不会按重复次数展开。
10. `未完成` 不接受负数或 0 的线号。
11. `未完成` 隐式行的 `grid-auto-rows: fr` 只在容器高度确定时才分配。
12. `未完成` `dense` 加上跨轨道，在剩余列不够时的补洞还不完整。

### Table

13. `未完成` `col` / `colgroup` 只提供列宽，不生成列组盒子。
14. `未完成` `tfoot` 停在 DOM 顺序里，不会排到表体后面。
15. `未完成` 跨行单元格不参加行的基线对齐。没有行盒的单元格，基线落在内容底边。
16. `未完成` 合并边框的胜者画在自己的格子上，不是画在共享边上。

### 图片

17. `未完成` `<picture>` / `<source>` 不参与选源。
18. `未完成` `sizes` 里的 `calc()` 会让那条候选被跳过。
19. `未完成` 动图只留第一帧。
20. `先不做` SVG 仍是替换元素占位，没有 SVG 绘制树。

## 2. DOM 与 Web API

主要落在 `cli`、`guest`、`cascade`、`html-parser`、`app`。

### 观察者

21. `未完成` `MutationObserver` 在已脱离文档的子树上做临时注册，还没有模型。
22. `未完成` `IntersectionObserver` 没有滚动管线。投递是求值过程里同步发生的，不是求值后的下一个微任务。
23. `未完成` 应用运行时还有一条占位几何路径，不读真实片段树。
24. `未完成` `ResizeObserver` 同样缺滚动后的再测量。

### 自定义元素

25. `未完成` 没有 `adoptNode`，所以没有 `adoptedCallback`。
26. `未完成` 反应队列的检查点时机还不是规范顺序。
27. `未完成` `is=` / `extends` 只按名字匹配，不进级联。
28. `未完成` 自定义元素名只检查 ASCII 子集。

### Shadow DOM

29. `未完成` 没有声明式 Shadow DOM（`<template shadowrootmode>`）。
30. `未完成` `assignedNodes({ flatten: true })` 不沿槽链展开。
31. `未完成` `::slotted`、`::part`、`:host-context` 不匹配。
32. `未完成` 不能跨根 `adoptNode`。
33. `未完成` Shadow 里的 `style.sheet` 没有接上。

### fetch 与 XHR

34. `未完成` `Request` 的 `redirect`、`cache`、`integrity`、`mode` 还没有策略执行。
35. `未完成` 没有 `multipart/form-data`。
36. `未完成` XHR 的 `responseXML` 保持 `null`。
37. `未完成` `no-cors` 不会产出真正的 `opaque` 响应类型。
38. `未完成` 上传进度没有字节计数。
39. `未完成` 流式 body 已有拉取队列，但没有 `pipeTo` / `pipeThrough`，也没有 BYOB reader。

### 输入

40. `未完成` 没有 IME 组合事件（`compositionstart` / `update` / `end`）。
41. `未完成` `getCoalescedEvents()` 永远只有一条。没有预测事件。
42. `未完成` `:focus-visible` 是固定启发式，不看用户是否用过键盘。
43. `未完成` `uiTab` 不从顺序焦点的当前位置接着走。
44. `未完成` `hasFocus()` 恒为真，没有多文档焦点。
45. `未完成` 元素的 `click()` 不补 pointer / mouse 前驱事件。

### 表单

46. `未完成` `datalist` 只有数据，没有建议列表界面。
47. `未完成` `select` 的单选在任意变更后的重置只覆盖了一部分。
48. `未完成` `valueAsDate` 恒为 `null`。
49. `未完成` 没有 `appearance`，控件是盒子级替换元素，没有下拉框外观。
50. `未完成` `reportValidity()` 只返回真假，没有可见提示。

### WebSocket

51. `未完成` 不协商扩展。
52. `未完成` 没有 HTTP 代理的 `CONNECT`。
53. `未完成` 升级请求不带 cookie jar。
54. `未完成` 没有半开连接检测。
55. `未完成` `wss:` 用系统默认证书校验，没有证书策略和客户端证书。

## 3. 文字与国际化

主要落在 `layout`、`font`、`cascade`。

### 双向文字

56. `未完成` `Bidi_Class` 是手写范围表，不是生成的 Unicode 字符数据库。
57. `未完成` 括号配对只有 `()[]{}`。
58. `未完成` 没有 L1：换行后的嵌入级别不会按行重置。
59. `未完成` 原子行内盒子两侧的中性字符是近似的。
60. `未完成` `textarea[dir=auto]` 没有明文段落语义。

### 断行

61. `未完成` 泰文、老挝文、高棉文、缅甸文没有词典迭代器。
62. `未完成` `line-break: strict` 近似成 `normal`。
63. `未完成` 区域指示符（旗帜 emoji）总是成对。
64. `未完成` `hyphens: auto` 等于 `manual`，没有语言词典。
65. `未完成` 没有 `text-wrap: pretty` / `balance`。
66. `未完成` emoji ZWJ 序列被当成 `BN` 剥掉。
67. `未完成` 跨行内成员的软连字符不会接上。

### 直排

68. `未完成` 字形度量不旋转。没有 `vert` / `vrt2`。
69. `未完成` 正交子元素的尺寸是收缩适应的近似。
70. `未完成` 替换元素在直排里被转置，而不是保持直立。
71. `未完成` `sticky` 只跟踪 `scrollY`，不跟踪横向滚动。

### Ruby

72. `未完成` `rb` 和 `rt` 没有按段配对。
73. `未完成` `ruby-align: space-between` 近似成居中。
74. `未完成` 没有相邻注音的外伸。
75. `未完成` 嵌套 ruby 被压平。
76. `未完成` `inter-character` 近似成 `over`。

### 字体

77. `未完成` WOFF2 不解包，`format("woff2")` 被跳过。
78. `未完成` CFF 的 `.otf` 不能走 `registerFile`。
79. `未完成` 没有 `unicode-range`。
80. `未完成` 没有字体换入后的重新排版（FOUT）。解析发生在第一次布局之前。
81. `未完成` 没有合成小型大写字母。斜体合成只覆盖 `font-style` 的剪切，不覆盖 `font-synthesis` 里的小型大写。
82. `未完成` 没有 COLR 彩色表情，没有可变字体轴。
83. `未完成` 没有塑形缓存。

## 4. 安全与隔离

主要落在 `guest`、`cli`、`app`。

### CSP

84. `未完成` `strict-dynamic` 能解析，但不会放宽主机列表。
85. `未完成` 没有 `report-to`。`report-uri` 已有。
86. `未完成` `sandbox`、`form-action`、`navigate-to` 不执行。
87. `未完成` `javascript:` URL 没有门。
88. `未完成` 没有 SRI（子资源完整性）。

### CORS

89. `未完成` 虚拟传输默认放行，不看服务器头。
90. `未完成` 预检被重定向后不再复查。
91. `未完成` 没有私有网络访问（PNA）。
92. `未完成` 画布不跟踪跨源污染。
93. `未完成` 没有 `Timing-Allow-Origin`，也没有 `opaqueredirect` 过滤类型。

### 混合内容与 HSTS

94. `未完成` 没有 HSTS 预加载列表。
95. `未完成` 没有证书错误门。
96. `未完成` HSTS 状态没有跨重启的内置持久化。
97. `未完成` 裸的 `nodeFetchNetworkStack` 不走 HSTS。

### 站点隔离

98. `未完成` 远程帧不在联合会话历史里。父页面后退不会倒回它们。
99. `未完成` 同源再导航不会把进程迁回去。
100. `未完成` `window.open` 指向父级时是空操作。
101. `未完成` `postMessage` 只做 JSON 克隆，没有可转移对象，也没有 `MessagePort`。
102. `未完成` 渲染进程崩溃后不会重启。

### COEP / COOP

103. `未完成` `same-site` 是域名最后两段，没有公共后缀列表。
104. `未完成` 只报告、不执行的变体不解析。
105. `未完成` HTTP 缓存不按凭据分区。
106. `未完成` `credentialless` 子文档的 COEP 放宽没有模型。

## 5. 平台能力

主要落在 `cli`。画布和 GL 还涉及 `gpu`、`backend`。

### Dedicated Worker

107. `未完成` `type: "module"` 抛出 `TypeError`。Worker 里没有 ESM 图。
108. `未完成` Worker 里的 `fetch` / `importScripts` 绕过页面的 cookie、CSP、COEP。
109. `未完成` 没有可转移对象。
110. `未完成` Worker 不能再开 Worker。
111. `未完成` 消息事件是 `{ type, data }`，不是 `MessageEvent`。

### Service Worker

112. `未完成` 控制模型是注册后立即 claim，没有等待中的现任 Worker。
113. `未完成` 没有更新生命周期。
114. `未完成` `caches` 按 realm 放在内存里，不落盘，也不跨 Worker 共享。
115. `未完成` 没有 Push、Background Sync。
116. `未完成` 作用域是最长前缀，不是规范的路径匹配。

### SharedWorker

117. `未完成` 文档没有 `MessageChannel`。
118. `未完成` 没有可转移对象，也不能嵌套再开 SharedWorker。

### Canvas 2D

119. `未完成` 编码只有 PNG。
120. `未完成` 没有 `ImageBitmap`，也没有 `transferToImageBitmap`。
121. `未完成` `drawImage` 不能用来源是 `<video>` 或 SVG。
122. `未完成` 跨源绘制不把画布标成污染。
123. `未完成` CanvasKit 冷启动失败时退化成 `undefined` 或 1×1。
124. `未完成` 一部分文字和滤镜字段只存储，不画。

### 音视频

125. `未完成` 整文件缓冲。没有 Range，`buffered` 报的是 `[0, duration]`。
126. `未完成` PCM 能解出来，但没有声音输出。时间轴在静音下走。
127. `未完成` 帧在每次绘制时解码，没有自己的重绘循环。
128. `未完成` 没有 `<track>`、EME、MSE、`captureStream`。
129. `未完成` 没有 ffmpeg 时只能播 WAV。

### WebGL1

130. `未完成` 只有软件光栅。没有独立 GPU 路径。
131. `未完成` 扩展列表为空。没有 mipmap、模板缓冲、renderbuffer。
132. `未完成` `texSubImage2D`、`copyTex*`、压缩纹理不改纹理数据。
133. `未完成` 没有 `dFdx` / `dFdy` / `fwidth`，没有抗锯齿。
134. `未完成` 线宽和点大小固定为 1。
135. `未完成` GLSL 没有宏、结构体、`samplerCube`。
136. `先不做` WebGL2。

### 无障碍树

137. `未完成` 可访问名称不走 `aria-describedby`，伪元素不贡献名字。
138. `未完成` 静态文本节点没有自己的几何，只用父元素的盒子。
139. `未完成` `textarea` / `select` 的实时值不进树。
140. `未完成` 没有实时区域播报，没有 `aria-owns` / `activedescendant` / `flowto`，没有表头关联，没有 `AXAction`。
141. `未完成` 没有按点命中。Shadow 的槽投影顺序不单独建模。
142. `先不做` 操作系统无障碍 IPC（AT-SPI、NSAccessibility、UIA）。

## 6. 性能

主要落在 `layout`、`kernel`、`backend`、`guest`、`benchmark`。

143. `未完成` 普通块不是重放边界。靠近文档顶部的修改仍会重走大部分树。
144. `未完成` 重放会重新分配片段对象。浅子树的热路径和冷路径差不多，基准还没记录到稳定的墙钟优势。
145. `未完成` 样式每次渲染仍全量算。损伤只决定片段能不能复用。
146. `未完成` 绘制损伤是一个并集矩形。两处相距很远的改动会重画中间的大片。
147. `未完成` 带 `transform` 或 `filter` 的层强制整帧重画。没有按层保留的离屏表面。
148. `未完成` 显示列表差异是前缀加后缀，不是最长公共子序列。同等内容换序会伤到中间整段。
149. `未完成` 流式网络没有 HTTP/2 推送，也没有 HTTP/3。

## 7. 验收门

150. `已完成` 官方 WPT：`css-flexbox` 与 `css-grid` 子集至少 60%，定位和媒体查询至少 80%。
151. `未完成` `dom/observers`、自定义元素、Shadow DOM 子集导入并跑通。
152. `未完成` 表单夹具至少 70%。
153. `未完成` `css-text`、书写模式、国际化夹具至少 60%。
154. `未完成` CSP 与 CORS 子集，加上跨源 iframe 不能摸到对方 DOM 的夹具。
155. `未完成` Worker 与 canvas 子集，以及 Service Worker 的 `install` / `fetch` / 离线路径。
156. `未完成` 增量布局在变更密集的夹具上，基准面板要看到收益。
157. `未完成` 对照 Chromium 的页面截图。

## 先不做

158. `先不做` SVG 绘制树。
159. `先不做` `@container`。
160. `先不做` WebGL2。
161. `先不做` AT-SPI / NSAccessibility / UIA。
162. `不做` 自研 JavaScript 引擎。
163. `不做` 系统弹窗。
164. `不做` 跨源 DOM 放进同一个进程。
