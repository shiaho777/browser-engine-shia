# Ladybird 对照移植路线图(层③算法重写 + 层④边界)

> 来源:对 `ladybird-master`(2026-09 快照,BSD-2-Clause,署名见 NOTICE.md)的三路深度对比分析。
> 层①(数据)与层②(测试语料)的移植已完成:Properties.json → 107 行导入
> (`packages/generator/src/generated/ladybird-properties.data.ts`)、IDL →
> `generated/ladybird-idl.data.ts`、WPT 语料 → `wpt-imported/`。
> 本文档规划剩余两层。核心原则:**照着重写,不逐行翻译**——Ladybird 的代码是
> 规范的无歧义解读 + 边界情况穷举,但我们的产物必须保持查询式增量内核与冻结 IR。

## 全量 WPT 基线(2026-09-07 首测,`npm run wpt:imported` 可复测)

导入语料 3,918 个测试文件、**76,641 个子测试**:

| 结果 | 数量 | 占比 | 含义 |
|------|------|------|------|
| 通过 | 10,127 | 13.2% | 当前真实兼容面 |
| 失败 | 19,378 | 25.3% | 行为不对(有 API 但结果错) |
| 错误 | 47,136 | 61.5% | **API 缺失(测试根本跑不起来)** |

**关键结论:错误 ≫ 失败——我们的第一缺口是 API 面缺失,不是行为错误。**

亮点区域:ecmascript/uievents 100%、wasm 66.6%、fullscreen 58.2%、**dom 39.9%**、
css 8,167 通过(单项最多,占 14%)。

**0% 区域即最高 ROI 空白**(完整规范、全部 error 于缺 API):

| 区域 | 子测试 | 为什么 ROI 最高 |
|------|-------|----------------|
| **url** | 866 | URL 解析是 fetch/导航/资源加载的前置,纯规范算法,无布局依赖;Ladybird `LibURL` 可直接对照 |
| webstorage | 94 | localStorage/sessionStorage,小面高频 |
| wai-aria | 253 | ARIA 反射属性,IDL 数据已就位 |
| webmessaging | 42 | postMessage/结构化克隆 |
| web-locks | 140 | 小 API |

> 原 ROI 排序(D 组运行时语义、A 组级联)不变,但 **url 区域应插入最前**——
> 866 个子测试、纯算法、同时解锁 fetch/html 两个大区域的 error 转化。

## 移植的经济学(为什么是这个顺序)

每一项按「真实站点影响面 × 缺失程度 ÷ 实现成本」排序。每一行都注明:
**我们写什么** → **参考 Ladybird 哪个文件**。

---

## 层③-A:级联与值(小改动、大收益)

| # | 机制 | 我们的落点 | Ladybird 参考 | 规模估计 |
|---|------|-----------|---------------|---------|
| A1 | ~~**@layer 参与级联排序**~~ ✅ **已实现** | `cascade/src/index.ts` layerPrecedence + `css-parser/src/index.ts` layerOrder 提取,4 个单元测试全绿 | `Rust/src/css/style/cascade.rs` | ~300 行 |
| A2 | ~~**媒体查询 range 语法 + 完整求值**~~ ✅ **已完成** | `css-parser/src/media-query.ts`(186→430 行:tokenizer/parser/evaluator 三层)range 4 种形式、or/not、hover/pointer/prefers-*/display-mode/update | `Rust/src/css/parser/query_parser.rs`(3,242 行) | 43 测试全绿 |
| A3 | **@supports 条件求值**(用真实值解析器试解析回答) | `css-parser` + `cascade` | 同上 + `syntax_parser.rs` | ~400 行 |
| A4 | **calc() 完整表达式树**(min/max/clamp、混合单位、嵌套;我们已有 SpecifiedCalc 雏形) | `generator/src/value-runtime.ts` calc 段 + `cascade` resolveCalc | `Rust/src/css/calc.rs`(4,847 行)+ `calc_parser.rs`(793 行) | ~1,500 行 |
| A5 | ~~**类型化 shorthand 展开 + 补齐高频 shorthand**~~ ✅ **已完成** | `generator/src/shorthand-expansion.ts`(15→27 个 expander:+inset/inset-block/inset-inline/overflow/overflow-block/overflow-inline/place-items/place-content/place-self/text-decoration/font;font 的 line-height 生效于布局几何) | `parser/value_parser.rs` positional 展开 | 27 测试全绿 + e2e 验证 |
| A6 | **legacy/logical alias 机制消费已导入数据**(116 条别名已在 `LADYBIRD_ALIASES`) | `cascade` 声明预处理一步 | `Properties.json` 语义本身 + 我们的别名数据 | ~200 行 |
| A7 | **currentcolor / 系统色**(颜色解析;导入行里 9 个 color 属性仍是不透明字符串) | `generator/src/value-runtime.ts` parseColor + `cascade` 解析上下文 | `Rust/src/css/color.rs` + `style_compute.rs` | ~300 行 |

