# Bugfix Requirements Document

## Introduction

用户报告了 `/overview.html` 页面中的两个前端显示问题：

1. Queue / Latency Timeline 图表显示效果不佳，影响数据可读性
2. 多处显示原始 JSON 对象文本（例如 "queues: Object(3)"、"work: Object(2) messageCount: 3"），用户看到的是未格式化的对象摘要而非实际数据内容

这些问题降低了用户体验，使得关键的队列指标和系统状态信息难以快速理解。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN 用户查看 `/overview.html` 页面的 Queue / Latency Timeline 图表区域 THEN 图表显示效果不佳，数据可视化质量低

1.2 WHEN 系统渲染包含嵌套对象的 JSON 数据（如 queues、work、retry、dead 等）THEN 在折叠状态下只显示 "Object(3)" 或 "Array(2)" 这样的类型摘要文本

1.3 WHEN 用户查看 Render Status 面板或其他使用 `renderJsonNode` 函数的区域 THEN 看到的是原始对象摘要（如 "queues: Object(3)"）而非格式化的数据内容

1.4 WHEN 嵌套对象的 `<details>` 元素处于折叠状态 THEN 用户无法直接看到对象内部的关键字段值（如 messageCount、consumerCount）

### Expected Behavior (Correct)

2.1 WHEN 用户查看 `/overview.html` 页面的 Queue / Latency Timeline 图表区域 THEN 图表应该清晰、美观地展示队列和延迟数据，具有良好的可读性

2.2 WHEN 系统渲染包含嵌套对象的 JSON 数据 THEN 应该在摘要行中显示对象的关键字段和值，而不仅仅是 "Object(N)" 文本

2.3 WHEN 用户查看 Render Status 面板 THEN 应该能够在折叠状态下直接看到关键信息（如 messageCount、consumerCount 等字段的值）

2.4 WHEN 嵌套对象包含少量关键字段（如 2-5 个字段）THEN 摘要行应该内联显示这些字段的键值对，格式如 "work: { messageCount: 3, consumerCount: 1 }"

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户点击 `<details>` 元素展开嵌套对象 THEN 系统应该继续显示完整的嵌套结构和所有字段

3.2 WHEN JSON 数据包含 ISO 日期字符串 THEN 系统应该继续将其格式化为 UTC+8 时区的可读时间格式

3.3 WHEN JSON 数据包含基本类型（string、number、boolean、null）THEN 系统应该继续正确渲染这些值的类型和内容

3.4 WHEN 用户在其他页面（boot、stories、incidents）使用 JSON 视图功能 THEN 这些页面的 JSON 渲染应该继续正常工作

3.5 WHEN 系统渲染大型对象或深层嵌套结构 THEN 应该继续保持性能稳定，不出现卡顿或崩溃

3.6 WHEN 图表数据为空或历史数据不足 THEN 系统应该继续优雅地处理这些边界情况，显示占位符或空状态
