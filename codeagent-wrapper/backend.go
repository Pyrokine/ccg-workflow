package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Backend defines the contract for invoking different AI CLI backends.
// Each backend is responsible for supplying the executable command and
// building the argument list based on the wrapper config.
type Backend interface {
	Name() string
	BuildArgs(cfg *Config, targetArg string) []string
	Command() string
}

type CodexBackend struct{}

func (CodexBackend) Name() string { return "codex" }
func (CodexBackend) Command() string {
	return "codex"
}
func (CodexBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildCodexArgs(cfg, targetArg)
}

type ClaudeBackend struct{}

func (ClaudeBackend) Name() string { return "claude" }
func (ClaudeBackend) Command() string {
	return "claude"
}
func (ClaudeBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildClaudeArgs(cfg, targetArg)
}

const maxClaudeSettingsBytes = 1 << 20 // 1MB

// loadMinimalEnvSettings 从 ~/.claude/settings.json 只提取 env 配置
// 只接受字符串类型的值, 文件缺失/解析失败/超限都返回空
func loadMinimalEnvSettings() map[string]string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}

	settingPath := filepath.Join(home, ".claude", "settings.json")
	info, err := os.Stat(settingPath)
	if err != nil || info.Size() > maxClaudeSettingsBytes {
		return nil
	}

	data, err := os.ReadFile(settingPath)
	if err != nil {
		return nil
	}

	var cfg struct {
		Env map[string]any `json:"env"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	if len(cfg.Env) == 0 {
		return nil
	}

	env := make(map[string]string, len(cfg.Env))
	for k, v := range cfg.Env {
		s, ok := v.(string)
		if !ok {
			continue
		}
		env[k] = s
	}
	if len(env) == 0 {
		return nil
	}
	return env
}

type routingProxyConfig struct {
	models map[string]struct{}
	http   string
	https  string
}

func defaultRoutingProxyConfig() routingProxyConfig {
	return routingProxyConfig{models: map[string]struct{}{}}
}

func parseTomlStringValue(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, `"`)
	return value
}

func parseTomlStringArray(value string) []string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "[")
	value = strings.TrimSuffix(value, "]")
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		item := strings.ToLower(parseTomlStringValue(part))
		if item != "" {
			items = append(items, item)
		}
	}
	return items
}

func loadRoutingProxyConfig() routingProxyConfig {
	cfg := defaultRoutingProxyConfig()
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return cfg
	}
	path := filepath.Join(home, ".claude", ".ccg", "config.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	inSection := false
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inSection = line == "[routing.proxy]"
			continue
		}
		if !inSection {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "models":
			models := parseTomlStringArray(value)
			if len(models) > 0 {
				cfg.models = make(map[string]struct{}, len(models))
				for _, model := range models {
					if model == "agy" {
						model = "antigravity"
					}
					if model == "antigravity" {
						cfg.models[model] = struct{}{}
					}
				}
			}
		case "http":
			cfg.http = parseTomlStringValue(value)
		case "https":
			cfg.https = parseTomlStringValue(value)
		}
	}
	if cfg.http != "" && cfg.https == "" {
		cfg.https = cfg.http
	}
	return cfg
}

func loadModelProxyEnv(backend string) map[string]string {
	backend = strings.ToLower(strings.TrimSpace(backend))
	if backend == "agy" {
		backend = "antigravity"
	}
	if backend == "" {
		return nil
	}
	cfg := loadRoutingProxyConfig()
	if cfg.http == "" {
		return nil
	}
	if _, ok := cfg.models[backend]; !ok {
		return nil
	}
	env := map[string]string{
		"http_proxy":  cfg.http,
		"https_proxy": cfg.https,
		"HTTP_PROXY":  cfg.http,
		"HTTPS_PROXY": cfg.https,
	}
	return env
}

