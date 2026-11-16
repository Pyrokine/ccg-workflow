---
name: verify-security
description: 安全校验关卡，扫描代码中的危险模式，报告覆盖、严重度和待复核发现，当用户提到安全扫描、漏洞检测、安全审计、代码安全、OWASP、注入检测或敏感信息泄露时使用，在新建模块、安全相关变更和重构完成时自动触发
license: MIT
compatibility: node>=18
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Grep
argument-hint: <扫描路径> [--python-file 文件] [--base ref]
---

# 代码安全校验

## 验收时机与证据复用

按完整功能阶段汇总触发条件，整批实施完成后集中验收，同一候选的多个触发条件合并为一次检查；保留复现问题或确认中间行为所需的定向检查

候选、输入、工具链、参数、配置和覆盖仍适用时复用结果，修复后只复验受影响部分；独立检查继续完成，失败、超时、不可用、不支持和未完成状态分别保留

回到当前源码与调用者确认 finding，在已授权修复范围内连续处理；只读审查交付发现，需要新范围或权限时请求决定，验收条件满足后结束

## 执行扫描

从项目工作目录调用脚本，脚本路径以本 Skill 的资源目录为准：

```bash
node /path/to/verify-security/scripts/security_scanner.js src --json
node /path/to/verify-security/scripts/security_scanner.js src/main.ts src/components -v
node /path/to/verify-security/scripts/security_scanner.js src --base HEAD~1 --exclude vendor
node /path/to/verify-security/scripts/security_scanner.js BUILD_CONFIG src/native.cc --python-file BUILD_CONFIG --json
```

支持单文件、目录和多个目标，目标相对当前工作目录解析，省略目标时扫描当前目录，重叠文件只扫描一次

默认排除 Git 元数据、依赖、虚拟环境、构建和测试目录，包括 `target`、`vendor`、`third_party` 和
`third-party`；`--exclude` 追加目录名称，显式指定的文件仍会检查，`--` 后的参数全部作为路径处理，`--help` 只显示用法

## 检查范围

规则按源码后缀匹配，`.mjs`／`.cjs` 使用 JavaScript 规则，`.mts`／`.cts` 使用 TypeScript 规则；无后缀 Shell 文件按
`sh`、`bash`、`dash`、`ksh` 或 `zsh` 的 shebang 识别，也支持 `/usr/bin/env` 和 `env -S`

`--python-file <文件>` 为直接列入位置目标的一个普通文件启用 Python 安全模式，支持无后缀文件，并可与 C／C++
等其他目标同批扫描；目录、仅包含在父目录目标中的文件、重复参数和缺值均返回未完成

只有指定的精确路径采用 Python 规则，其他文件和默认目录扫描沿用原有类型识别；扫描读取源码及 Git
基线内容，不执行指定文件，构建配置专用语义由项目另行检查

JSON 的 `python_file` 给出选中的绝对路径，未指定时为 `null`；文本报告显示对应模式文件，当前内容及 Git 基线沿用这一选择，包括
rename 前的文件名

Rust 当前检查硬编码凭证、AWS Key、私钥及 `Command::new` 调用命令解释器的模式；Shell 当前检查硬编码凭证、AWS
Key、私钥及含变量的 `eval`／`sh -c` 类调用，结果只代表这些模式的检查范围

Perl 的 `.pl`／`.pm` 和 PowerShell 的 `.ps1` 检查硬编码凭证、AWS Key 与私钥，语言专有命令和数据流分析仍属未覆盖范围

C／C++ 覆盖 `.c`、`.cc`、`.cpp`、`.cxx`、`.h`、`.hh`、`.hpp`、`.hxx`、`.cu`、`.cuh` 和 `.inc`，检查硬编码凭证、动态 `system`／`popen`
调用、`gets`
及字面格式中未限宽的 scanf 字符串转换，过滤注释、普通字符串与原始字符串中的调用示例；规则按单行模式识别，缓冲区容量与输入来源通过调用链复核

