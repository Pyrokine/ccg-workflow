# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.6.0] - 2026-01-07

### ♻️ 重构

**统一使用 ace-tool MCP**：移除 auggie MCP 动态替换逻辑，简化提示词系统。

#### 主要变更

1. **移除动态替换**
   - 所有模板文件硬编码使用 `mcp__ace-tool__search_context` 和 `mcp__ace-tool__enhance_prompt`
   - 移除 `installer.ts` 中的 MCP 工具名动态注入逻辑（保留模型路由注入）
   - 简化配置流程，减少用户困惑

2. **更新模板文件**（15 个）
   - 核心工作流：`dev.md`, `enhance.md`
   - 多模型协作：`analyze.md`, `debug.md`, `think.md`, `optimize.md`, `frontend.md`, `backend.md`
   - 代码生成与审查：`code.md`, `bugfix.md`, `review.md`, `test.md`
   - 功能开发：`feat.md`
   - 子智能体：`agents/planner.md`, `agents/ui-ux-designer.md`

3. **参数规范统一**
   - `search_context`: `project_root_path` (必需), `query` (必需)
   - `enhance_prompt`: `prompt` (必需), `conversation_history` (可选), `project_root_path` (可选)

4. **更新核心指令**
   - 更新 `memorys/CLAUDE.md` 中的 MCP 工具调用说明
   - 明确参数要求和使用规范

#### 优势

- ✅ **简洁**：移除双 MCP 支持，减少 50% 配置复杂度
- ✅ **统一**：所有命令使用相同的 MCP 工具，一致性更好
- ✅ **清晰**：参数说明更明确，减少混淆
- ✅ **易维护**：不再需要维护两套 MCP 配置

#### 升级说明

- 已安装用户：重新运行 `npx ccg init` 更新模板文件
- 新用户：直接安装即可，默认使用 ace-tool

---

## [1.4.4] - 2026-01-06

### 🐛 修复

**Windows 多用户路径问题**：彻底解决 Windows 下不同用户无法读取配置文件的问题。

#### 问题描述

在 Windows 多用户环境中，当 Administrator 运行 `npx ccg init` 后，普通用户（如 `li`、`yao`）无法使用命令：

```
Administrator 安装:
  C:\Users\USER\.claude\.ccg\config.toml
  模板中硬编码: ROLE_FILE: ~/.claude/.ccg/prompts/codex/analyzer.md

用户 li 运行命令:
  homedir() 解析到: C:\Users\USER
  尝试读取: C:\Users\USER\.claude\.ccg\prompts\codex\analyzer.md
  结果: 文件不存在 ❌
```

#### 解决方案

**安装时固化绝对路径**：安装时将模板中的 `~` 路径替换为当前用户的绝对路径。

修改前（模板）：
```markdown
ROLE_FILE: ~/.claude/.ccg/prompts/codex/analyzer.md
```

修改后（用户 li 安装后）：
```markdown
ROLE_FILE: C:\Users\USER\.claude\.ccg\prompts\codex\analyzer.md
```

#### 修改文件

- `src/utils/installer.ts`:
  - 新增 `replaceHomePathsInTemplate()` 函数
  - 修改 `installWorkflows()` - 命令模板、agents、prompts、shared-config 安装时替换路径
  - 将 `fs.copy()` 改为 `fs.readFile()` + 路径替换 + `fs.writeFile()`

#### 影响范围

- ✅ 命令模板 (`templates/commands/*.md`)
- ✅ Agent 文件 (`templates/commands/agents/*.md`)
- ✅ Prompt 文件 (`templates/prompts/**/*.md`)
- ✅ 共享配置 (`templates/config/shared-config.md`)

#### 使用说明

每个 Windows 用户需要独立运行安装：

```bash
# 用户 Administrator
C:\Users\USER> npx ccg init

# 用户 li
C:\Users\USER> npx ccg init

# 用户 yao
C:\Users\USER> npx ccg init
```

每个用户将拥有独立的配置和路径，互不干扰。

---

## [1.4.2] - 2026-01-06

### ✨ 新特性

