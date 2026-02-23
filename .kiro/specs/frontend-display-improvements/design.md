# Frontend Display Improvements Bugfix Design

## Overview

本设计文档针对 `/overview.html` 页面的两个前端显示问题提供修复方案：

1. **JSON 对象摘要显示问题**：`renderJsonNode` 函数在折叠状态下仅显示 "Object(3)" 或 "Array(2)" 这样的类型摘要，用户无法快速了解对象内容。修复方案是在摘要行中内联显示关键字段的键值对。

2. **Queue / Latency Timeline 图表显示问题**：图表的视觉效果不佳，缺乏足够的视觉层次和可读性。修复方案是优化 SVG 路径渲染、增强网格线样式、改进坐标轴标签布局。

修复策略采用最小化改动原则，仅针对缺陷部分进行精确修复，确保不影响现有的 JSON 展开功能、日期格式化、其他页面的 JSON 视图以及图表的数据处理逻辑。

## Glossary

- **Bug_Condition (C)**: 触发 bug 的条件 - 当 JSON 对象在折叠状态下显示时，或图表渲染时视觉效果不佳
- **Property (P)**: 期望的正确行为 - 折叠状态下显示关键字段预览，图表具有良好的视觉层次和可读性
- **Preservation**: 必须保持不变的现有行为 - JSON 展开功能、日期格式化、基本类型渲染、其他页面功能
- **renderJsonNode**: `src/public/app.js` 中的函数，负责递归渲染 JSON 数据为 HTML `<details>` 元素
- **renderQueueTrend**: `src/public/app.js` 中的函数，负责渲染 Queue / Latency Timeline 图表的 SVG 路径
- **summary**: `<details>` 元素的摘要行，用户在折叠状态下看到的内容
- **isBugCondition**: 判断输入是否触发 bug 的函数

## Bug Details

### Fault Condition

Bug 在以下两种情况下显现：

**情况 1 - JSON 对象摘要显示不足**：
当 `renderJsonNode` 函数处理对象或数组类型的值时，在折叠状态下仅生成类型摘要文本（如 "Object(3)" 或 "Array(2)"），不显示对象内部的关键字段。这导致用户必须展开每个对象才能了解其内容。

**情况 2 - 图表视觉效果不佳**：
当 `renderQueueTrend` 函数渲染 Queue / Latency Timeline 图表时，SVG 路径、网格线、坐标轴标签的视觉层次不够清晰，影响数据可读性。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { type: string, value: any, context: string }
  OUTPUT: boolean
  
  RETURN (
    // Case 1: JSON object summary issue
    (input.type === "json-render" 
     AND input.value IS Object 
     AND Object.keys(input.value).length > 0
     AND input.context === "collapsed-summary")
    
    OR
    
    // Case 2: Chart visual quality issue
    (input.type === "chart-render"
     AND input.context === "queue-latency-timeline"
     AND chartVisualQuality(input.value) < ACCEPTABLE_THRESHOLD)
  )
END FUNCTION
```

### Examples

**JSON 对象摘要问题示例**：

- **示例 1**：渲染 `{ queues: { work: { messageCount: 3, consumerCount: 1 }, retry: { messageCount: 0 }, dead: { messageCount: 0 } } }`
  - 当前行为：折叠时显示 "queues: Object(3)"
  - 期望行为：折叠时显示 "queues: { work: {...}, retry: {...}, dead: {...} }"

- **示例 2**：渲染 `{ work: { messageCount: 3, consumerCount: 1 } }`
  - 当前行为：折叠时显示 "work: Object(2)"
  - 期望行为：折叠时显示 "work: { messageCount: 3, consumerCount: 1 }"

- **示例 3**：渲染 `{ runtimeConsumers: ["story-worker", "incident-worker"] }`
  - 当前行为：折叠时显示 "runtimeConsumers: Array(2)"
  - 期望行为：折叠时显示 "runtimeConsumers: [2 items]" 或 "runtimeConsumers: ["story-worker", "incident-worker"]"

- **边界情况**：渲染包含大量字段的对象（如 20+ 字段）
  - 期望行为：摘要行应该截断显示，避免过长（如显示前 3-5 个字段 + "..."）

**图表视觉效果问题示例**：

- **示例 1**：网格线颜色 `#E2E8F0` 过于突出，与数据线条形成视觉竞争
  - 期望行为：网格线应该更淡，使用更低的透明度或更浅的颜色

