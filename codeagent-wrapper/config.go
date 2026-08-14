package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds CLI configuration
type Config struct {
	Mode                 string // "new" or "resume"
	Task                 string
	SessionID            string
	WorkDir              string
	ExplicitStdin        bool
	Timeout              int
	Backend              string
	SkipPermissions      bool
	MaxParallelWorkers   int
	ClaudeModel          string
	ClaudeEffort         string
	NoSessionPersistence bool
	GrokModel            string
	KimiModel            string
	OpencodeModel        string
	Progress             bool // Emit compact progress lines to stderr
}

// ParallelConfig defines the JSON schema for parallel execution
type ParallelConfig struct {
	Tasks         []TaskSpec `json:"tasks"`
	GlobalBackend string     `json:"backend,omitempty"`
}

// TaskSpec describes an individual task entry in the parallel config
type TaskSpec struct {
	ID                   string          `json:"id"`
	Task                 string          `json:"task"`
	WorkDir              string          `json:"workdir,omitempty"`
	Dependencies         []string        `json:"dependencies,omitempty"`
	SessionID            string          `json:"session_id,omitempty"`
	Backend              string          `json:"backend,omitempty"`
	Progress             bool            `json:"-"`
	Mode                 string          `json:"-"`
	UseStdin             bool            `json:"-"`
	ClaudeModel          string          `json:"-"`
	ClaudeEffort         string          `json:"-"`
	NoSessionPersistence bool            `json:"-"`
	GrokModel            string          `json:"-"`
	KimiModel            string          `json:"-"`
	OpencodeModel        string          `json:"-"`
	Context              context.Context `json:"-"`
}

// TaskResult captures the execution outcome of a task
type TaskResult struct {
	TaskID    string `json:"task_id"`
	ExitCode  int    `json:"exit_code"`
	Message   string `json:"message"`
	SessionID string `json:"session_id"`
	Error     string `json:"error"`
	LogPath   string `json:"log_path"`
	// Structured report fields
	Coverage       string   `json:"coverage,omitempty"`        // extracted coverage percentage (e.g., "92%")
	CoverageNum    float64  `json:"coverage_num,omitempty"`    // numeric coverage for comparison
	CoverageTarget float64  `json:"coverage_target,omitempty"` // target coverage (default 90)
	FilesChanged   []string `json:"files_changed,omitempty"`   // list of changed files
	KeyOutput      string   `json:"key_output,omitempty"`      // brief summary of what was done
	TestsPassed    int      `json:"tests_passed,omitempty"`    // number of tests passed
	TestsFailed    int      `json:"tests_failed,omitempty"`    // number of tests failed
	sharedLog      bool
}

var backendRegistry = map[string]Backend{
	"codex":       CodexBackend{},
	"claude":      ClaudeBackend{},
	"antigravity": AntigravityBackend{},
	"agy":         AntigravityBackend{},
	"grok":        GrokBackend{},
	"kimi":        KimiBackend{},
	"opencode":    OpencodeBackend{},
}

func selectBackend(name string) (Backend, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		key = defaultBackendName
	}
	if key == "gemini" {
		return nil, fmt.Errorf("Gemini CLI is disabled: consumer OAuth requests stopped being processed after 2026-06-18; use --backend antigravity or --backend agy")
	}
	if backend, ok := backendRegistry[key]; ok {
		return backend, nil
	}
	return nil, fmt.Errorf("unsupported backend %q", name)
}

func envFlagEnabled(key string) bool {
	val, ok := os.LookupEnv(key)
	if !ok {
		return false
	}
	val = strings.TrimSpace(strings.ToLower(val))
	switch val {
	case "", "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func parseBoolFlag(val string, defaultValue bool) bool {
	val = strings.TrimSpace(strings.ToLower(val))
	switch val {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return defaultValue
	}
}

func isValidClaudeEffort(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "low", "medium", "high", "xhigh", "max":
		return true
	default:
		return false
	}
}