**Windows MCP 配置自动修复**：从 ZCF 项目移植跨平台 MCP 配置逻辑，彻底解决 Windows 用户 MCP 安装问题。

#### 新增功能

1. **自动 Windows 命令包装**：
   - Windows 环境下 `npx`/`uvx` 命令自动包装为 `cmd /c` 格式
   - 用户无需手动设置环境变量或修改配置
   - 安装时自动应用，无需额外操作

2. **MCP 配置自动备份**：
   - 修改 `~/.claude.json` 前自动备份到 `~/.claude/backup/`
   - 时间戳命名，支持回滚恢复

3. **新增诊断工具**：
   ```bash
   # 诊断 MCP 配置问题
   npx ccg diagnose-mcp

   # 修复 Windows MCP 配置（Windows 用户）
   npx ccg fix-mcp
   ```

#### 新增文件

- `src/utils/platform.ts` - 跨平台检测和命令包装工具
- `src/utils/mcp.ts` - MCP 配置管理和自动修复逻辑
- `src/commands/diagnose-mcp.ts` - MCP 诊断和修复命令

#### 优化内容

- `installAceTool()` - 使用新的 `buildMcpServerConfig()` 和 `fixWindowsMcpConfig()`
- `uninstallAceTool()` - 添加自动备份功能
- 所有 MCP 配置操作现在都支持自动备份和 Windows 兼容性

#### 技术细节

**Windows 命令包装示例**：
```json
// Before (不工作)
{
  "mcpServers": {
    "ace-tool": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ace-tool@latest"]
    }
  }
}

// After (自动修复)
{
  "mcpServers": {
    "ace-tool": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "ace-tool@latest"]
    }
  }
}
```

#### 升级说明

已安装 v1.4.1 的用户：
1. 运行 `npx ccg-workflow@latest init` 更新
2. Windows 用户可运行 `npx ccg fix-mcp` 修复现有配置
3. 所有用户可运行 `npx ccg diagnose-mcp` 验证配置

---

## [1.4.1] - 2026-01-06

### 🐛 Bug Fixes

**修复命令模板中的路径引用**：v1.4.0 迁移了目录结构，但命令模板中的路径引用未同步更新。

#### 修复内容

1. **提示词路径**：
   ```bash
   旧引用：ROLE_FILE: ~/.claude/prompts/ccg/<model>/<role>.md
   新引用：ROLE_FILE: ~/.claude/.ccg/prompts/<model>/<role>.md
   ```

2. **配置文件路径**：
   ```bash
   旧引用：~/.ccg/config.toml
   新引用：~/.claude/.ccg/config.toml
   ```

#### 影响范围

已修复 13 个文件中的路径引用：
- `templates/commands/*.md` (12 个命令)
- `templates/config/shared-config.md` (共享配置)

#### 升级说明

如果你已经安装了 v1.4.0，请重新运行安装命令更新模板：
```bash
npx ccg-workflow@latest init
```

---

## [1.4.0] - 2026-01-06 ⚡ BREAKING CHANGES

### 🏗️ 目录结构重构

**重大变更**：统一配置目录到 `~/.claude/.ccg/`，提升组织性和减少目录污染。

#### 变更详情

**变更 1：配置目录迁移**
```
旧版本：~/.ccg/
新版本：~/.claude/.ccg/
```

**变更 2：Prompts 目录迁移**
```
旧版本：~/.claude/prompts/ccg/
新版本：~/.claude/.ccg/prompts/
```

**变更 3：共享配置文件**
```
旧版本：~/.claude/commands/ccg/_config.md  (会被 CC 误识别为命令)
新版本：~/.claude/.ccg/shared-config.md     (不会被 CC 扫描)
```

#### 最终目录结构

```
~/.claude/
├── commands/ccg/           # ✅ CC 读取的 slash commands
│   ├── dev.md
│   ├── code.md
│   └── ...
├── agents/ccg/             # ✅ CC 读取的 subagents
│   ├── planner.md
│   └── ...
├── bin/                    # ✅ 二进制文件
│   └── codeagent-wrapper
└── .ccg/                   # ✅ CCG 配置目录（CC 不读取）
    ├── config.toml         # 主配置文件
    ├── shared-config.md    # 共享配置
    ├── backup/             # 备份目录
    └── prompts/            # 专家提示词
        ├── codex/
        ├── gemini/
        └── claude/
```