- **示例 2**：坐标轴标签字体大小 9px 可能过小，在某些屏幕上难以阅读
  - 期望行为：适当增大字体或增强对比度

- **示例 3**：数据线条 stroke-width 2.4px 可能不够平滑
  - 期望行为：优化线条宽度和抗锯齿效果

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- 用户点击 `<details>` 元素展开嵌套对象时，必须继续显示完整的嵌套结构和所有字段
- ISO 日期字符串必须继续被格式化为 UTC+8 时区的可读时间格式
- 基本类型（string、number、boolean、null）必须继续正确渲染类型和内容
- 其他页面（boot、stories、incidents）的 JSON 视图功能必须继续正常工作
- 大型对象或深层嵌套结构的渲染性能必须保持稳定
- 图表数据为空或历史数据不足时，必须继续优雅处理边界情况
- 图表的数据处理逻辑（历史记录、路径计算、坐标轴刻度）必须保持不变
- 图表的交互行为（如果有）必须保持不变

**Scope:**
所有不涉及以下情况的输入应该完全不受此修复影响：
- 非折叠状态的 JSON 渲染（展开状态）
- 基本类型值的渲染
- 其他页面的 JSON 视图
- 图表之外的其他 UI 组件
- 图表的数据获取和处理逻辑

## Hypothesized Root Cause

基于 bug 描述和代码分析，最可能的问题原因如下：

### JSON 对象摘要问题

1. **摘要内容不足**：`renderJsonNode` 函数在生成对象摘要时，仅使用 `Object(${keys.length})` 或 `Array(${value.length})`，没有提取和显示对象内部的关键字段
   - 代码位置：`src/public/app.js` 第 387 行和第 376 行
   - 当前实现：`const summary = \`\${keyHtml}<span class="json-type">Object(\${keys.length})</span>\`;`
   - 缺失功能：没有遍历对象的键值对并生成内联预览

2. **缺少智能截断逻辑**：对于包含大量字段的对象，没有实现截断机制，可能导致摘要行过长
   - 需要添加：字段数量阈值判断（如 5 个字段）
   - 需要添加：超出阈值时显示 "..." 省略符号

3. **数组摘要不够友好**：数组摘要仅显示长度，对于包含简单值的短数组，可以直接显示内容
   - 当前实现：`Array(2)` 对所有数组一视同仁
   - 改进方向：短数组（如 ≤3 项）且元素为基本类型时，直接显示内容

### 图表视觉效果问题

1. **网格线视觉权重过高**：网格线使用 `stroke="#E2E8F0"` 和 `stroke-width="1"`，颜色对比度较高
   - 代码位置：`src/public/app.js` 第 793-796 行
   - 改进方向：降低透明度或使用更浅的颜色（如 `#F1F5F9`）

2. **坐标轴标签可读性不足**：字体大小 9px 可能在某些屏幕上过小
   - 代码位置：`src/public/styles.css` 第 411-414 行
   - 改进方向：增大字体到 10px 或增强颜色对比度

3. **数据线条缺乏视觉层次**：所有线条使用相同的 stroke-width 2.4px，没有主次之分
   - 代码位置：`src/public/styles.css` 第 419-447 行
   - 改进方向：为重要指标（如 work）使用稍粗的线条，或添加阴影效果

4. **SVG 容器样式不够精致**：边框和背景色可能缺乏视觉深度
   - 代码位置：`src/public/styles.css` 第 395-401 行
   - 改进方向：添加轻微阴影或调整边框颜色

## Correctness Properties

Property 1: Fault Condition - JSON Object Summary Enhancement

_For any_ JSON object or array input where the object is rendered in collapsed state (details element closed), the fixed renderJsonNode function SHALL display a summary that includes key field names and values (for objects with ≤5 fields) or key field names with ellipsis (for objects with >5 fields), instead of only showing "Object(N)" or "Array(N)".

**Validates: Requirements 2.2, 2.3, 2.4**

