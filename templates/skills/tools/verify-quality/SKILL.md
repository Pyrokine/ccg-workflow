---
name: verify-quality
description: 代码质量校验关卡，使用项目语言工具检查类型、复杂度和 lint，报告检查覆盖与未完成项，当用户提到代码质量、复杂度检查、代码异味、重构建议、lint 检查或代码规范时使用，在复杂模块、重构完成时自动触发
license: MIT
compatibility: node>=18
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Glob
argument-hint: <扫描路径> [--base ref] [--eslint-config file] [--compilation-database compile_commands.json]
---

# 代码质量校验

## 验收时机与证据复用

按完整功能阶段汇总触发条件，整批实施完成后集中验收，同一候选的多个触发条件合并为一次检查；保留复现问题或确认中间行为所需的定向检查

候选、输入、工具链、参数、配置和覆盖仍适用时复用结果，修复后只复验受影响部分；独立检查继续完成，失败、超时、不可用、不支持和未完成状态分别保留

回到当前源码与调用者确认 finding，在已授权修复范围内连续处理；只读审查交付发现，需要新范围或权限时请求决定，验收条件满足后结束

## 执行检查

生成的 `/ccg:verify-quality` 命令默认启用语言检查，参数中已有 `--language-checks`
时不会重复添加；从项目工作目录直接调用脚本时使用以下命令，脚本路径以本 Skill 的资源目录为准：

```bash
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks
node /path/to/verify-quality/scripts/quality_checker.js src/main.ts src/components --language-checks --json
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks --base HEAD~1 -v
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks --target-version py38
node /path/to/verify-quality/scripts/quality_checker.js src --language-checks \
  --compilation-database /path/to/build/compile_commands.json
node /path/to/verify-quality/scripts/quality_checker.js workbench/scripts docs/atlas \
  --language-checks --eslint-config workbench/eslint.config.mjs
```

支持单文件、目录和多个目标，目标相对当前工作目录解析，省略目标时扫描当前目录，重叠文件只分析一次

`--exclude generated` 追加排除目录名称，默认排除 Git 元数据、依赖、虚拟环境和构建目录，包括
`target`、`vendor`、`third_party` 和 `third-party`；显式指定的文件仍会检查，`--` 后的参数全部作为路径处理，`--help`
只显示用法

JSON 的 `supported_file_types`
和文本报告的支持类型声明本次文件范围，目录完成状态适用于这些类型；未支持的 YAML 或自定义构建配置显式返回
`UNSUPPORTED_TYPE`、零覆盖和退出码 2，使用对应构建工具验证其配置

Shell 的 `.sh`、`.bash` 和 Shell shebang 文件支持文本与语法检查；JSON 支持文本与 JSON 语法检查；CUDA 的 `.cu`、`.cuh` 和
`.inc` 使用 C／C++ 检查入口，语言检查仍要求对应 compilation database 记录

已有直接调用保持文本规则模式：

```bash
node /path/to/verify-quality/scripts/quality_checker.js src --json
```

文本规则模式标记为
`analysis_mode: text`，只对本次请求的文本规则给出完成状态；使用该模式交付时注明语言工具未执行，语言工具失败时保留增强模式的未完成结果

## 语言工具与覆盖

| 源码            | 执行检查                   | 要求与范围                                                                                                                           |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| JS／TS          | ESLint 项目规则与 AST 阈值 | 使用目标项目或工作区的本地依赖及配置，保持源码和缓存不变                                                                             |
| TypeScript 项目 | 类型、语法与项目诊断       | 使用项目本地 compiler API；包仅提供 CLI 时，先枚举项目实际文件再检查诊断，支持 references，禁用 emit，build-info 仅写临时目录        |
| Python          | Ruff 项目规则              | 使用已安装的 Ruff，沿用项目目标版本；`--target-version py38` 显式覆盖，文件枚举与诊断使用相同目标，禁用修复和缓存，报告排除文件      |
| C／C++          | clang-tidy 诊断            | 使用已安装工具和现有 compilation database，保留真实编译参数，仅分析有记录的输入                                                      |
| Go              | go vet 诊断                | 使用 `go list -json -test` 确认包与测试文件覆盖，沿用平台、构建标签和有效 overlay，离线检查只读模块                                  |
| Rust            | Cargo／Clippy 诊断         | 使用现有 workspace、锁文件和依赖缓存，JSON 诊断与本次 rustc dep-info 共同确认覆盖，执行 `--frozen --offline --all-targets --no-deps` |
| Shell           | 声明的 Shell 执行 `-n`     | 只检查语法，不执行脚本；无 shebang 时 `.bash` 使用 Bash，`.sh` 使用 sh；每组共用 30 s 预算                                           |
| PowerShell      | `Parser.ParseFile`         | 使用已安装的 pwsh 或 powershell，只检查语法，禁用 profile，缺少工具时报告未完成                                                      |
| JSON            | `JSON.parse`               | 只检查 JSON 语法，schema 由项目另行校验                                                                                              |
| 其他受支持源码  | 文本规则                   | 语言分析未覆盖，增强模式报告未完成                                                                                                   |