#### 自动迁移

✨ **无需手动操作**！运行 `npx ccg-workflow@latest init` 会自动：
1. 检测旧版本配置
2. 迁移所有文件到新位置
3. 清理旧文件（安全检查后）
4. 显示迁移报告

示例输出：
```
ℹ Migration completed:
  ✓ ~/.ccg/config.toml → ~/.claude/.ccg/config.toml
  ✓ ~/.claude/prompts/ccg/ → ~/.claude/.ccg/prompts/
  ✓ ~/.claude/commands/ccg/_config.md → ~/.claude/.ccg/shared-config.md
  ✓ Removed old ~/.ccg/ directory
  ○ Skipped: ~/.claude/prompts/ccg/ (already exists in new location)
```

#### 手动升级

如果你有自定义配置，建议手动迁移：

```bash
# 1. 备份配置
cp -r ~/.ccg ~/.ccg.backup
cp -r ~/.claude/prompts/ccg ~/.claude/prompts/ccg.backup

# 2. 运行升级
npx ccg-workflow@latest init

# 3. 验证配置
cat ~/.claude/.ccg/config.toml
ls -la ~/.claude/.ccg/prompts/
```

#### 不兼容性说明

| 影响项 | 描述 | 解决方案 |
|--------|------|----------|
| **配置路径硬编码** | 如果你的脚本硬编码了 `~/.ccg/` 路径 | 改为 `~/.claude/.ccg/` |
| **Prompts 引用** | 如果你的命令引用了 `~/.claude/prompts/ccg/` | 改为 `~/.claude/.ccg/prompts/` |
| **_config.md** | 旧的 `_config.md` 已重命名 | 改为 `shared-config.md` |

#### 修改位置

- `src/utils/config.ts` - 配置路径定义
- `src/utils/installer.ts` - 安装路径逻辑
- `src/utils/migration.ts` - 自动迁移脚本（新增）
- `src/commands/init.ts` - 集成迁移逻辑
- `templates/` - 目录结构重组

#### 优势

- ✅ **更清晰**：所有 CCG 配置集中在 `~/.claude/.ccg/`
- ✅ **减少污染**：不再占用 `~/.claude/` 顶层空间
- ✅ **避免混淆**：`_config.md` 不会被 CC 误识别为命令
- ✅ **符合规范**：遵循社区最佳实践（参考 ccline）

---

## [1.3.7] - 2026-01-06 🐛

### 修复 1：ace-tool MCP 配置兼容性问题

#### 问题描述
- 用户反馈 ace-tool MCP "安装不上去"
- 代码准备了参数数组（`--base-url`, `--token`）但实际写入配置时未使用
- 使用环境变量模式（`env: { ACE_BASE_URL, ACE_TOKEN }`）可能不被 ace-tool 支持

#### 修复方案

**修改位置**：`src/utils/installer.ts:567-630`

**旧代码**（环境变量模式）：
```typescript
existingConfig.mcpServers['ace-tool'] = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'ace-tool@latest'],  // 硬编码，未使用准备的 args
  env: {
    ACE_BASE_URL: baseUrl || 'https://api.augmentcode.com',
    ACE_TOKEN: token || '',
  },
}
```

**新代码**（参数传递模式）：
```typescript
existingConfig.mcpServers['ace-tool'] = {
  type: 'stdio',
  command: 'npx',
  args,  // 使用动态构建的 args 数组（包含 --base-url 和 --token）
}
```

#### 生成的配置格式
```json
{
  "mcpServers": {
    "ace-tool": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "ace-tool@latest",
        "--base-url", "https://api.augmentcode.com",
        "--token", "YOUR_TOKEN"
      ]
    }
  }
}
```

#### 修复效果
- ✅ **兼容性更好**：参数传递模式不依赖 ace-tool 的环境变量支持
- ✅ **符合预期**：使用之前准备的 `args` 数组，避免重复代码
- ✅ **用户验证**：符合社区用户反馈的正确配置格式
- ✅ **包含必需字段**：`type: "stdio"` + `-y` 标志 + `@latest` 版本