JSON 的 `supported_file_types`
和文本报告声明支持类型，目录扫描的完成状态适用于这些类型的模式规则；权限 TOML、SSH 配置及 systemd 单元的语义安全检查仍属未覆盖能力，显式请求时返回
`UNSUPPORTED_TYPE` 和未完成

发现属于待复核的代码模式，结合调用链判断输入来源、已有校验和最终效果

| 类别       | 检查模式                                                      | 严重度         |
| ---------- | ------------------------------------------------------------- | -------------- |
| 注入       | 动态 SQL、shell 调用、执行用户输入                            | Critical       |
| 敏感信息   | 硬编码密码或 token、AWS Key、私钥                             | High／Critical |
| XSS        | innerHTML、outerHTML、document.write、dangerouslySetInnerHTML | High／Medium   |
| 反序列化   | pickle、未限制 Loader 的 yaml.load                            | High           |
| 路径与请求 | 来自输入的文件路径和 URL                                      | High           |
| XML        | XML 解析模式                                                  | High           |
| 弱加密     | MD5、SHA1                                                     | Medium／Low    |
| 随机数     | 安全场景中的普通 random 调用                                  | Medium         |
| 断点       | JavaScript debugger、Python breakpoint 和 pdb.set_trace       | Low            |

普通 `console.log()`
不作为安全问题，控制台输出策略由项目 lint 配置决定；断点规则过滤普通字符串和注释示例，整体扫描仍是模式检查，不执行数据流或语义证明

`context` 区分 `source`、`literal`、`test_code` 和
`test_fixture`，后两项表示测试路径中的执行代码与字符串样本；`review_required`
标记需要核实用途，固定隐私标记、合成凭证和故意构造的 XSS 样本按实际用途复核，分类保留原严重度和退出码

构造 `Path` 或比较 `readlink` 目标本身不作为文件访问，来自输入的 `open`、`Path(...).read_text()` 等文件操作继续报告

Python 源码直接 `import gdb` 后，`gdb.execute` 按 GDB 调试接口处理；SQL 注入规则继续检查同一文件及同一行中的其他动态 SQL
调用，其他安全规则照常检查

复核安全发现时，沿调用链确认真实行为，并在项目已有设计或安全文档中记录威胁、决策、信任边界和接受的限制

## 新增与既有问题

默认对照各目标仓库的 `HEAD`，`--base <ref>` 指定其他比较点；使用相同规则扫描基线 Git
blob，按规则、上下文和出现次数比较，支持行号移动与 Git 识别的 rename

发现的 `origin` 为 `new`、`existing` 或 `unclassified`，`origin_counts`
保留各类数量；无 Git 或 HEAD 时继续扫描，报告基线不可用和来源未判定，显式无效基线返回未完成

文本报告优先显示新增发现，既有发现汇总，`-v`
展开全部位置；JSON 保留全量发现，分类不改变严重度，既有 Critical／High 仍然阻断

## 报告与退出码

| 退出码 | 结果                            | 处理                                                                     |
| ------ | ------------------------------- | ------------------------------------------------------------------------ |
| 0      | 扫描完成，未命中 Critical／High | 继续复核 Medium／Low／Info                                               |
| 1      | 扫描完成，命中 Critical／High   | 验证发现，修复范围内的真实问题                                           |
| 2      | 扫描未完成                      | 处理缺失路径、读取失败、不支持的源码、零覆盖或显式基线错误，保留部分结果 |

JSON 保留 `passed`、`files_scanned`、`counts`、`findings`，并提供
`complete`、`requested_paths`、`coverage`、`scan_errors`、`baseline` 和 `origin_counts`

`scan_path` 保留单个目标路径，多个目标显示为 `N 个目标`；完整清单保存在 `requested_paths`，JSON 优先展示状态、统计和发现

`coverage[].eligible_files` 是候选文件数，`files_scanned`
只统计成功读取并分析的文件；每个目标都必须覆盖受支持源码，未完成时 `complete` 和 `passed` 均为 `false`

报告保留规则、严重度、文件、行号和处理建议，`line_content` 固定为
`[redacted]`，基线比较上下文仅留在本次进程内，不输出源码或凭证内容
