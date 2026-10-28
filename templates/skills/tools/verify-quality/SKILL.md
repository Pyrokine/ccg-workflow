---
name: verify-quality
description: 代码质量校验关卡，使用项目语言工具检查类型、复杂度和 lint，报告检查覆盖与未完成项，当用户提到代码质量、复杂度检查、代码异味、重构建议、lint 检查或代码规范时使用，在复杂模块、重构完成时自动触发
license: MIT
compatibility: node>=18
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Glob
argument-hint: <扫描路径> [--base ref]
---

# 代码质量校验

## 执行检查

默认使用语言检查模式，从项目工作目录调用脚本，脚本路径以本 Skill 的资源目录为准：

```bash
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks
node /path/to/verify-quality/scripts/quality_checker.js src/main.ts src/components --language-checks --json
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks --base HEAD~1 -v
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks --target-version py38
```

支持单文件、目录和多个目标，目标相对当前工作目录解析，省略目标时扫描当前目录，重叠文件只分析一次

`--exclude generated` 追加排除目录名称，默认排除 Git 元数据、依赖、虚拟环境和构建目录，包括 `target`、`vendor`、`third_party` 和 `third-party`；显式指定的文件仍会检查，`--` 后的参数全部作为路径处理，`--help` 只显示用法

未支持的自定义构建配置显式返回 `UNSUPPORTED_TYPE`、零覆盖和退出码 2，使用对应构建工具验证其配置

已有直接调用保持文本规则模式：

```bash
node /path/to/verify-quality/scripts/quality_checker.js src --json
```

文本规则模式标记为 `analysis_mode: text`，只对本次请求的文本规则给出完成状态；使用该模式交付时注明语言工具未执行，语言工具失败时保留增强模式的未完成结果

## 语言工具与覆盖

| 源码 | 执行检查 | 要求与范围 |
|---|---|---|
| JS／TS | ESLint 项目规则与 AST 阈值 | 使用目标项目或工作区的本地依赖及配置，保持源码和缓存不变 |
| TypeScript 项目 | 类型、语法与项目诊断 | 使用项目本地 compiler API；包仅提供 CLI 时，先枚举项目实际文件再检查诊断，支持 references，禁用 emit，build-info 仅写临时目录 |
| Python | Ruff 项目规则 | 使用已安装的 Ruff，沿用项目目标版本；`--target-version py38` 显式覆盖，文件枚举与诊断使用相同目标，禁用修复和缓存，报告排除文件 |
| C／C++ | clang-tidy 诊断 | 使用已安装工具和现有 compilation database，保留真实编译参数，仅分析有记录的输入 |
| Go | go vet 诊断 | 使用 `go list -json -test` 确认包与测试文件覆盖，沿用平台、构建标签和有效 overlay，离线检查只读模块 |
| Rust | Cargo／Clippy 诊断 | 使用现有 workspace、锁文件和依赖缓存，JSON 诊断与本次 rustc dep-info 共同确认覆盖，执行 `--frozen --offline --all-targets --no-deps` |
| 其他受支持源码 | 文本规则 | 语言分析未覆盖，增强模式报告未完成 |

Node 工具按项目及工作区边界查找，使用各工具要求的运行环境；嵌套包可使用同一 Git 仓库内父项目的 ESLint 配置和本地依赖，实际覆盖由 ESLint 判断，被忽略或未覆盖的文件仍报告未完成，查找止于仓库边界

本地依赖按 Node package exports 解析，保留所选包的归属；TypeScript 优先使用 compiler API，缺少该 API 时调用同一包声明的 `bin.tsc`，包括 TypeScript 7 的 CLI，报告中的 `reason` 标明实际检查方式，缺少 CLI、配置错误或文件未覆盖时报告未完成，工具缺失时由用户管理安装和项目配置

`checks[].files` 列出实际覆盖的请求文件，`requested_files`、`skipped_files` 和 `uncovered` 说明覆盖差异，类型检查也会报告同一项目中其他文件的诊断

Go 将构建缓存与工作区临时副本写入私有目录，复用已有模块缓存中的只读资源；Rust 将产物写入私有 target 目录，沿用目标工程已有构建脚本和过程宏，检查结束后清理临时目录

缺少 manifest、锁文件、依赖缓存、工具链或有效 overlay 时报告未完成；平台、构建标签或 cfg 排除的请求文件记录在 `uncovered`，目录归属本身不作为覆盖证据

子工具使用明确参数、超时和输出上限执行，Go／Rust 每组命令共用 30 秒预算，单次输出上限为 8 MiB；POSIX 原生命令结束时清理其进程组，诊断只保留工具、规则、位置和严重度，消息和源码内容脱敏

## 文本指标与阈值

| 指标 | 默认阈值 | 检查方式 |
|---|---|---|
| 行长度 | 120 字符 | 文本规则，info |
| 文件代码行数 | 500 行 | 文本规则，warning |
| 函数长度 | 50 行 | JS／TS 使用 ESLint AST，Python 文本规则为正则估算 |
| 圈复杂度 | 10 | JS／TS 使用 ESLint AST，Python 文本规则为启发式估算 |
| 参数数量 | 5 | JS／TS 使用 ESLint AST，Python 文本规则为正则估算 |
| Python 命名 | 函数 snake_case、类 PascalCase | 文本规则 |

函数长度、复杂度和参数数量的默认阈值在 ESLint 中作为 warning 执行，项目其他 lint 错误保留原有严重度

通过 Vitest import 绑定识别的 `describe`／`suite` 注册容器不计入函数长度，别名、namespace 和注册修饰链按作用域判断；单个测试函数、生产函数及被参数遮蔽的同名调用继续使用原阈值

重复代码、死代码、变量命名和完整数据流检查取决于项目另行启用的工具或规则，当前脚本不提供统一检测

## 比较新增与既有问题

默认使用各目标仓库的 `HEAD`，`--base <ref>` 指定其他比较点；内置规则对历史 Git blob 使用相同检查逻辑，按规则、上下文和出现次数比较，支持行号移动和 Git 识别的 rename

`origin` 为 `new`、`existing` 或 `unclassified`，`origin_counts` 给出数量；外部工具诊断缺少同工具基线时保留 `unclassified`，`change_scope` 只说明是否关联变更行

没有 Git 或 HEAD 时继续扫描，并报告基线不可用；显式指定无法使用的基线时报告未完成

文本报告优先展示新增问题，既有问题汇总，`-v` 展开全部位置；同工具、项目和原因的未覆盖提示及重复基线提示合并展示，JSON 保留逐文件覆盖、全部发现和基线状态，退出码不受展示方式影响，既有 error 仍参与阻断

## 结果与退出码

| 退出码 | 结果 | 判定 |
|---|---|---|
| 0 | 当前请求的检查完成且没有 error | warning 和 info 保持非阻断 |
| 1 | 检查完成且发现 error | 检查失败，保留完整诊断位置 |
| 2 | 检查未完成 | 缺失路径、读取失败、零覆盖、缺工具、配置错误、超时、异常终止、输出无效或请求文件未覆盖 |

JSON 保留 `passed`、`files_scanned`、行数、问题和计数字段，增加检查方式、工具、未覆盖和基线信息；`coverage[].eligible_files` 是候选文件数，`files_scanned` 只统计成功读取并完成文本分析的文件

只有 `complete: true` 时才按所请求模式说明检查完成，类型检查和 lint 的通过不能替代功能测试