### 修复 2：Subagents 安装路径修正

#### 问题描述
- Subagents 被安装到 `~/.claude/commands/ccg/agents/`（错误路径）
- Claude Code 无法识别，因为 subagents 应该在 `~/.claude/agents/ccg/`

#### 修复方案

**修改位置**：
- `src/utils/installer.ts:318-320` - 修改安装目标路径
- `config.json:19-23` - 添加 agents 安装配置（Python 安装器）

**旧代码**：
```typescript
const agentsDestDir = join(commandsDir, 'agents')
```

**新代码**：
```typescript
const agentsDestDir = join(installDir, 'agents', 'ccg')
```

#### 修复效果
- ✅ **正确识别**：Subagents 安装到 `~/.claude/agents/ccg/`，Claude Code 可以识别
- ✅ **符合规范**：遵循 Claude Code 的 agents 目录结构
- ✅ **不影响命令**：Slash commands 仍在 `~/.claude/commands/ccg/`

#### 影响范围
- **所有平台**：通过 `npx ccg-workflow init` 或 `python3 install.py` 安装的用户
- **Subagents**：planner, ui-ux-designer, init-architect, get-current-datetime
- **向下兼容**：旧路径的 agents 不会被自动清理，需要手动删除

---

## [1.3.3] - 2026-01-05 🔒

### 安全修复：Windows PATH 配置方法

#### 问题描述
- Windows 安装时使用 `setx` 命令配置 PATH 存在 **1024 字符限制**
- 如果用户 PATH 已经很长，使用 `setx PATH "%PATH%;新路径"` 会导致：
  - PATH 被截断到 1024 字符
  - 超出部分的路径丢失
  - 可能破坏现有系统配置

#### 修复方案

**修改位置**：`src/commands/init.ts:281-299`

**旧代码**（有风险）：
```typescript
console.log(ansis.gray(`     [System.Environment]::SetEnvironmentVariable('PATH', "$env:PATH;${result.binPath.replace(/\//g, '\\')}", 'User')`))
```