Property 2: Fault Condition - Chart Visual Quality Enhancement

_For any_ chart rendering input for the Queue / Latency Timeline, the fixed renderQueueTrend function and associated CSS styles SHALL produce a chart with improved visual hierarchy (lighter grid lines, enhanced axis labels, optimized line styles) that provides better data readability.

**Validates: Requirements 2.1**

Property 3: Preservation - JSON Expansion Behavior

_For any_ JSON rendering input where the user expands a details element or renders primitive types, the fixed code SHALL produce exactly the same behavior as the original code, preserving full nested structure display, date formatting, and type rendering.

**Validates: Requirements 3.1, 3.2, 3.3**

Property 4: Preservation - Other Pages and Performance

_For any_ JSON rendering on other pages (boot, stories, incidents) or rendering of large/deeply nested objects, the fixed code SHALL produce exactly the same behavior and performance characteristics as the original code.

**Validates: Requirements 3.4, 3.5**

Property 5: Preservation - Chart Data Processing

_For any_ chart rendering input, the fixed code SHALL preserve all existing data processing logic (history tracking, path calculation, axis scaling, edge case handling) and produce the same data representation as the original code, only changing visual styling.

**Validates: Requirements 3.6**

## Fix Implementation

### Changes Required

假设我们的根本原因分析正确，需要进行以下修改：

**File**: `src/public/app.js`

**Function**: `renderJsonNode` (Line 368)

**Specific Changes**:

1. **增强对象摘要生成逻辑**：
   - 在生成对象摘要时，检查对象的键数量
   - 如果键数量 ≤ 5，遍历所有键值对并生成内联预览：`{ key1: value1, key2: value2, ... }`
   - 如果键数量 > 5，显示前 3-4 个键 + "..."：`{ key1: value1, key2: value2, ... (N more) }`
   - 对于嵌套对象，在摘要中显示为 `{...}` 而不是完整展开

2. **改进数组摘要显示**：
   - 检查数组长度和元素类型
   - 如果数组长度 ≤ 3 且所有元素为基本类型（非对象/数组），直接显示内容：`[value1, value2, value3]`
   - 如果数组包含对象或长度 > 3，显示：`[N items]` 或 `[item1, item2, ... (N more)]`

3. **添加值截断辅助函数**：
   - 创建 `truncateValue(value, maxLength)` 函数，用于截断过长的字符串值
   - 在摘要中，字符串值超过 20 字符时截断并添加 "..."

4. **优化摘要 HTML 生成**：
   - 使用更语义化的 CSS 类名，如 `json-summary-preview` 用于内联预览部分
   - 确保生成的 HTML 不会因为特殊字符导致 XSS 问题（继续使用 `esc()` 函数）

**Function**: `renderQueueTrend` (Line 728)

**Specific Changes**:

5. **优化网格线渲染**：
   - 将网格线颜色从 `#E2E8F0` 改为更浅的 `#F1F5F9` 或添加透明度 `stroke-opacity="0.5"`
   - 考虑使用虚线样式 `stroke-dasharray="2,2"` 使网格线更轻量

**File**: `src/public/styles.css`

**Specific Changes**:

6. **增强坐标轴标签样式**：
   - 将 `.axis-label` 字体大小从 9px 增加到 10px
   - 调整颜色从 `#94a3b8` 到更深的 `#64748b` 以提高对比度

7. **优化数据线条样式**：
   - 考虑为 `.line-work` 添加稍粗的 stroke-width（如 2.8px）以突出主要指标
   - 或为所有线条添加轻微的 `filter: drop-shadow()` 效果增强视觉层次

8. **改进图表容器样式**：
   - 为 `.timeline-canvas` 添加轻微的 box-shadow：`box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05)`
   - 调整边框颜色为更柔和的 `#e5e7eb`

## Testing Strategy

### Validation Approach

测试策略采用两阶段方法：首先在未修复的代码上运行探索性测试以暴露 bug 的具体表现，然后验证修复后的代码正确实现了期望行为并保持了现有功能不变。

### Exploratory Fault Condition Checking

