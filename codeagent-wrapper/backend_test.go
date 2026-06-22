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
				"e", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", "/tmp", "--json",
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
			want := []string{"e", "--skip-git-repo-check", "-C", "/tmp", "--json", "task"}
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
				"e", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", "/tmp", "--json",
				"task",
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		},
	)
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

	if got := loadModelProxyEnv("codex"); len(got) != 0 {
		t.Fatalf("codex proxy env = %v, want empty", got)
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
