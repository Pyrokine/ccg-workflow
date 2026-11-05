# CCG 使用文档

CCG 为 Claude Code 提供工作流、任务上下文、Skills 和质量检查，默认使用独立 Claude Code Agent，其他模型按明确请求调用

## 从源码安装

准备 Node.js 22.13.0 及后续 22.x，或 Node.js 24.19.0 及以上版本，以及 pnpm，仓库通过 `packageManager` 固定 pnpm 版本

```bash
git clone https://github.com/Pyrokine/ccg-workflow.git
cd ccg-workflow
pnpm install --frozen-lockfile
pnpm build
node bin/ccg.mjs init
```

初始化时选择模型路由、工作流与 Skills，安装到本机 Claude Code

## 检查安装

在源码目录执行：

```bash
node bin/ccg.mjs doctor
```

检查结果包含安装版本、工作流、Hook 文件与注册状态，外部模型通过对应 CLI 调用时，也会检查所需工具

## 更新本地工作流

在现有源码目录更新并构建，再刷新本地安装：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
node bin/ccg.mjs init --force --skip-prompt --skip-mcp
```

非交互更新沿用已保存的路由和安装偏好，`--skip-mcp` 保留现有 MCP 配置

## 使用说明与发布记录

- [中文说明](https://github.com/Pyrokine/ccg-workflow/blob/main/README.zh-CN.md)
- [English README](https://github.com/Pyrokine/ccg-workflow/blob/main/README.md)
- [DeepSeek Harness 插件说明](https://github.com/Pyrokine/ccg-workflow/blob/main/dsh-ccg/README.zh-CN.md)
- [版本发布](https://github.com/Pyrokine/ccg-workflow/releases)
- [更新记录](https://github.com/Pyrokine/ccg-workflow/blob/main/CHANGELOG.md)
- [发布规范](https://github.com/Pyrokine/ccg-workflow/blob/main/RELEASING.md)