**Goal**: 在实施修复之前，在未修复的代码上运行测试以暴露 bug 的反例。确认或反驳根本原因分析。如果反驳，需要重新假设。

**Test Plan**: 编写测试用例模拟各种 JSON 对象和图表渲染场景，在未修复的代码上运行并观察失败模式。使用浏览器开发者工具检查生成的 HTML 和 CSS。

**Test Cases**:

1. **Small Object Summary Test**: 渲染 `{ messageCount: 3, consumerCount: 1 }` 并检查折叠状态的摘要
   - 在未修复代码上运行：预期显示 "Object(2)"
   - 确认缺陷：摘要不包含字段信息

2. **Nested Object Summary Test**: 渲染 `{ queues: { work: {...}, retry: {...}, dead: {...} } }` 并检查折叠状态
   - 在未修复代码上运行：预期显示 "queues: Object(3)"
   - 确认缺陷：无法看到 work、retry、dead 键名

3. **Large Object Summary Test**: 渲染包含 10 个字段的对象并检查摘要
   - 在未修复代码上运行：预期显示 "Object(10)"
   - 确认缺陷：摘要过于简略，且没有截断机制

4. **Short Array Summary Test**: 渲染 `["story-worker", "incident-worker"]` 并检查摘要
   - 在未修复代码上运行：预期显示 "Array(2)"
   - 确认缺陷：对于短数组，可以直接显示内容但未实现

5. **Chart Grid Line Visual Test**: 在浏览器中查看 Queue / Latency Timeline 图表
   - 在未修复代码上运行：观察网格线是否过于突出
   - 确认缺陷：网格线颜色 `#E2E8F0` 视觉权重较高

6. **Chart Axis Label Readability Test**: 检查坐标轴标签的字体大小和颜色
   - 在未修复代码上运行：观察 9px 字体是否难以阅读
   - 确认缺陷：字体可能过小或对比度不足

**Expected Counterexamples**:
- JSON 对象摘要仅显示类型和数量，不显示字段内容
- 图表网格线视觉权重过高，与数据线条形成竞争
- 可能的原因：摘要生成逻辑过于简单、CSS 样式缺乏视觉层次优化

### Fix Checking

**Goal**: 验证对于所有触发 bug 条件的输入，修复后的函数产生期望的行为。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  IF input.type === "json-render" THEN
    result := renderJsonNode_fixed(input.key, input.value, input.depth)
    htmlDoc := parseHTML(result)
    summary := htmlDoc.querySelector("summary").textContent
    
    IF Object.keys(input.value).length <= 5 THEN
      ASSERT summary CONTAINS at least one field name from input.value
      ASSERT summary CONTAINS at least one field value from input.value
    ELSE
      ASSERT summary CONTAINS "..." OR "(N more)"
    END IF
  END IF
  
  IF input.type === "chart-render" THEN
    renderQueueTrend_fixed(input.queues, input.latency)
    svgElement := document.querySelector("#overview-trend svg")
    gridLines := svgElement.querySelectorAll("line")
    
    ASSERT gridLines[0].getAttribute("stroke") IS lighter than "#E2E8F0"
    ASSERT chartVisualQuality(svgElement) >= ACCEPTABLE_THRESHOLD
  END IF
END FOR
```

### Preservation Checking

**Goal**: 验证对于所有不触发 bug 条件的输入，修复后的函数产生与原始函数相同的结果。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  // Test JSON rendering preservation
  IF input.type === "json-render" AND input.context === "expanded" THEN
    originalResult := renderJsonNode_original(input.key, input.value, input.depth)
    fixedResult := renderJsonNode_fixed(input.key, input.value, input.depth)
    
    // For expanded state, the children content should be identical
    ASSERT extractChildren(originalResult) === extractChildren(fixedResult)
  END IF
  
  IF input.type === "json-render" AND isPrimitiveType(input.value) THEN
    ASSERT renderJsonNode_original(input.key, input.value) === renderJsonNode_fixed(input.key, input.value)
  END IF
  
  // Test chart data processing preservation
  IF input.type === "chart-render" THEN
    originalDataPaths := extractDataPaths(renderQueueTrend_original(input.queues, input.latency))
    fixedDataPaths := extractDataPaths(renderQueueTrend_fixed(input.queues, input.latency))
    
    ASSERT originalDataPaths.workPath === fixedDataPaths.workPath
    ASSERT originalDataPaths.retryPath === fixedDataPaths.retryPath
    ASSERT originalDataPaths.deadPath === fixedDataPaths.deadPath
    ASSERT originalDataPaths.p95Path === fixedDataPaths.p95Path
  END IF
END FOR
```