**A 组合计 ~5,500 行手写,解锁:Tailwind/现代 reset(@layer)、现代 MQ 写法、
渐进增强(@supports)、calc 高频场景、top-20 shorthand。**

## 层③-B:布局正确性地基(真实站点渲染对错的分水岭)

| # | 机制 | 我们的落点 | Ladybird 参考 | 规模估计 |
|---|------|-----------|---------------|---------|
| B1 | ~~**Tree builder 阶段**~~ ✅ **Phase 1 完成** | `layout/src/tree-builder.ts`(~330行:block fixup + table fixup)+ `display-classification.ts`(共享分类)+ UA 样式表 table display 翻转 + `layoutTable` 重构(匿名行/cell 透明) | `layout/tree_builder.rs`(4,297 行;插入父选择 L2778/2819、table 修正 L3376) | 10 测试全绿;修掉**表格裸文本丢弃** bug |
| B2 | ~~**包含块规则 + abspos 完整解算**~~ ✅ **已完成** | 静态位置按文档位捕获(AbsPending 带 staticLeft/Top)+ shrink-to-fit(maxContentMarginBoxWidth 估算器:min/max/行内求和/replaced intrinsic/声明宽优先)+ block 路径去重 | `layout/abspos_engine.rs`(2,154 行) | 8 测试 |
| B3 | ~~**float band + 对 inline 的双向入侵**~~ ✅ **已完成** | float band 放置(侧贴/下移到最短阻挡底边;CSS 2.1 §9.5.1)+ inline run 按侵入收窄/平移 | `block_formatting_context.rs` L179-254(band) | 5 测试 |
| B4 | ~~**baseline / vertical-align 全矩阵**~~ ✅ **已完成** | 基线行装配(两遍:成员基线 extents + strut 参与行高;行内 run 高度传导容器)+ vertical-align 全家族(baseline/top/bottom/text-top/text-bottom/middle/sub/super/长度/百分比)+ 顺手修复**百分比字号不解析的既有 bug**(font-size: 100% 曾毒化整行 NaN——bilibili 搜索页实证) | `line_builder.rs` L621-940 | 9+3 测试 |
| B5 | **min-content / max-content 作为各 FC 的 IntrinsicSizing 模式**(不是独立模块) | `layout` 各 FC + `sizing_context` 共享层 | `layout/sizing_context.rs`(2,627 行)+ `intrinsic_sizing.rs`(153 行入口) | ~1,200 行 |
| B6 | ~~**table 自动布局**~~ ✅ **已完成** | `autoColumnWidths`:列按最宽 cell 的 max-content 度量;盈余均摊、亏损按比例收缩(地板 = 25% preferred 封顶等份额) | `table_formatting_context.rs`(2,803 行) | 6 测试 |
| B7 | ~~**grid track sizing**~~ ✅ **已完成**(简化版) | track 解析扩展 minmax/auto/%(函数 token 平衡分词)+ 两遍放置(先放后量)+ 内容感知解析(auto→列内容、minmax 地板/封顶、fr 剩余分配 + 地板重分配) | `grid_formatting_context.rs`(4,936 行) | 8 测试 |
| B8 | ~~**flex shrink 通道**~~ ✅ **已完成** | shrink×basis 比例收缩 + min-content 地板 + forceContentWidth 贯穿(layoutBlock 尊重分配尺寸);wrap 场景按行收缩为后续 | `flex_formatting_context.rs`(3,299 行) | 5 测试 |