Node 工具按项目及工作区边界查找，使用各工具要求的运行环境；嵌套包可使用同一 Git 仓库内父项目的 ESLint 配置和本地依赖，实际覆盖由
ESLint 判断，被忽略或未覆盖的文件仍报告未完成，查找止于仓库边界

显式提供 `--eslint-config <file>` 时，JS／TS 的 ESLint 使用该配置及配置所属项目的本地 ESLint
依赖，文件匹配相对调用时的工作目录；检查并列项目时从共同目录调用，未提供该参数时保留原项目边界；TypeScript
类型检查及其他语言工具继续使用各目标原有配置

`--eslint-config` 要求同时启用 `--language-checks`，配置缺失、非文件、依赖缺失或实际文件未被配置覆盖时报告未完成

`--compilation-database <compile_commands.json>` 要求同时启用 `--language-checks`
，可指定仓库外的普通文件，路径相对当前工作目录解析；显式数据库优先，省略时继续就近查找 `compile_commands.json` 或
`build/compile_commands.json`

数据库必须使用标准文件名，clang-tidy 的 `-p` 指向该文件所在目录，条目的相对 `directory` 也按该目录解析；显式数据库无效时报告未完成，缺少编译记录的目标列入
`uncovered`

本地依赖按 Node package exports 解析，保留所选包的归属；TypeScript 优先使用 compiler API，缺少该 API 时调用同一包声明的
`bin.tsc`，包括 TypeScript 7 的 CLI，报告中的 `reason`
标明实际检查方式，缺少 CLI、配置错误或文件未覆盖时报告未完成，工具缺失时由用户管理安装和项目配置

`checks[].files` 列出实际覆盖的请求文件，`requested_files`、`skipped_files` 和 `uncovered`
说明覆盖差异，类型检查也会报告同一项目中其他文件的诊断

Go 复用 CCG 专用的用户私有持久构建缓存，使用 Go 自身的失效、并发和清理机制，原用户 GOCACHE
保持不变；工作区临时副本和模块资源仍隔离，复用已有模块缓存中的只读资源，检查结束后清理临时目录

私有构建缓存无法安全使用时，显式说明原因并采用原有临时缓存路径，实际缓存模式与失败阶段按检查报告判断；离线模式和 120 s
组预算保持，Rust 将产物写入私有 target 目录，沿用工程已有构建脚本和过程宏

缺少 manifest、锁文件、依赖缓存、工具链或有效 overlay 时报告未完成；平台、构建标签或 cfg 排除的请求文件记录在
`uncovered`，目录归属本身不作为覆盖证据

子工具使用明确参数、超时和输出上限执行，Go／Rust 每组命令共用 120 s 逻辑预算，其他检查默认 30 s，单次输出上限为 8
MiB；缓存准备、命令执行和覆盖解析消耗同一组预算，阶段或遍历条目到期后返回未完成，临时目录清理单独计时；POSIX
原生命令结束时清理其进程组，诊断保留工具、规则、位置和严重度，消息和源码内容脱敏

`checks[].timing` 提供 `budget_ms`、`elapsed_ms`、当前 `phase`、各阶段 `phases` 和
`cleanup_ms`，文本报告的“阶段耗时”显示当前阶段及已用预算，没有分阶段计时的检查显示“未记录”；“语言工具”单独展示实际执行状态；同步文件操作在阶段和条目边界检查期限，实际耗时按记录判断