**Testing Approach**: 属性测试（Property-based testing）推荐用于保持性检查，因为：
- 它自动生成大量测试用例覆盖输入域
- 它能捕获手动单元测试可能遗漏的边界情况
- 它为所有非 bug 输入提供强有力的行为不变保证

**Test Plan**: 首先在未修复代码上观察展开状态、基本类型渲染、其他页面的行为，然后编写属性测试捕获这些行为。

**Test Cases**:

1. **JSON Expansion Preservation**: 在未修复代码上观察展开对象时的完整结构显示，然后验证修复后此行为保持不变
   - 测试方法：对比展开状态下的 HTML 结构和内容

2. **Primitive Type Rendering Preservation**: 在未修复代码上观察 string、number、boolean、null 的渲染，验证修复后完全一致
   - 测试方法：对所有基本类型值进行渲染并比较输出

3. **Date Formatting Preservation**: 在未修复代码上观察 ISO 日期字符串的 UTC+8 格式化，验证修复后保持不变
   - 测试方法：渲染包含日期字符串的对象并检查格式化结果

4. **Other Pages JSON View Preservation**: 在 boot、stories、incidents 页面上测试 JSON 视图功能
   - 测试方法：在这些页面上渲染相同的测试数据，确保行为一致

5. **Chart Data Path Preservation**: 验证图表的 SVG 路径数据（work、retry、dead、p95）在修复前后完全相同
   - 测试方法：提取并比较 SVG path 元素的 d 属性值

6. **Chart Edge Case Preservation**: 测试空数据、单点数据、极值数据等边界情况
   - 测试方法：使用各种边界输入渲染图表，确保不崩溃且显示合理

### Unit Tests

- 测试 `renderJsonNode` 对小对象（≤5 字段）生成包含字段预览的摘要
- 测试 `renderJsonNode` 对大对象（>5 字段）生成截断摘要
- 测试 `renderJsonNode` 对短数组（≤3 项基本类型）生成内联内容
- 测试 `renderJsonNode` 对长数组或对象数组生成 "[N items]" 摘要
- 测试 `renderJsonNode` 对嵌套对象在摘要中显示 `{...}` 占位符
- 测试 `renderJsonNode` 对基本类型的渲染保持不变
- 测试 `renderJsonNode` 对 ISO 日期字符串的格式化保持不变
- 测试 `renderQueueTrend` 生成的 SVG 网格线使用更浅的颜色
- 测试 CSS 样式更新后坐标轴标签字体大小和颜色符合预期
- 测试图表容器的 box-shadow 和边框样式符合预期

### Property-Based Tests

- 生成随机 JSON 对象（不同字段数量、嵌套深度、值类型），验证摘要生成逻辑正确处理所有情况
- 生成随机 JSON 对象并验证展开状态下的渲染与原始实现完全一致（保持性测试）
- 生成随机基本类型值并验证渲染结果与原始实现完全一致（保持性测试）
- 生成随机图表数据（不同数值范围、历史长度），验证 SVG 路径数据保持不变（保持性测试）
- 生成包含特殊字符的 JSON 对象，验证 HTML 转义正确且无 XSS 风险

### Integration Tests

- 在浏览器中加载 `/overview.html` 页面，验证 Render Status 面板显示改进的 JSON 摘要
- 在浏览器中验证 Queue / Latency Timeline 图表的视觉效果改进（网格线、标签、线条）
- 在浏览器中展开和折叠 JSON 对象，验证交互行为正常
- 在浏览器中访问 boot、stories、incidents 页面，验证 JSON 视图功能正常
- 在浏览器中测试图表在不同数据场景下的显示（空数据、单点、极值）
- 使用浏览器开发者工具检查生成的 HTML 结构和 CSS 样式符合预期