func parseParallelConfig(data []byte) (*ParallelConfig, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("parallel config is empty")
	}

	tasks := strings.Split(string(trimmed), "---TASK---")
	var cfg ParallelConfig
	seen := make(map[string]struct{})

	taskIndex := 0
	for _, taskBlock := range tasks {
		taskBlock = strings.TrimSpace(taskBlock)
		if taskBlock == "" {
			continue
		}
		taskIndex++

		parts := strings.SplitN(taskBlock, "---CONTENT---", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("task block #%d missing ---CONTENT--- separator", taskIndex)
		}

		meta := strings.TrimSpace(parts[0])
		content := strings.TrimSpace(parts[1])

		task := TaskSpec{WorkDir: defaultWorkdir}
		for _, line := range strings.Split(meta, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			kv := strings.SplitN(line, ":", 2)
			if len(kv) != 2 {
				continue
			}
			key := strings.TrimSpace(kv[0])
			value := strings.TrimSpace(kv[1])

			switch key {
			case "id":
				task.ID = value
			case "workdir":
				task.WorkDir = value
			case "session_id":
				task.SessionID = value
				task.Mode = "resume"
			case "backend":
				task.Backend = value
			case "dependencies":
				for _, dep := range strings.Split(value, ",") {
					dep = strings.TrimSpace(dep)
					if dep != "" {
						task.Dependencies = append(task.Dependencies, dep)
					}
				}
			}
		}

		if task.Mode == "" {
			task.Mode = "new"
		}

		if task.ID == "" {
			return nil, fmt.Errorf("task block #%d missing id field", taskIndex)
		}
		if content == "" {
			return nil, fmt.Errorf("task block #%d (%q) missing content", taskIndex, task.ID)
		}
		if task.Mode == "resume" && strings.TrimSpace(task.SessionID) == "" {
			return nil, fmt.Errorf("task block #%d (%q) has empty session_id", taskIndex, task.ID)
		}
		if _, exists := seen[task.ID]; exists {
			return nil, fmt.Errorf("task block #%d has duplicate id: %s", taskIndex, task.ID)
		}

		task.Task = content
		cfg.Tasks = append(cfg.Tasks, task)
		seen[task.ID] = struct{}{}
	}

	if len(cfg.Tasks) == 0 {
		return nil, fmt.Errorf("no tasks found")
	}

	return &cfg, nil
}

func unsupportedWrapperFlagHint(arg string) string {
	switch {
	case arg == "--add-dir", strings.HasPrefix(arg, "--add-dir="):
		return "--add-dir is a backend CLI flag. Use: codeagent-wrapper --backend antigravity \"task\" <workdir>"
	case arg == "-p", arg == "--print", arg == "--prompt", arg == "--prompt-interactive", arg == "-i":
		return arg + " is a backend CLI flag. Use: codeagent-wrapper --backend antigravity \"task\" <workdir>, or codeagent-wrapper --backend antigravity - <workdir> <<'EOF'"
	case arg == "--print-timeout", strings.HasPrefix(arg, "--print-timeout="):
		return "--print-timeout is managed by codeagent-wrapper timeout settings; do not pass backend CLI flags directly"
	}
	return ""
}