**B 组合计 ~9,000 行手写。B1 必须先做(其他全部依赖匿名盒)。**

## 层③-C:绘制与合成(现代页面"画对"的门槛)

| # | 机制 | 我们的落点 | Ladybird 参考 | 规模估计 |
|---|------|-----------|---------------|---------|
| C1 | ~~**Stacking context 建立规则 + 完整 paint order**~~ ✅ **已在途工作中完成**(验证后标记) | `paint/src/index.ts` readLayer:opacity/transform/filter 建 push-layer 包裹子树 = stacking 包含;z-index 兄弟排序含负值优先 | `stacking_context/entries.rs`(313 行)+ `record/traversal.rs` 4 相位 | 已验证 |
| C2 | ~~**Display list 扩充:gradient**~~ ✅ **已完成** | `paint/gradient.ts`(CSS Images §4 解析器)+ `ir` gradient op(multi-stop+angle+radius)+ backend `fillGradient`(规范渐变线投影光栅)+ GPU Fragment 泛化为 multi-stop/angle(quad 着色)+ app 滚动位移。transform/圆角/GPU 图层此前已在 | `painting/display_list/commands.rs` | 11 测试全绿,像素采样验证红→蓝插值 |
| C3 | **命中测试走 stacking/变换后的真实几何** | `layout/src/hit-test.ts` | `painting/` hit-test 路径 | ~300 行 |
| C4 | **Damage / 脏矩形**(全量重绘 → 命令级 diff) | `paint` + `gpu` | `display_list/damage.rs`(1,322 行) | ~600 行 |

## 层③-D:DOM 与运行时语义("像浏览器"的行为)

| # | 机制 | 我们的落点 | Ladybird 参考 | 规模估计 |
|---|------|-----------|---------------|---------|
| D1 | ~~**MutationObserver 真实实现**~~ ✅ **已完成** | `packages/cli/src/mutation-observer.ts`(controller)+ `fine.ts`(6 个变更点通知)+ `script.ts`(真实类接线) | `DOM/MutationObserver.cpp`(315 行)+ `Node.cpp:3442` 记录产生点,微任务批量投递 | ~250 行(实耗) |
| D2 | ~~**脚本加载顺序语义**~~ ✅ **已完成** | `engine-runtime.ts`(defer/async 分类 + 文档顺序组装，修掉 inline-first bug)+ `event-loop.ts`(三阶段执行 + 静态脚本 load 事件 + currentScript box 连接修复) | `HTML/HTMLScriptElement.cpp`(882 行) | 7 测试全绿 |
| D3 | **事件循环任务源 + 规范渲染时序**(30 个任务源、每任务后微任务检查点、update_the_rendering) | `cli/src/event-loop.ts`(现单队列虚拟时钟) | `HTML/EventLoop/EventLoop.cpp`(1,032 行;rendering_opportunity L254、update_the_rendering L392-702) | ~700 行 |
| D4 | ~~**伪类状态维护(:hover/:active/:focus)**~~ ✅ **已完成** | `InteractionState`(cascade 包,hovered/active/focused 集合)贯穿 ruleMatches→selectWinners→cascade→resolveParentStyle(继承链);`FineInteractionState` kernel input(setInput 即失效,只重级联不重建);FineSession.setInteractionState API | `Document.cpp:3051` set_hovered_node + `PseudoClassInvalidator` | 6 测试;**:hover/:active/:focus/:focus-visible/:focus-within 五伪类** |
| D5 | ~~**document.write + 解析器插入点**~~ ✅ **已完成** | `script.ts` document.write/writeln/open/close + `insertHtmlAfterNode`(插入点 = currentScript 后;无脚本时落 body)+ 共享 parse-and-import 引擎(与 innerHTML 复用) | `Document.cpp:996` | 8 测试;**写出的内容参与级联+布局** |
| D6 | ~~**Shadow DOM + slot 分配**~~ ✅ **Phase 1 完成** | `ShadowComposition`(flat-tree:host→shadow 子、slot→分配子)贯穿 tree-builder 全 fixup 链 + flex/grid/multicol 容器;kernel input `FineComposition`(setInput 即失效);guest `attachShadow` API + `createCompositionController`(shadow 变更经 mutation seam 同步);**shadow 内容参与级联+布局** | `ShadowRoot.cpp`(407)+ `Slottable.cpp`(345) | 6 测试;slot 分配引擎为后续 |