原生命令执行后无法完成分析时，`checks[].execution` 给出实际
`command`、`args`、`exit_code`、`signal`、`timeout_ms`、`duration_ms` 和 `stderr`；`stderr`
保留可识别的运行条件错误，凭据、URL 和源码内容脱敏，最多返回 20 行、2,000 字符

## 文本指标与阈值

| 指标         | 默认阈值                       | 检查方式                                              |
| ------------ | ------------------------------ | ----------------------------------------------------- |
| 行长度       | 120 字符                       | 文本规则，info                                        |
| 文件代码行数 | 500 行                         | 文本规则，warning                                     |
| 函数长度     | 50 行                          | JS／TS 使用 ESLint AST，Python 文本规则为正则估算     |
| 圈复杂度     | 10                             | JS／TS 使用 ESLint AST，Python 文本规则为启发式估算   |
| 参数数量     | 5                              | JS／TS 使用 ESLint AST，Python 文本规则按配平签名统计 |
| Python 命名  | 函数 snake_case、类 PascalCase | 文本规则                                              |

Python 类名允许合法的前导下划线，其余部分仍须为 PascalCase，例如 `_PrivateClass`；普通 snake_case 类名继续提示

Python 参数统计支持多行、嵌套默认值、注解、字符串及 lambda，忽略 `self`、`cls`、`/` 和裸 `*`，`*args`／`**kwargs`
各计一个，签名解析不完整时报告 `PARSE_FAILED`、函数名与行号，文本分析保持未完成，可读文件仍独立执行
Ruff；文件读取失败单独记录为读取错误，Python 2 的元组参数保持文本未覆盖

函数长度、复杂度和参数数量的默认阈值在 ESLint 中作为 warning 执行，项目其他 lint 错误保留原有严重度

通过 Vitest import 绑定识别的 `describe`／`suite`
注册容器不计入函数长度，别名、namespace 和注册修饰链按作用域判断；单个测试函数、生产函数及被参数遮蔽的同名调用继续使用原阈值

重复代码、死代码、变量命名和完整数据流检查取决于项目另行启用的工具或规则，当前脚本不提供统一检测

## 比较新增与既有问题

默认使用各目标仓库的 `HEAD`，`--base <ref>` 指定其他比较点；内置规则对历史 Git
blob 使用相同检查逻辑，按规则、上下文和出现次数比较，支持行号移动和 Git 识别的 rename

`origin` 为 `new`、`existing` 或 `unclassified`，`origin_counts` 给出数量；外部工具诊断缺少同工具基线时保留
`unclassified`，`change_scope` 只说明是否关联变更行

没有 Git 或 HEAD 时继续扫描，并报告基线不可用；显式指定无法使用的基线时报告未完成

文本报告显示所有 error 的位置和规则，包括既有 error；warning 默认按分组限量展示，`-v`
展开全部问题；同工具、项目和原因的未覆盖提示及重复基线提示合并展示，JSON 保留逐文件覆盖、全部发现和基线状态，退出码不受展示方式影响，既有
error 仍参与阻断

## 结果与退出码

| 退出码 | 结果                           | 判定                                                                                   |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------- |
| 0      | 当前请求的检查完成且没有 error | warning 和 info 保持非阻断                                                             |
| 1      | 检查完成且发现 error           | 检查失败，保留完整诊断位置                                                             |
| 2      | 检查未完成                     | 缺失路径、读取失败、零覆盖、缺工具、配置错误、超时、异常终止、输出无效或请求文件未覆盖 |

JSON 保留
`passed`、`files_scanned`、行数、问题和计数字段，增加检查方式、工具、未覆盖和基线信息；`coverage[].eligible_files`
是候选文件数，`files_scanned` 只统计成功读取并完成文本分析的文件；`scan_path` 保留单个目标路径，多个目标显示为 `N 个目标`
，完整目标继续保存在 `requested_paths`，JSON 优先展示完成状态、问题和扫描错误

只有 `complete: true` 时才按所请求模式说明检查完成，类型检查和 lint 的通过不能替代功能测试