func buildClaudeArgs(cfg *Config, targetArg string) []string {
	if cfg == nil {
		return nil
	}
	args := []string{"-p", "--dangerously-skip-permissions"}

	// Prevent infinite recursion: disable all setting sources (user, project, local)
	// This ensures a clean execution environment without CLAUDE.md or skills that would trigger codeagent
	args = append(args, "--setting-sources", "")

	if cfg.NoSessionPersistence {
		args = append(args, "--no-session-persistence")
	}
	if model := strings.TrimSpace(cfg.ClaudeModel); model != "" {
		args = append(args, "--model", model)
	}
	if effort := strings.TrimSpace(cfg.ClaudeEffort); effort != "" {
		args = append(args, "--effort", effort)
	}
	if cfg.Mode == "resume" && cfg.SessionID != "" {
		// Claude CLI uses -r <session_id> for resume.
		args = append(args, "-r", cfg.SessionID)
	}
	// Note: claude CLI doesn't support -C flag; workdir set via cmd.Dir

	args = append(args, "--output-format", "stream-json", "--verbose", targetArg)

	return args
}

type AntigravityBackend struct{}

func (AntigravityBackend) Name() string    { return "antigravity" }
func (AntigravityBackend) Command() string { return "agy" }
func (AntigravityBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildAntigravityArgs(cfg, targetArg)
}

func buildAntigravityArgs(cfg *Config, targetArg string) []string {
	if cfg == nil {
		return nil
	}

	var args []string

	if cfg.SkipPermissions {
		args = append(args, "--dangerously-skip-permissions")
	}

	if cfg.Mode == "resume" && cfg.SessionID != "" {
		args = append(args, "--conversation", cfg.SessionID)
	}

	if cfg.Mode != "resume" && cfg.WorkDir != "" && cfg.WorkDir != "." {
		args = append(args, "--add-dir", cfg.WorkDir)
	}

	// -p must come right before the prompt text (last positional arg)
	args = append(args, "-p", targetArg)
	return args
}

type GrokBackend struct{}

func (GrokBackend) Name() string { return "grok" }

func (GrokBackend) Command() string {
	if _, err := exec.LookPath("grok"); err == nil {
		return "grok"
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "grok"
	}
	fallback := filepath.Join(home, ".grok", "bin", "grok")
	if isWindows() {
		fallback += ".exe"
	}
	if _, err := os.Stat(fallback); err == nil {
		return fallback
	}
	return "grok"
}

func (GrokBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildGrokArgs(cfg, targetArg)
}

func buildGrokArgs(cfg *Config, targetArg string) []string {
	if cfg == nil {
		return nil
	}

	args := []string{"--always-approve", "--output-format", "streaming-json"}
	if model := strings.TrimSpace(cfg.GrokModel); model != "" {
		args = append(args, "-m", model)
	}
	if cfg.Mode == "resume" && cfg.SessionID != "" {
		args = append(args, "-r", cfg.SessionID)
	}
	return append(args, "-p", targetArg)
}

type KimiBackend struct{}

func (KimiBackend) Name() string    { return "kimi" }
func (KimiBackend) Command() string { return "kimi" }

func (KimiBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildKimiArgs(cfg, targetArg)
}

func buildKimiArgs(cfg *Config, targetArg string) []string {
	if cfg == nil {
		return nil
	}

	args := []string{"--output-format", "stream-json", "--final-message-only"}
	if model := strings.TrimSpace(cfg.KimiModel); model != "" {
		args = append(args, "-m", model)
	}
	if cfg.Mode == "resume" && cfg.SessionID != "" {
		args = append(args, "-S", cfg.SessionID)
	}
	return append(args, "-p", targetArg)
}

type OpencodeBackend struct{}

func (OpencodeBackend) Name() string    { return "opencode" }
func (OpencodeBackend) Command() string { return "opencode" }

func (OpencodeBackend) BuildArgs(cfg *Config, targetArg string) []string {
	return buildOpencodeArgs(cfg, targetArg)
}

func buildOpencodeArgs(cfg *Config, targetArg string) []string {
	if cfg == nil {
		return nil
	}

	args := []string{"run"}
	if model := strings.TrimSpace(cfg.OpencodeModel); model != "" {
		args = append(args, "-m", model)
	}
	if cfg.Mode == "resume" && cfg.SessionID != "" {
		args = append(args, "-s", cfg.SessionID)
	}
	args = append(args, "--format", "json")
	if targetArg != "" && targetArg != "-" {
		args = append(args, targetArg)
	}
	return args
}