**D1 是宪法合规问题,不排队,立即修。**

## 层③-E:文本管线(真实站点的另一半)

| # | 机制 | 我们的落点 | Ladybird 参考 | 规模估计 |
|---|------|-----------|---------------|---------|
| E1 | ~~**HarfBuzz shaping 接入**~~ ✅ **已完成** | `font/harfbuzz-shaper.ts`(harfbuzzjs 1.6 WASM:Blob/Face/Font/Buffer/shape,内置 TTF 真实度量+kerning/ligature/cluster;UTF-16 cluster 展开保 seam 契约)+ `cli/fonts.ts` 的 ENGINE_SHAPER=harfbuzz 环境开关(懒加载,默认路径零改动) | Ladybird 复用 HarfBuzz(同路验证) | 10 测试;hello 真实 54.9px vs 占位 40px;管线换 real shaper 零算法改动 |
| E2 | ~~**text-transform(渲染文本视图)**~~ ✅ **已完成** | `applyTextTransform` + `readTextTransform` 在三处应用(layoutInline 单文本/run 成员收集/maxContent 估算——shrink-to-fit 跟随变换) | `text_transform.rs`(439 行) | 8 测试;DOM 原文不动,shaped 视图变换 |
| E3 | **字体 fallback 链 + @font-face 加载状态** | `font/src/fallback.ts`(已有雏形) | `LibGfx` 字体级联 + `CSS/FontFace.cpp` | ~500 行 |

## 层③-F:增量语义层(我们的差异化优势,不是追赶)

| # | 机制 | 我们的落点 | Ladybird 参考 | 规模估计 |
|---|------|-----------|---------------|---------|
| F1 | **值级失效掩码消费 affects-* 元数据**(导入行已带 affectsLayout 等字段——数据已就位,只差消费者;让 repaint-only 编辑不再触发 relayout) | `cascade` + `kernel` 查询粒度 | `style/style_invalidation.rs`(832 行,11 个失效位) | ~400 行 |
| F2 | ~~**Style sharing 缓存**~~ ✅ **已完成** | `styleShareCache`(WeakMap<RuleIndex, Map<shareKey, {parentKey, style}>>):shareKey = tag+classes+规则序+inline style+交互态;parentKey = 可继承字段投影;命中返回冻结对象+写 cache;`cascade()` 按 sheets 缓存 index(否则 WeakMap 键永不命中) | `StyleComputer.h` StyleSharingKey/Cache | 4 测试;**共享对象 === 验证** |
| F3 | **布局语义边界叠加在查询内核上**(abspos 子树不影响祖先 intrinsic size 这类剪枝规则——不是换成它的白名单) | `kernel` + `layout` 查询组织 | `partial_relayout.rs`(945 行,边界白名单)+ `fc_run_cache.rs`(957 行,语义放宽键) | ~600 行 |

---

## 层④:明确不移的(及为什么)

