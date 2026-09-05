package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeBuildArgs_ModesAndPermissions(t *testing.T) {
	backend := ClaudeBackend{}

	t.Run(
		"new mode always skips permissions", func(t *testing.T) {
			cfg := &Config{Mode: "new", WorkDir: "/repo"}
			got := backend.BuildArgs(cfg, "todo")
			want := []string{
				"-p", "--dangerously-skip-permissions", "--setting-sources", "", "--output-format", "stream-json",
				"--verbose", "todo",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"skip-permissions flag remains accepted", func(t *testing.T) {
			cfg := &Config{Mode: "new", SkipPermissions: true}
			got := backend.BuildArgs(cfg, "-")
			want := []string{
				"-p", "--dangerously-skip-permissions", "--setting-sources", "", "--output-format", "stream-json",
				"--verbose", "-",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"new review includes model effort and ephemeral session flag", func(t *testing.T) {
			cfg := &Config{
				Mode:                 "new",
				ClaudeModel:          "gpt-5.6-sol",
				ClaudeEffort:         "xhigh",
				NoSessionPersistence: true,
			}
			got := backend.BuildArgs(cfg, "review")
			want := []string{
				"-p", "--dangerously-skip-permissions", "--setting-sources", "", "--no-session-persistence", "--model",
				"gpt-5.6-sol", "--effort", "xhigh", "--output-format", "stream-json", "--verbose", "review",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"resume mode includes session id", func(t *testing.T) {
			cfg := &Config{Mode: "resume", SessionID: "sid-123", WorkDir: "/ignored"}
			got := backend.BuildArgs(cfg, "resume-task")
			want := []string{
				"-p", "--dangerously-skip-permissions", "--setting-sources", "", "-r", "sid-123", "--output-format",
				"stream-json", "--verbose", "resume-task",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"rejects invalid Claude effort", func(t *testing.T) {
			previousArgs := os.Args
			t.Cleanup(func() { os.Args = previousArgs })
			os.Args = []string{"codeagent-wrapper", "--backend", "claude", "--claude-effort", "invalid", "review"}
			if _, err := parseArgs(); err == nil || !strings.Contains(err.Error(), "--claude-effort") {
				t.Fatalf("parseArgs error = %v, want Claude effort rejection", err)
			}
		},
	)

	t.Run(
		"ignores invalid Claude effort for non-Claude backends", func(t *testing.T) {
			previousArgs := os.Args
			t.Cleanup(func() { os.Args = previousArgs })
			os.Args = []string{"codeagent-wrapper", "--backend", "codex", "--claude-effort", "invalid", "review"}
			if _, err := parseArgs(); err != nil {
				t.Fatalf("parseArgs error = %v, want non-Claude backend acceptance", err)
			}
		},
	)

	t.Run(
		"ephemeral sessions cannot resume", func(t *testing.T) {
			previousArgs := os.Args
			t.Cleanup(func() { os.Args = previousArgs })
			os.Args = []string{"codeagent-wrapper", "--backend", "claude", "--no-session-persistence", "resume", "sid-123", "review"}
			if _, err := parseArgs(); err == nil || !strings.Contains(err.Error(), "cannot be used with resume") {
				t.Fatalf("parseArgs error = %v, want no-session-persistence resume rejection", err)
			}
		},
	)

	t.Run(
		"resume mode without session still returns base flags", func(t *testing.T) {
			cfg := &Config{Mode: "resume", WorkDir: "/ignored"}
			got := backend.BuildArgs(cfg, "follow-up")
			want := []string{
				"-p", "--dangerously-skip-permissions", "--setting-sources", "", "--output-format", "stream-json",
				"--verbose", "follow-up",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"resume mode skip permissions remains accepted", func(t *testing.T) {
			cfg := &Config{Mode: "resume", SessionID: "sid-123", SkipPermissions: true}
			got := backend.BuildArgs(cfg, "resume-task")
			want := []string{
				"-p", "--dangerously-skip-permissions", "--setting-sources", "", "-r", "sid-123", "--output-format",
				"stream-json", "--verbose", "resume-task",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"nil config returns nil", func(t *testing.T) {
			if backend.BuildArgs(nil, "ignored") != nil {
				t.Fatalf("nil config should return nil args")
			}
		},
	)
}

func TestBackendBuildArgs_CodexAndAntigravityModes(t *testing.T) {
	t.Run(
		"antigravity new mode passes workdir via add-dir", func(t *testing.T) {
			backend := AntigravityBackend{}
			cfg := &Config{Mode: "new", WorkDir: "/workspace"}
			got := backend.BuildArgs(cfg, "task")
			want := []string{"--add-dir", "/workspace", "-p", "task"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"antigravity new mode without workdir omits add-dir", func(t *testing.T) {
			backend := AntigravityBackend{}
			cfg := &Config{Mode: "new"}
			got := backend.BuildArgs(cfg, "task")
			want := []string{"-p", "task"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"antigravity resume mode uses conversation id", func(t *testing.T) {
			backend := AntigravityBackend{}
			cfg := &Config{Mode: "resume", SessionID: "sid-999", WorkDir: "/workspace"}
			got := backend.BuildArgs(cfg, "resume")
			want := []string{"--conversation", "sid-999", "-p", "resume"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"antigravity nil config returns nil", func(t *testing.T) {
			backend := AntigravityBackend{}
			if backend.BuildArgs(nil, "ignored") != nil {
				t.Fatalf("nil config should return nil args")
			}
		},
	)

	t.Run(
		"codex build args includes bypass by default (CODEX_REQUIRE_APPROVAL unset)", func(t *testing.T) {
			t.Setenv("CODEX_REQUIRE_APPROVAL", "")

			backend := CodexBackend{}
			cfg := &Config{Mode: "new", WorkDir: "/tmp"}
			got := backend.BuildArgs(cfg, "task")
			want := []string{
				"e", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-c", "mcp_servers={}", "-C", "/tmp", "--json",
				"task",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"codex build args omits bypass when CODEX_REQUIRE_APPROVAL=true", func(t *testing.T) {
			t.Setenv("CODEX_REQUIRE_APPROVAL", "true")

			backend := CodexBackend{}
			cfg := &Config{Mode: "new", WorkDir: "/tmp"}
			got := backend.BuildArgs(cfg, "task")
			want := []string{"e", "--skip-git-repo-check", "-c", "mcp_servers={}", "-C", "/tmp", "--json", "task"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)

	t.Run(
		"progress flag does not affect backend args", func(t *testing.T) {
			backend := CodexBackend{}
			cfg := &Config{Mode: "new", WorkDir: "/tmp", Progress: true}
			got := backend.BuildArgs(cfg, "task")
			want := []string{
				"e", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-c", "mcp_servers={}", "-C", "/tmp", "--json",
				"task",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)
}

func TestParseArgs_WithMCP(t *testing.T) {
	oldArgs := os.Args
	t.Cleanup(func() { os.Args = oldArgs })
	os.Args = []string{"codeagent-wrapper", "--with-mcp", "task"}

	cfg, err := parseArgs()
	if err != nil {
		t.Fatalf("parseArgs() error = %v", err)
	}
	if !cfg.WithMCP {
		t.Fatal("--with-mcp was not propagated to Config")
	}
}

func TestCodexBuildArgs_MCPStartup(t *testing.T) {
	t.Setenv("CODEX_REQUIRE_APPROVAL", "")

	t.Run("disabled by default", func(t *testing.T) {
		got := CodexBackend{}.BuildArgs(&Config{Mode: "new", WorkDir: "/tmp"}, "task")
		want := []string{
			"e", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-c", "mcp_servers={}",
			"-C", "/tmp", "--json", "task",
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("with-mcp keeps configured servers", func(t *testing.T) {
		got := CodexBackend{}.BuildArgs(&Config{Mode: "new", WorkDir: "/tmp", WithMCP: true}, "task")
		for i, arg := range got {
			if arg == "-c" && i+1 < len(got) && got[i+1] == "mcp_servers={}" {
				t.Fatalf("--with-mcp must not empty configured servers: %v", got)
			}
		}
	})
}

func TestSelectBackend_DisablesGemini(t *testing.T) {
	_, err := selectBackend("gemini")
	if err == nil {
		t.Fatal("expected gemini backend to be disabled")
	}
	if !strings.Contains(err.Error(), "2026-06-18") || !strings.Contains(err.Error(), "antigravity") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestClaudeBuildArgs_BackendMetadata(t *testing.T) {
	tests := []struct {
		backend Backend
		name    string
		command string
	}{
		{backend: CodexBackend{}, name: "codex", command: "codex"},
		{backend: ClaudeBackend{}, name: "claude", command: "claude"},
		{backend: AntigravityBackend{}, name: "antigravity", command: "agy"},
		{backend: GrokBackend{}, name: "grok", command: "grok"},
		{backend: KimiBackend{}, name: "kimi", command: "kimi"},
		{backend: OpencodeBackend{}, name: "opencode", command: "opencode"},
	}

	for _, tt := range tests {
		if got := tt.backend.Name(); got != tt.name {
			t.Fatalf("Name() = %s, want %s", got, tt.name)
		}
		if got := tt.backend.Command(); got != tt.command {
			t.Fatalf("Command() = %s, want %s", got, tt.command)
		}
	}
}

func TestLoadModelProxyEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	for _, backend := range []string{"codex", "claude", "grok", "kimi", "opencode"} {
		if got := loadModelProxyEnv(backend); len(got) != 0 {
			t.Fatalf("%s proxy env = %v, want empty", backend, got)
		}
	}

	got := loadModelProxyEnv("gemini")
	if len(got) != 0 {
		t.Fatalf("gemini proxy env = %v, want empty", got)
	}

	got = loadModelProxyEnv("antigravity")
	if len(got) != 0 {
		t.Fatalf("default antigravity proxy env = %v, want empty", got)
	}

	dir := filepath.Join(home, ".claude", ".ccg")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	data := []byte("[routing.proxy]\nmodels = [ \"gemini\" ]\nhttp = \"http://proxy.local:8891\"\nhttps = \"http://proxy.local:8892\"\n")
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), data, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got = loadModelProxyEnv("gemini")
	if len(got) != 0 {
		t.Fatalf("configured gemini proxy env = %v, want empty", got)
	}
	got = loadModelProxyEnv("antigravity")
	if len(got) != 0 {
		t.Fatalf("legacy gemini proxy should not apply to antigravity: %v", got)
	}

	data = []byte("[routing.proxy]\nmodels = [ \"agy\" ]\nhttp = \"http://proxy.local:8891\"\nhttps = \"http://proxy.local:8892\"\n")
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), data, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got = loadModelProxyEnv("antigravity")
	if got["http_proxy"] != "http://proxy.local:8891" || got["HTTPS_PROXY"] != "http://proxy.local:8892" {
		t.Fatalf("configured antigravity proxy env = %v", got)
	}

	data = []byte("[routing.proxy]\nmodels = [ \"agy\" ]\n")
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), data, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got = loadModelProxyEnv("antigravity")
	if len(got) != 0 {
		t.Fatalf("proxy models without explicit URL should not inject env: %v", got)
	}
}

func TestAdditionalBackendBuildArgs(t *testing.T) {
	t.Run("grok", func(t *testing.T) {
		got := buildGrokArgs(&Config{Mode: "resume", SessionID: "grok-session", GrokModel: "grok-4.5"}, "review")
		want := []string{"--always-approve", "--output-format", "streaming-json", "-m", "grok-4.5", "-r", "grok-session", "-p", "review"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("kimi", func(t *testing.T) {
		got := buildKimiArgs(&Config{Mode: "resume", SessionID: "kimi-session", KimiModel: "kimi-code"}, "review")
		want := []string{"--output-format", "stream-json", "--final-message-only", "-m", "kimi-code", "-S", "kimi-session", "-p", "review"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("opencode", func(t *testing.T) {
		got := buildOpencodeArgs(&Config{Mode: "resume", SessionID: "opencode-session", OpencodeModel: "anthropic/claude-opus-5"}, "review")
		want := []string{"run", "-m", "anthropic/claude-opus-5", "-s", "opencode-session", "--format", "json", "review"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for _, arg := range buildOpencodeArgs(&Config{}, "-") {
			if arg == "-" {
				t.Fatalf("stdin marker leaked into opencode args: %v", got)
			}
		}
	})
}

func TestAdditionalBackendStreamParsing(t *testing.T) {
	t.Run("grok excludes thoughts", func(t *testing.T) {
		message, sessionID := parseJSONStream(strings.NewReader("{\"type\":\"thought\",\"data\":\"internal\"}\n{\"type\":\"text\",\"data\":\"answer\"}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"sessionId\":\"grok-session\"}\n"))
		if message != "answer" || sessionID != "grok-session" {
			t.Fatalf("message=%q session=%q", message, sessionID)
		}
	})

	t.Run("kimi excludes metadata and tool output", func(t *testing.T) {
		message, sessionID := parseJSONStream(strings.NewReader("{\"role\":\"meta\",\"type\":\"session.resume_hint\",\"session_id\":\"kimi-session\",\"content\":\"resume hint\"}\n{\"role\":\"assistant\",\"content\":\"answer\"}\n{\"role\":\"tool\",\"content\":\"tool output\"}\n"))
		if message != "answer" || sessionID != "kimi-session" {
			t.Fatalf("message=%q session=%q", message, sessionID)
		}
	})

	t.Run("opencode", func(t *testing.T) {
		message, sessionID := parseJSONStream(strings.NewReader("{\"type\":\"text\",\"sessionID\":\"opencode-session\",\"part\":{\"type\":\"text\",\"text\":\"answer\"}}\n{\"type\":\"step-finish\",\"sessionID\":\"opencode-session\",\"part\":{\"type\":\"step-finish\",\"reason\":\"stop\"}}\n"))
		if message != "answer" || sessionID != "opencode-session" {
			t.Fatalf("message=%q session=%q", message, sessionID)
		}
	})
}

func TestLoadMinimalEnvSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	t.Run(
		"missing file returns empty", func(t *testing.T) {
			if got := loadMinimalEnvSettings(); len(got) != 0 {
				t.Fatalf("got %v, want empty", got)
			}
		},
	)

	t.Run(
		"valid env returns string map", func(t *testing.T) {
			dir := filepath.Join(home, ".claude")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatalf("MkdirAll: %v", err)
			}
			path := filepath.Join(dir, "settings.json")
			data := []byte(`{"env":{"ANTHROPIC_API_KEY":"secret","FOO":"bar"}}`)
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}

			got := loadMinimalEnvSettings()
			if got["ANTHROPIC_API_KEY"] != "secret" || got["FOO"] != "bar" {
				t.Fatalf("got %v, want keys present", got)
			}
		},
	)

	t.Run(
		"non-string values are ignored", func(t *testing.T) {
			dir := filepath.Join(home, ".claude")
			path := filepath.Join(dir, "settings.json")
			data := []byte(`{"env":{"GOOD":"ok","BAD":123,"ALSO_BAD":true}}`)
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}

			got := loadMinimalEnvSettings()
			if got["GOOD"] != "ok" {
				t.Fatalf("got %v, want GOOD=ok", got)
			}
			if _, ok := got["BAD"]; ok {
				t.Fatalf("got %v, want BAD omitted", got)
			}
			if _, ok := got["ALSO_BAD"]; ok {
				t.Fatalf("got %v, want ALSO_BAD omitted", got)
			}
		},
	)

	t.Run(
		"oversized file returns empty", func(t *testing.T) {
			dir := filepath.Join(home, ".claude")
			path := filepath.Join(dir, "settings.json")
			data := bytes.Repeat([]byte("a"), maxClaudeSettingsBytes+1)
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}
			if got := loadMinimalEnvSettings(); len(got) != 0 {
				t.Fatalf("got %v, want empty", got)
			}
		},
	)
}