func parseArgs() (*Config, error) {
	args := os.Args[1:]
	if len(args) == 0 {
		return nil, fmt.Errorf("task required")
	}

	claudeModel := strings.TrimSpace(os.Getenv("CLAUDE_MODEL"))
	claudeEffort := strings.TrimSpace(os.Getenv("CLAUDE_EFFORT"))
	noSessionPersistence := false
	grokModel := strings.TrimSpace(os.Getenv("GROK_MODEL"))
	kimiModel := strings.TrimSpace(os.Getenv("KIMI_MODEL"))
	opencodeModel := strings.TrimSpace(os.Getenv("OPENCODE_MODEL"))
	backendName := defaultBackendName
	skipPermissions := envFlagEnabled("CODEAGENT_SKIP_PERMISSIONS")
	progress := false
	filtered := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if hint := unsupportedWrapperFlagHint(arg); hint != "" {
			return nil, fmt.Errorf("unsupported codeagent-wrapper argument %q: %s", arg, hint)
		}
		switch {
		case arg == "--lite", arg == "-L":
			liteMode = true
			continue
		case arg == "--backend":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--backend flag requires a value")
			}
			backendName = args[i+1]
			i++
			continue
		case strings.HasPrefix(arg, "--backend="):
			value := strings.TrimPrefix(arg, "--backend=")
			if value == "" {
				return nil, fmt.Errorf("--backend flag requires a value")
			}
			backendName = value
			continue
		case arg == "--gemini-model" || strings.HasPrefix(arg, "--gemini-model="):
			return nil, fmt.Errorf("--gemini-model is disabled because Gemini CLI consumer OAuth requests stopped being processed after 2026-06-18; use --backend antigravity")
		case arg == "--claude-model", arg == "--claude-effort", arg == "--grok-model", arg == "--kimi-model", arg == "--opencode-model":
			if i+1 >= len(args) || strings.TrimSpace(args[i+1]) == "" {
				if arg == "--claude-effort" {
					return nil, fmt.Errorf("%s flag requires a non-empty effort level", arg)
				}
				return nil, fmt.Errorf("%s flag requires a non-empty model name", arg)
			}
			value := strings.TrimSpace(args[i+1])
			switch arg {
			case "--claude-model":
				claudeModel = value
			case "--claude-effort":
				claudeEffort = value
			case "--grok-model":
				grokModel = value
			case "--kimi-model":
				kimiModel = value
			case "--opencode-model":
				opencodeModel = value
			}
			i++
			continue
		case arg == "--no-session-persistence":
			noSessionPersistence = true
			continue
		case strings.HasPrefix(arg, "--claude-model="), strings.HasPrefix(arg, "--claude-effort="), strings.HasPrefix(arg, "--grok-model="), strings.HasPrefix(arg, "--kimi-model="), strings.HasPrefix(arg, "--opencode-model="):
			key, value, _ := strings.Cut(arg, "=")
			value = strings.TrimSpace(value)
			if value == "" {
				if key == "--claude-effort" {
					return nil, fmt.Errorf("%s flag requires a non-empty effort level", key)
				}
				return nil, fmt.Errorf("%s flag requires a non-empty model name", key)
			}
			switch key {
			case "--claude-model":
				claudeModel = value
			case "--claude-effort":
				claudeEffort = value
			case "--grok-model":
				grokModel = value
			case "--kimi-model":
				kimiModel = value
			case "--opencode-model":
				opencodeModel = value
			}
			continue
		case arg == "--skip-permissions", arg == "--dangerously-skip-permissions":
			skipPermissions = true
			continue
		case arg == "--progress":
			progress = true
			continue
		case strings.HasPrefix(arg, "--skip-permissions="):
			skipPermissions = parseBoolFlag(strings.TrimPrefix(arg, "--skip-permissions="), skipPermissions)
			continue
		case strings.HasPrefix(arg, "--dangerously-skip-permissions="):
			skipPermissions = parseBoolFlag(strings.TrimPrefix(arg, "--dangerously-skip-permissions="), skipPermissions)
			continue
		}
		filtered = append(filtered, arg)
	}

	if len(filtered) == 0 {
		return nil, fmt.Errorf("task required")
	}
	args = filtered

	cfg := &Config{
		WorkDir: defaultWorkdir, Backend: backendName, SkipPermissions: skipPermissions,
		ClaudeModel: claudeModel, ClaudeEffort: claudeEffort, NoSessionPersistence: noSessionPersistence,
		GrokModel: grokModel, KimiModel: kimiModel, OpencodeModel: opencodeModel, Progress: progress,
	}
	cfg.MaxParallelWorkers = resolveMaxParallelWorkers()

	isClaudeBackend := strings.EqualFold(strings.TrimSpace(backendName), "claude")
	if noSessionPersistence && !isClaudeBackend {
		return nil, fmt.Errorf("--no-session-persistence is only supported by the claude backend")
	}
	if isClaudeBackend && !isValidClaudeEffort(claudeEffort) {
		return nil, fmt.Errorf("--claude-effort must be one of: low, medium, high, xhigh, max")
	}

	if args[0] == "resume" {
		if noSessionPersistence {
			return nil, fmt.Errorf("--no-session-persistence cannot be used with resume")
		}
		if len(args) < 3 {
			return nil, fmt.Errorf("resume mode requires: resume <session_id> <task>")
		}
		cfg.Mode = "resume"
		cfg.SessionID = strings.TrimSpace(args[1])
		if cfg.SessionID == "" {
			return nil, fmt.Errorf("resume mode requires non-empty session_id")
		}
		cfg.Task = args[2]
		cfg.ExplicitStdin = (args[2] == "-")
		if len(args) > 3 {
			cfg.WorkDir = args[3]
		}
	} else {
		cfg.Mode = "new"
		cfg.Task = args[0]
		cfg.ExplicitStdin = (args[0] == "-")
		if len(args) > 1 {
			cfg.WorkDir = args[1]
		}
	}

	return cfg, nil
}

const maxParallelWorkersLimit = 100

func resolveMaxParallelWorkers() int {
	raw := strings.TrimSpace(os.Getenv("CODEAGENT_MAX_PARALLEL_WORKERS"))
	if raw == "" {
		return 0
	}

	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		logWarn(fmt.Sprintf("Invalid CODEAGENT_MAX_PARALLEL_WORKERS=%q, falling back to unlimited", raw))
		return 0
	}

	if value > maxParallelWorkersLimit {
		logWarn(
			fmt.Sprintf(
				"CODEAGENT_MAX_PARALLEL_WORKERS=%d exceeds limit, capping at %d", value, maxParallelWorkersLimit,
			),
		)
		return maxParallelWorkersLimit
	}

	return value
}
