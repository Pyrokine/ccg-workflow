---
name: verify-change
description: 变更校验关卡，分析代码变更、相关文档更新和影响范围，当用户提到变更检查、文档同步、代码审查、提交前检查或 diff 分析时使用，在设计级变更和重构完成时自动触发
license: MIT
compatibility: node>=18
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Grep
argument-hint: [paths...] [--mode working|staged|committed]
---

# 变更校验

## 分析当前修改

从项目工作目录调用脚本，脚本路径以本 Skill 的资源目录为准：

```bash
node /path/to/verify-change/scripts/change_analyzer.js --json
node /path/to/verify-change/scripts/change_analyzer.js ./src ./tests --mode staged
node /path/to/verify-change/scripts/change_analyzer.js /path/to/project --mode committed -v
```

目标可以是文件、目录和已删除路径，相对调用时的工作目录解析，省略目标时使用当前目录；同仓库合并范围，不同仓库分别报告，pathspec 使用字面路径

| 模式 | 输入 | 行数 |
|---|---|---|
| working | 暂存、未暂存和未跟踪文件 | 包含暂存与未暂存改动，未跟踪文件按实际内容计数 |
| staged | 暂存区 | 仅统计暂存改动 |
| committed | HEAD~1 与 HEAD | 统计最近一次提交 |

`--help` 只显示用法，`--` 后的参数作为路径处理；范围通过目标指定，`--exclude` 不适用于此脚本

## 文档与测试提示

模块按最近的现有 README、DESIGN 或 SKILL.md 所在目录识别，支持双语 README；关联文档包含这些入口链接的本地 Markdown 说明，例如 `references/` 中的文档，没有模块文档时保留目录范围供人工判断

纯测试变更不触发实现文档更新提醒；实现变更超过 50 行时，检查模块已有 README、DESIGN、链接的本地说明和文档目录中的关联文件

相关文档均未更新时提醒人工确认，更新无关文档不计为同步；没有关联文档时只提示判断说明需求，不要求创建空 DESIGN.md

代码影响分析保持请求的路径范围，关联文档按所选 Git 模式查询其变更状态，范围外已修改的相关文档同样计为更新，报告的 `changes` 仍只包含请求范围

`doc_sync_status` 保留已有文档是否随所选变更更新的布尔值，`doc_sync` 分别记录 `exists` 和 `updated`；这些字段说明文件状态，文档内容是否充分仍需阅读判断

自然语言任务先转换为已核实的文件或目录，再作为独立路径参数调用脚本

| 情况 | 提示 | 后续动作 |
|---|---|---|
| 实现变更超过 50 行，已有相关文档未更新 | warning | 核对接口、用法和设计说明是否变化 |
| 实现变更超过 50 行，没有关联文档 | info | 判断是否需要说明或现有说明是否位于其他位置 |
| 实现变更超过 30 行，没有测试变更 | warning | 检查相关测试是否已有覆盖，并执行适用测试 |
| 配置变更 | info | 核对配置和用法说明 |
| 删除文件 | info | 检查调用、引用和安装内容 |

测试变更提示识别 test/spec/smoke 命名的测试文件，以及 Rust 中 `#[cfg(test)]` 模块、`mod tests` 和 `#[test]`／`#[tokio::test]` 函数的实际变更行；`has_test_changes` 表示存在内联测试变更，`test_only` 表示改动仅在测试范围，混合实现文件继续参与文档检查，未变动的既有测试不计为更新

内联测试按文本结构和 Git 差异识别，不计算测试覆盖率

变更分析要求 Git 历史、暂存区或工作区作为比较来源；非 Git 附件返回退出码 2 和未完成，使用已有附件比较结果记录差异，质量与安全脚本可直接检查非 Git 源码

## 结果与退出码

| 退出码 | 结果 | 判定 |
|---|---|---|
| 0 | 分析完成且没有阻断问题 | 无变更也返回成功和空 changes |
| 1 | 分析完成且有 error | 按发现处理 |
| 2 | 分析未完成 | 非 Git 目标、目标不存在、无效模式、Git 失败或缺少父提交 |

单仓库 JSON 保留 `changes`、行数、`affected_modules`、`issues`、`doc_sync_status`，并提供仓库 root、请求目标、完成状态及文档详情；跨仓库结果使用 `repositories` 数组

修改前阅读相关模块已有说明和直接调用者，修改后核对真实接口、安装内容、文档与测试；将设计决策写入项目实际维护的文档