**新代码**（安全追加）：
```typescript
const windowsPath = result.binPath.replace(/\//g, '\\')
console.log(ansis.gray(`     $currentPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')`))
console.log(ansis.gray(`     $newPath = '${windowsPath}'`))
console.log(ansis.gray(`     if ($currentPath -notlike "*$newPath*") {`))
console.log(ansis.gray(`         [System.Environment]::SetEnvironmentVariable('PATH', "$currentPath;$newPath", 'User')`))
console.log(ansis.gray(`     }`))
```

#### 新方法优势
- ✅ **无字符限制**：PowerShell `SetEnvironmentVariable` 支持最大 32767 字符
- ✅ **安全追加**：先读取当前 PATH，再追加新路径
- ✅ **重复检测**：使用 `-notlike` 判断路径是否已存在，避免重复添加
- ✅ **向下兼容**：不影响 macOS/Linux 自动配置逻辑
- ✅ **不影响旧版**：仅影响新安装用户，不破坏现有配置

#### 影响范围
- **仅 Windows 用户**：修改仅影响 Windows 平台的 PATH 配置提示
- **macOS/Linux**：继续使用自动写入 `.zshrc`/`.bashrc` 的方式（无影响）
- **旧版 install.py**：Python 脚本中的 `setx` 提示保持不变（已弃用）

---

## [1.3.2] - 2026-01-05 🐛

### 关键 Bug 修复：MCP 配置缺失

#### 问题描述
- 安装后 `~/.ccg/config.toml` 缺少 `[mcp]` 配置部分
- TypeScript 类型定义 `CcgConfig` 未包含 `mcp` 字段
- `createDefaultConfig` 函数未生成 MCP 相关配置

#### 修复内容

- **类型定义更新** (`src/types/index.ts`):
  ```typescript
  export interface CcgConfig {
    // ... 其他字段
    mcp: {
      provider: string
      setup_url: string
      tools: {
        code_search_ace: string
        code_search_auggie: string
        prompt_enhance_ace: string
        prompt_enhance_auggie: string
        query_param_ace: string
        query_param_auggie: string
      }
    }
  }
  ```

- **配置生成更新** (`src/utils/config.ts`):
  - `createDefaultConfig` 函数新增 `mcp` 字段生成逻辑
  - 默认配置：`provider = "ace-tool"`
  - 包含完整的工具映射和参数名配置
  - 配置文件版本号从 `1.0.0` 升级到 `1.3.2`

- **生成的配置结构**:
  ```toml
  [general]
  version = "1.3.2"

  [mcp]
  provider = "ace-tool"
  setup_url = "https://linux.do/t/topic/284963"

  [mcp.tools]
  code_search_ace = "mcp__ace-tool__search_context"
  code_search_auggie = "mcp__auggie-mcp__codebase-retrieval"
  prompt_enhance_ace = "mcp__ace-tool__enhance_prompt"
  prompt_enhance_auggie = ""
  query_param_ace = "query"
  query_param_auggie = "information_request"
  ```

#### 影响
- 修复后，所有新安装都会自动生成完整的 MCP 配置
- 命令模板（如 `/ccg:dev`, `/ccg:enhance`）可以正确读取 MCP 工具映射
- 用户无需手动编辑配置文件即可使用 MCP 功能

---

## [1.3.1] - 2026-01-05

### 命令模板修正

- **说明修正**：澄清 auggie 也支持 Prompt 增强功能（需按教程配置）
- **模板更新**：修正 `/ccg:dev` 和 `/ccg:enhance` 命令的提示信息
  - 从"auggie 不支持"改为"未配置 Prompt 增强功能"
  - 提供配置教程链接
- **配置注释**：更新 `prompt_enhance_auggie = ""` 的说明

---

## [1.3.0] - 2026-01-05 ⭐

### 重大更新：MCP 动态选择系统

#### 核心特性

- **多 MCP 支持**：安装时可选择 ace-tool（第三方封装）或 auggie（官方原版）
- **交互式选择**：安装脚本提供友好的 MCP 选择界面，显示各选项的功能对比
- **配置文件驱动**：生成 `~/.ccg/config.toml` 记录 MCP 选择，命令模板动态适配
- **完全兼容**：命令模板根据配置自动使用正确的 MCP 工具名称
- **简洁高效**：命令模板引用共享配置，避免重复说明

#### 技术实现

- **install.py 更新**：
  - 新增 `choose_mcp_provider()` 函数：交互式选择界面
  - 新增 `install_auggie()` 函数：安装 auggie MCP (`@augmentcode/auggie@prerelease`)
  - 新增 `create_ccg_config()` 函数：生成配置文件 `~/.ccg/config.toml`
  - 修改 `execute_operation()`：支持 `"install_mcp"` 操作类型，动态路由到不同的安装函数

- **配置文件结构** (`~/.ccg/config.toml`)：
  ```toml
  [mcp]
  provider = "ace-tool"  # ace-tool | auggie | none

  [mcp.ace-tool]
  tools = ["enhance_prompt", "search_context"]

  [mcp.auggie]
  tools = ["codebase-retrieval"]
  note = "auggie 不包含 Prompt 增强工具，需手动配置"

  [routing]
  mode = "smart"
  # ... 模型路由配置
  ```

- **命令模板更新**（11个命令文件）：
  - 所有命令模板统一引用 `memorys/MCP_USAGE.md` 获取 MCP 调用规范
  - 移除重复的 MCP 工具调用说明，减少 50% 的提示词长度
  - 命令模板只需引用配置文件 `~/.ccg/config.toml` 中的工具映射表
  - 支持文件：`dev.md`, `enhance.md`, `code.md`, `debug.md`, `bugfix.md`, `test.md`, `think.md`, `optimize.md`, `analyze.md`, `backend.md`, `frontend.md`, `review.md`

- **工具映射对照**：
  | 功能 | ace-tool | auggie |
  |------|----------|--------|
  | Prompt 增强 | `mcp__ace-tool__enhance_prompt` | ❌ 不支持 |
  | 代码检索 | `mcp__ace-tool__search_context` | `mcp__auggie-mcp__codebase-retrieval` |

#### 用户体验

- **安装流程**：
  1. 运行 `python3 install.py` 或 `npx ccg-workflow`
  2. 看到 MCP 选择菜单，对比功能后选择
  3. 自动安装并配置对应的 MCP 工具
  4. 生成配置文件，记录选择

- **使用体验**：
  - 命令模板自动读取配置，无需手动修改
  - ace-tool 用户：完整功能（Prompt 增强 + 代码检索）
  - auggie 用户：代码检索功能，提示查看配置教程链接
  - 配置教程：https://linux.do/t/topic/1280612

#### 文档更新

- `README.md`：更新"首次安装"部分，说明 MCP 选择步骤
- `CLAUDE.md`：新增"MCP 工具选择"章节，详细说明两种 MCP 的区别
- `memorys/MCP_USAGE.md`：创建共享的 MCP 调用规范文档，所有命令引用
- `MCP_SELECTION_GUIDE.md`：创建工具映射指南，供开发者参考

#### 优化亮点

- **简洁性**：命令模板从平均 150 行减少到 80 行
- **可维护性**：MCP 调用逻辑统一管理，修改一处即可
- **可扩展性**：未来添加新 MCP 只需更新配置文件和 `MCP_USAGE.md`

---

## [1.2.3] - 2026-01-05

### 新增

- **二进制安装验证**：安装后自动验证 `codeagent-wrapper` 可用性
  - 在 `installCodeagentWrapper()` 中新增验证步骤
  - 执行 `codeagent-wrapper --version` 验证二进制文件正常运行
  - 显示版本信息确认安装成功

### 优化

- **错误显示**：安装失败时显示详细错误信息
  - 捕获并显示具体的错误消息
  - 提供友好的错误提示和解决建议
- **文档清理**：删除 `dev.md` 中的过时提示

---

## [1.2.2] - 2026-01-05

### 优化

- 删除重复的根目录提示词文件（`prompts/`）
- 只保留 `templates/prompts/` 作为安装模板源
- 从 `package.json` 的 `files` 字段移除 `"prompts"`
- npm 包减少 18 个文件（75 → 57 files）

---

## [1.2.1] - 2026-01-05

### 修复

- 确保 `~/.ccg/config.toml` 配置文件在安装失败时也能创建
- 将 `writeCcgConfig()` 调整到 `installWorkflows()` 之前执行
- 修复首次 `init` 时配置文件可能不存在的问题

---

## [1.2.0] - 2026-01-05 ⭐

### 重大更新：ROLE_FILE 动态注入

#### 核心特性

- **真正的动态注入**：`codeagent-wrapper` 自动识别 `ROLE_FILE:` 指令
- **0 token 消耗**：Claude 无需先用 Read 工具读取提示词文件
- **自动化管理**：一行 `ROLE_FILE:` 搞定，无需手动粘贴

#### 技术实现

在 `codeagent-wrapper/utils.go` 中新增 `injectRoleFile()` 函数：
- 使用正则 `^ROLE_FILE:\s*(.+)` 匹配指令
- 自动展开 `~/` 为用户 HOME 目录
- 读取文件内容并原地替换 `ROLE_FILE:` 行
- 完整日志记录注入过程（文件路径、大小）

在 `codeagent-wrapper/main.go` 中集成动态注入：
- Explicit stdin 模式支持
- Piped task 模式支持
- Parallel 模式支持（所有任务）

#### 更新内容

- 重新编译所有平台二进制文件（darwin-amd64, darwin-arm64, linux-amd64, windows-amd64）
- 更新所有命令模板，使用 `ROLE_FILE:` 替代手动读取

#### 使用示例

```bash
# 旧方式（已弃用）
⏺ Read(~/.claude/prompts/ccg/codex/reviewer.md)
codeagent-wrapper --backend codex - <<'EOF'
# 手动粘贴提示词内容...
<TASK>...</TASK>
EOF