1. **Rust CSS/布局引擎本体(WASM 化)** — 增量内核会死在边界上(blob 内部计算对依赖追踪是黑盒);且它没有独立形态(经 StyleEngineBoundary 反调 C++ DOM,拖 LibGC/HarfBuzz/Skia);还摧毁"一个人能读完"的叙事。**永不。**
2. **LibJS / LibGC / AK** — 我们的宪法是复用 V8,GC 由 JS 引擎自带。
3. **逐行翻译任何 FC** — 它们的即时遍历+原地修改模型与我们的纯查询+冻结 IR 不兼容;翻译会拖入突变模型,杀死增量。
4. **WebCompat UA 伪装清单** — 我们只有 3 行参考价值;等我们真到了那个兼容层级再说。
5. **预期输出基线** — Ladybird 的 expected/ 文本是它自己引擎的 dump 格式,不可移植;我们只导入测试输入,基线自己生成。

## 复用清单(与 Ladybird 选型对齐,走我们既有 seam)

HarfBuzz(shaping)/ FreeType(栅格)/ Skia 或 canvaskit(绘制)/ ICU(Unicode)。
Ladybird 也是复用它们——这验证了我们 MANIFESTO 的"复用不可约的脏活"路线。

## 执行顺序建议

```
已完成:  D1(MutationObserver 真实现,宪法违规修复 — 15 个测试,dom 基线持平无回归)
已完成:  url harness 修复(不是引擎缺陷——sandbox 缺 fetch/URL、/common/ 被误跳;
         url 区域 0 → 4,144/5,130 = 81%,纯 harness 修复零引擎改动)
已完成:  A1(@layer — 已在代码中实现,验证后标记完成)
已完成:  A2(媒体查询 range 语法 + or/not + hover/pointer/prefers-*/display-mode,
         43 测试全绿,@media 样式表路径完整)
已完成:  D2(脚本三阶段执行 blocking→defer→async + 文档顺序修复 + 静态脚本 load
         事件 + currentScript box 连接修复;顺手修掉两个既有 bug)
已完成:  B1 Phase 1(tree builder:匿名 block/table fixup + UA 表格 display 翻转;
         修掉表格裸文本丢弃 bug;真实 HTML 表格进表格布局;站点验证
         shiaho PASS + bilibili 12/12 PASS)
已完成:  A5(12 个新 shorthand 展开器:inset/overflow/place-*/text-decoration/font,
         27 展开器测试 + e2e)
已完成:  C1(stacking context — 在途工作中已实现,验证标记)
已完成:  C2(gradient:解析→IR→paint→backend 光栅→GPU multi-stop fragment,
         11 测试 + 像素采样验证)
已完成:  B2(abspos:静态位置/shrink-to-fit/去重)
已完成:  B3(float band 放置 + inline 侵入)
已完成:  B4(baseline/vertical-align 全矩阵 + % 字号 bug 修复)
已完成:  B6(table 自动布局)/ B7(grid track sizing)/ B8(flex shrink)
         —— B 组全部收官(B5 的估算版已随 B2 落地)
已完成:  API 面补齐第一批(Web Streams 原生暴露:streams 6→410, 0.5%→36.3%,
         总基线 14,277→14,681)
剩余:    E3(字体 fallback 深化)→ F1/F3(值级失效/布局语义边界)
         API 面补齐第二批(web-animations 的 test 资源 / html 的 createDiv
         等 helper 函数)
         FreeType 接入)→ F 组(值级失效/style sharing/布局语义边界)
         深化项:flex per-line shrink、table 折叠边框、grid areas
```

每个机制落地时的验收:**对应 Ladybird 参考文件里覆盖的边界用例,在我们的
reftest/WPT 导入集(`wpt-imported/`)里有等价用例且通过**;全量基线
(`wpt-imported/baseline.json`)的对应区域通过数上升——这就是我们导入
3,918 个 WPT 用例的用法。
