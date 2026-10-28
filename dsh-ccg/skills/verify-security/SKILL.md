---
name: verify-security
description: 安全校验关卡，扫描代码中的危险模式，报告覆盖、严重度和待复核发现，当用户提到安全扫描、漏洞检测、安全审计、代码安全、OWASP、注入检测或敏感信息泄露时使用，在新建模块、安全相关变更和重构完成时自动触发
license: MIT
compatibility: node>=18
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Grep
argument-hint: <扫描路径> [--base ref]
---

# 代码安全校验

## 执行扫描

从项目工作目录调用脚本，脚本路径以本 Skill 的资源目录为准：

```bash
node /path/to/verify-security/scripts/security_scanner.js src --json
node /path/to/verify-security/scripts/security_scanner.js src/main.ts src/components -v
node /path/to/verify-security/scripts/security_scanner.js src --base HEAD~1 --exclude vendor
```

支持单文件、目录和多个目标，目标相对当前工作目录解析，省略目标时扫描当前目录，重叠文件只扫描一次

默认排除 Git 元数据、依赖、虚拟环境、构建和测试目录，包括 `target`、`vendor`、`third_party` 和 `third-party`；`--exclude` 追加目录名称，显式指定的文件仍会检查，`--` 后的参数全部作为路径处理，`--help` 只显示用法

## 检查范围

规则按源码后缀匹配，`.mjs`／`.cjs` 使用 JavaScript 规则，`.mts`／`.cts` 使用 TypeScript 规则；无后缀 Shell 文件按 `sh`、`bash`、`dash`、`ksh` 或 `zsh` 的 shebang 识别，也支持 `/usr/bin/env` 和 `env -S`

Rust 当前检查硬编码凭证、AWS Key、私钥及 `Command::new` 调用命令解释器的模式；Shell 当前检查硬编码凭证、AWS Key、私钥及含变量的 `eval`／`sh -c` 类调用，结果只代表这些模式的检查范围

C／C++ 覆盖 `.c`、`.cc`、`.cpp`、`.cxx`、`.h`、`.hh`、`.hpp` 和 `.hxx`，检查硬编码凭证、动态 `system`／`popen` 调用、`gets` 及字面格式中未限宽的 scanf 字符串转换，过滤注释、普通字符串与原始字符串中的调用示例；规则按单行模式识别，缓冲区容量与输入来源通过调用链复核

发现属于待复核的代码模式，结合调用链判断输入来源、已有校验和最终效果

| 类别 | 检查模式 | 严重度 |
|---|---|---|
| 注入 | 动态 SQL、shell 调用、执行用户输入 | Critical |
| 敏感信息 | 硬编码密码或 token、AWS Key、私钥 | High／Critical |
| XSS | innerHTML、outerHTML、document.write、dangerouslySetInnerHTML | High／Medium |
| 反序列化 | pickle、未限制 Loader 的 yaml.load | High |
| 路径与请求 | 来自输入的文件路径和 URL | High |
| XML | XML 解析模式 | High |
| 弱加密 | MD5、SHA1 | Medium／Low |
| 随机数 | 安全场景中的普通 random 调用 | Medium |
| 断点 | JavaScript debugger、Python breakpoint 和 pdb.set_trace | Low |

普通 `console.log()` 不作为安全问题，控制台输出策略由项目 lint 配置决定；断点规则过滤普通字符串和注释示例，整体扫描仍是模式检查，不执行数据流或语义证明

`context` 区分 `source`、`literal`、`test_code` 和 `test_fixture`，后两项表示测试路径中的执行代码与字符串样本；`review_required` 标记需要核实用途，固定隐私标记、合成凭证和故意构造的 XSS 样本按实际用途复核，分类保留原严重度和退出码

构造 `Path` 或比较 `readlink` 目标本身不作为文件访问，来自输入的 `open`、`Path(...).read_text()` 等文件操作继续报告

复核安全发现时，沿调用链确认真实行为，并在项目已有设计或安全文档中记录威胁、决策、信任边界和接受的限制

## 新增与既有问题

默认对照各目标仓库的 `HEAD`，`--base <ref>` 指定其他比较点；使用相同规则扫描基线 Git blob，按规则、上下文和出现次数比较，支持行号移动与 Git 识别的 rename

发现的 `origin` 为 `new`、`existing` 或 `unclassified`，`origin_counts` 保留各类数量；无 Git 或 HEAD 时继续扫描，报告基线不可用和来源未判定，显式无效基线返回未完成

文本报告优先显示新增发现，既有发现汇总，`-v` 展开全部位置；JSON 保留全量发现，分类不改变严重度，既有 Critical／High 仍然阻断

## 报告与退出码

| 退出码 | 结果 | 处理 |
|---|---|---|
| 0 | 扫描完成，未命中 Critical／High | 继续复核 Medium／Low／Info |
| 1 | 扫描完成，命中 Critical／High | 验证发现，修复范围内的真实问题 |
| 2 | 扫描未完成 | 处理缺失路径、读取失败、不支持的源码、零覆盖或显式基线错误，保留部分结果 |

JSON 保留 `passed`、`files_scanned`、`counts`、`findings`，并提供 `complete`、`requested_paths`、`coverage`、`scan_errors`、`baseline` 和 `origin_counts`

`coverage[].eligible_files` 是候选文件数，`files_scanned` 只统计成功读取并分析的文件；每个目标都必须覆盖受支持源码，未完成时 `complete` 和 `passed` 均为 `false`

报告保留规则、严重度、文件、行号和处理建议，`line_content` 固定为 `[redacted]`，基线比较上下文仅留在本次进程内，不输出源码或凭证内容