# 新方式（v1.2.0）
codeagent-wrapper --backend codex - <<'EOF'
ROLE_FILE: ~/.claude/prompts/ccg/codex/reviewer.md

<TASK>审查代码...</TASK>
EOF
```

---

## [1.1.3] - 2026-01-05

### 新增功能

- **PATH 自动配置**：安装后自动配置 `codeagent-wrapper` 可执行路径
  - **Mac/Linux**：交互式提示，自动添加到 `.zshrc` 或 `.bashrc`
  - **Windows**：提供详细手动配置指南 + PowerShell 一键命令
  - 智能检测重复配置，避免多次添加

### 用户体验

- 安装完成后询问是否自动配置 PATH（Mac/Linux）
- 自动检测 shell 类型（zsh/bash）
- 检查是否已配置，避免重复添加
- Windows 用户获得分步操作指南

### 国际化

- 新增 11 个 i18n 翻译键（中文/英文）
- 优化提示信息的可读性

---

## [1.1.2] - 2026-01-05

### 新增功能

- **codeagent-wrapper 自动安装**：安装时自动复制二进制文件到 `~/.claude/bin/`
  - 跨平台支持：darwin-amd64, darwin-arm64, linux-amd64, windows-amd64
  - 自动设置可执行权限（Unix 系统）
  - 显示安装路径和配置说明

### 技术实现

- 修改 `src/types/index.ts` 添加 `binPath` 和 `binInstalled` 字段
- 修改 `src/utils/installer.ts` 实现平台检测和二进制安装逻辑
- 修改 `src/commands/init.ts` 显示 PATH 配置说明

### 用户体验

- 安装后显示 PATH 配置指令
- 提供友好的配置提示
- 新增 i18n 翻译

---

## [1.1.1] - 2026-01-05

### 文档更新

- 更新 README 添加智能更新功能详细说明
- 新增"更新到最新版本"独立章节
- 优化交互式菜单说明，分离首次安装和更新流程
- 在"最新更新"部分新增 v1.1.0 智能更新系统介绍

---

## [1.1.0] - 2026-01-05

### 新增功能

- **智能更新系统**：一键更新命令模板和提示词，无需卸载重装
  - 自动检测 npm 最新版本并对比当前版本
  - 增量更新，仅更新命令和提示词文件
  - 保留用户配置（`~/.ccg/config.toml`）
  - 支持强制重装，修复损坏的文件
  - 无需 sudo 权限

### 核心实现

- 新增 `src/utils/version.ts` - 版本管理工具
  - `getCurrentVersion()` - 获取当前安装版本
  - `getLatestVersion()` - 查询 npm 最新版本
  - `compareVersions()` - 语义化版本对比
  - `checkForUpdates()` - 检查是否有可用更新

- 新增 `src/commands/update.ts` - 更新命令实现
  - 交互式更新流程
  - 版本检测和对比
  - 强制重装选项

- 更新 `src/commands/menu.ts` - 菜单集成
  - 新增"更新工作流"选项
  - 移除复杂的备份管理功能

### 用户体验

- 运行 `npx ccg-workflow` 选择"更新工作流"即可更新
- 显示当前版本 vs 最新版本对比
- 自动更新所有文件并保留配置
- 提供友好的进度提示和错误处理

---

## [1.0.6] - 2026-01-05

### 修复

- 修复命令模板中的 MCP 工具参数缺失问题
- 在所有命令模板中添加 `mcp__ace-tool__search_context` 完整参数说明
- 在 enhance/dev 模板中添加 `mcp__ace-tool__enhance_prompt` 参数说明
- 更新 `_config.md` 中的提示词路径引用

---

## [1.0.5] - 2026-01-05

### 修复

- 修复安装时复制 CLAUDE.md 到用户目录的问题
- 斜杠命令已自包含完整工作流指令
- 避免覆盖用户已有的 `~/.claude/CLAUDE.md` 配置

---

## [1.0.4] - 2026-01-05

### 新增

- 补充 init-project 命令所需的两个 subagent
  - `init-architect.md` - 架构师子智能体
  - `planner.md` - 任务规划师

---

## [1.0.3] - 2026-01-05

### 新增

- 为所有多模型命令添加 codeagent-wrapper 调用示例
- 优化命令模板，明确使用方式

---

## [1.0.2] - 2026-01-05

### 优化

- 优化 token 消耗，改用子进程读取角色提示词文件
- 减少内存占用

---

## [1.0.1] - 2026-01-05

### 修复

- 修复命令模板调用方式
- 明确使用 codeagent-wrapper 的标准语法

---

## [1.0.0] - 2026-01-05

### 重大更新：npm 首次发布

#### 安装方式革命性升级

- ✅ 从 Python 脚本重构为 **TypeScript + unbuild** 构建系统
- ✅ 发布到 npm: `npx ccg-workflow` 一键安装
- ✅ 交互式配置菜单（初始化/卸载）
- ✅ 更好的跨平台兼容性

#### 三模型协作时代

- ✅ 从双模型 (Codex + Gemini) 扩展到 **三模型 (Claude + Codex + Gemini)**
- ✅ 新增 6 个 Claude 角色提示词（architect, analyzer, debugger, optimizer, reviewer, tester）
- ✅ 专家提示词从 12 个扩展到 **18 个**

#### 配置系统升级

- ✅ 配置文件从 `config.json` 迁移到 `~/.ccg/config.toml`
- ✅ 支持 **smart/parallel/sequential** 三种协作模式
- ✅ 可配置前端/后端模型优先级

#### 核心功能

**开发工作流（12个命令）**
- `/ccg:dev` - 完整6阶段三模型工作流
- `/ccg:code` - 三模型代码生成（智能路由）
- `/ccg:debug` - UltraThink 三模型调试
- `/ccg:test` - 三模型测试生成
- `/ccg:bugfix` - 质量门控修复（90%+ 通过）
- `/ccg:think` - 深度分析
- `/ccg:optimize` - 性能优化
- `/ccg:frontend` - 前端任务 → Gemini
- `/ccg:backend` - 后端任务 → Codex
- `/ccg:review` - 三模型代码审查
- `/ccg:analyze` - 三模型技术分析
- `/ccg:enhance` - Prompt 增强（ace-tool MCP）

**智能规划（2个命令）**
- `/ccg:scan` - 智能仓库扫描
- `/ccg:feat` - 智能功能开发

**Git 工具（4个命令）**
- `/ccg:commit` - 智能 commit（支持 emoji）
- `/ccg:rollback` - 交互式回滚
- `/ccg:clean-branches` - 清理已合并分支
- `/ccg:worktree` - Worktree 管理

**项目初始化（1个命令）**
- `/ccg:init` - 初始化项目 AI 上下文

#### 专家提示词系统

**18个角色文件**，动态角色注入：
- **Codex 角色**（6个）：architect, analyzer, debugger, tester, reviewer, optimizer
- **Gemini 角色**（6个）：frontend, analyzer, debugger, tester, reviewer, optimizer
- **Claude 角色**（6个）：architect, analyzer, debugger, tester, reviewer, optimizer

#### 技术栈

- **构建工具**: unbuild
- **编程语言**: TypeScript
- **CLI 框架**: cac
- **交互界面**: inquirer
- **配置格式**: TOML
- **国际化**: i18next

#### 依赖项

```json
{
  "ansis": "^4.1.0",
  "cac": "^6.7.14",
  "fs-extra": "^11.3.2",
  "i18next": "^25.5.2",
  "inquirer": "^12.9.6",
  "ora": "^9.0.0",
  "pathe": "^2.0.3",
  "smol-toml": "^1.4.2"
}
```

---

## [Pre-1.0.0] - Python 版本

### Python 安装脚本时代（已弃用）

使用 `python3 install.py` 进行安装，支持双模型协作（Codex + Gemini）。

**主要限制**：
- 需要手动 clone 仓库
- Python 环境依赖
- 配置不够灵活
- 更新需要重新安装

---

## 链接

- [GitHub Repository](https://github.com/fengshao1227/ccg-workflow)
- [npm Package](https://www.npmjs.com/package/ccg-workflow)
- [README](https://github.com/fengshao1227/ccg-workflow/blob/main/README.md)
