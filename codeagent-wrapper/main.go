package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"reflect"
	"strings"
	"sync/atomic"
	"time"
)

const (
	version               = "5.16.0-aug.1"
	defaultWorkdir        = "."
	defaultTimeout        = 7200 // seconds (2 hours)
	defaultCoverageTarget = 90.0
	codexLogLineLimit     = 0 // 0 = unlimited (prevent truncation of long JSON events like agent_message)
	stdinSpecialChars     = "\n\\\"'`$"
	stderrCaptureLimit    = 4 * 1024
	defaultBackendName    = "codex"
	defaultCodexCommand   = "codex"

	// stdout close reasons
	stdoutCloseReasonWait  = "wait-done"
	stdoutCloseReasonDrain = "drain-timeout"
	stdoutCloseReasonCtx   = "context-cancel"
	stdoutDrainTimeout     = 100 * time.Millisecond
)

func defaultLiteMode() bool {
	return os.Getenv("CODEAGENT_LITE_MODE") != "false"
}

func redactTaskArgs(args []string, task string) []string {
	redacted := make([]string, len(args))
	for i, arg := range args {
		if task != "" && arg == task {
			redacted[i] = "<task>"
		} else {
			redacted[i] = arg
		}
	}
	return redacted
}

// Lite mode: disable WebServer, reduce logging, faster post-message delay.
// Enabled by default; set CODEAGENT_LITE_MODE=false to opt into Web UI.
var liteMode = defaultLiteMode()

// Test hooks for dependency injection
var (
	stdinReader  io.Reader = os.Stdin
	isTerminalFn           = defaultIsTerminal
	codexCommand           = defaultCodexCommand
	cleanupHook  func()
	loggerPtr    atomic.Pointer[fileLogger]

	buildCodexArgsFn = buildCodexArgs
	selectBackendFn  = selectBackend
	commandContext   = exec.CommandContext

	cleanupLogsFn      = cleanupOldLogs
	signalNotifyFn     = signal.Notify
	signalStopFn       = signal.Stop
	terminateCommandFn = terminateCommand
	defaultBuildArgsFn = buildCodexArgs
	runTaskFn          = runCodexTask
	exitFn             = os.Exit
)

var forceKillDelay atomic.Int32

// globalWebServer is the SSE web server for live-streaming output
var globalWebServer *WebServer

func init() {
	forceKillDelay.Store(5) // seconds - default value
}

func isWindows() bool {
	return os.Getenv("OS") == "Windows_NT" || len(os.Getenv("WINDIR")) > 0
}

func runStartupCleanup() {
	if cleanupLogsFn == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logWarn(fmt.Sprintf("cleanupOldLogs panic: %v", r))
		}
	}()
	if _, err := cleanupLogsFn(); err != nil {
		logWarn(fmt.Sprintf("cleanupOldLogs error: %v", err))
	}
}

func runCleanupMode() int {
	if cleanupLogsFn == nil {
		if _, err := fmt.Fprintln(os.Stderr, "Cleanup failed: log cleanup function not configured"); err != nil {
			logWarn("I/O operation failed: " + err.Error())
		}
		return 1
	}

	stats, err := cleanupLogsFn()
	if err != nil {
		if _, err := fmt.Fprintf(os.Stderr, "Cleanup failed: %v\n", err); err != nil {
			logWarn("I/O operation failed: " + err.Error())
		}
		return 1
	}

	if _, err := fmt.Println("Cleanup completed"); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if _, err := fmt.Printf("Files scanned: %d\n", stats.Scanned); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if _, err := fmt.Printf("Files deleted: %d\n", stats.Deleted); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if len(stats.DeletedFiles) > 0 {
		for _, f := range stats.DeletedFiles {
			if _, err := fmt.Printf("  - %s\n", f); err != nil {
				logWarn("I/O operation failed: " + err.Error())
			}
		}
	}
	if _, err := fmt.Printf("Files kept: %d\n", stats.Kept); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if len(stats.KeptFiles) > 0 {
		for _, f := range stats.KeptFiles {
			if _, err := fmt.Printf("  - %s\n", f); err != nil {
				logWarn("I/O operation failed: " + err.Error())
			}
		}
	}
	if stats.Errors > 0 {
		if _, err := fmt.Printf("Deletion errors: %d\n", stats.Errors); err != nil {
			logWarn("I/O operation failed: " + err.Error())
		}
	}
	return 0
}

func main() {
	exitCode := run()
	exitFn(exitCode)
}

// run is the main logic, returns exit code for testability
func run() (exitCode int) {
	name := currentWrapperName()
	// Handle --version and --help first (no logger needed)
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v":
			if _, err := fmt.Printf("%s version %s\n", name, version); err != nil {
				logWarn("I/O operation failed: " + err.Error())
			}
			return 0
		case "--help", "-h":
			printHelp()
			return 0
		case "--cleanup":
			return runCleanupMode()
		}
	}

	// Initialize logger for all other commands
	logger, err := newLogger()
	if err != nil {
		if _, err := fmt.Fprintf(os.Stderr, "ERROR: failed to initialize logger: %v\n", err); err != nil {
			logWarn("I/O operation failed: " + err.Error())
		}
		return 1
	}
	setLogger(logger)

	defer func() {
		logger := activeLogger()
		if logger != nil {
			logger.Flush()
		}
		// Shutdown WebServer if it was started
		if globalWebServer != nil {
			_ = globalWebServer.stop()
			globalWebServer = nil
		}
		if err := closeLogger(); err != nil {
			if _, err := fmt.Fprintf(os.Stderr, "ERROR: failed to close logger: %v\n", err); err != nil {
				logWarn("I/O operation failed: " + err.Error())
			}
		}
		// On failure, extract and display recent errors before removing log
		if logger != nil {
			if exitCode != 0 {
				if errors := logger.extractRecentErrors(10); len(errors) > 0 {
					if _, err := fmt.Fprintln(os.Stderr, "\n=== Recent Errors ==="); err != nil {
						logWarn("I/O operation failed: " + err.Error())
					}
					for _, entry := range errors {
						if _, err := fmt.Fprintln(os.Stderr, entry); err != nil {
							logWarn("I/O operation failed: " + err.Error())
						}
					}
					if _, err := fmt.Fprintf(os.Stderr, "Log file: %s (deleted)\n", logger.logPath()); err != nil {
						logWarn("I/O operation failed: " + err.Error())
					}
				}
			}
			if err := logger.removeLogFile(); err != nil && !os.IsNotExist(err) {
				// Silently ignore removal errors
			}
		}
	}()
	defer runCleanupHook()

	// Clean up stale logs from previous runs.
	runStartupCleanup()

	// Handle remaining commands
	if len(os.Args) > 1 {
		args := os.Args[1:]
		parallelIndex := -1
		for i, arg := range args {
			if arg == "--parallel" {
				parallelIndex = i
				break
			}
		}

		if parallelIndex != -1 {
			backendName := defaultBackendName
			fullOutput := false
			progressFlag := false
			withMCP := false
			claudeModel := strings.TrimSpace(os.Getenv("CLAUDE_MODEL"))
			claudeEffort := strings.TrimSpace(os.Getenv("CLAUDE_EFFORT"))
			noSessionPersistence := false
			grokModel := strings.TrimSpace(os.Getenv("GROK_MODEL"))
			kimiModel := strings.TrimSpace(os.Getenv("KIMI_MODEL"))
			opencodeModel := strings.TrimSpace(os.Getenv("OPENCODE_MODEL"))
			var extras []string

			for i := 0; i < len(args); i++ {
				arg := args[i]
				switch {
				case arg == "--parallel":
					continue
				case arg == "--full-output":
					fullOutput = true
				case arg == "--lite", arg == "-L":
					liteMode = true
				case arg == "--progress":
					progressFlag = true
				case arg == "--with-mcp":
					withMCP = true
				case arg == "--backend":
					if i+1 >= len(args) {
						if _, err := fmt.Fprintln(os.Stderr, "ERROR: --backend flag requires a value"); err != nil {
							logWarn("I/O operation failed: " + err.Error())
						}
						return 1
					}
					backendName = args[i+1]
					i++
				case strings.HasPrefix(arg, "--backend="):
					value := strings.TrimPrefix(arg, "--backend=")
					if value == "" {
						if _, err := fmt.Fprintln(os.Stderr, "ERROR: --backend flag requires a value"); err != nil {
							logWarn("I/O operation failed: " + err.Error())
						}
						return 1
					}
					backendName = value
				case arg == "--gemini-model" || strings.HasPrefix(arg, "--gemini-model="):
					if _, err := fmt.Fprintln(
						os.Stderr, "ERROR: --gemini-model is disabled because Gemini CLI consumer OAuth "+
							"requests stopped being processed after 2026-06-18; use --backend "+
							"antigravity",
					); err != nil {
						logWarn("I/O operation failed: " + err.Error())
					}
					return 1
				case arg == "--claude-model",
					arg == "--claude-effort",
					arg == "--grok-model",
					arg == "--kimi-model",
					arg == "--opencode-model":
					if i+1 >= len(args) || strings.TrimSpace(args[i+1]) == "" {
						if arg == "--claude-effort" {
							if _, err := fmt.Fprintf(
								os.Stderr, "ERROR: %s flag requires a non-empty effort level\n", arg,
							); err != nil {
								logWarn("I/O operation failed: " + err.Error())
							}
						} else {
							if _, err := fmt.Fprintf(
								os.Stderr, "ERROR: %s flag requires a non-empty model name\n", arg,
							); err != nil {
								logWarn("I/O operation failed: " + err.Error())
							}
						}
						return 1
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
					default:
						opencodeModel = value
					}
					i++
				case arg == "--no-session-persistence":
					noSessionPersistence = true
				case strings.HasPrefix(arg, "--claude-model="),
					strings.HasPrefix(arg, "--claude-effort="),
					strings.HasPrefix(arg, "--grok-model="),
					strings.HasPrefix(arg, "--kimi-model="),
					strings.HasPrefix(arg, "--opencode-model="):
					key, value, _ := strings.Cut(arg, "=")
					value = strings.TrimSpace(value)
					if value == "" {
						if key == "--claude-effort" {
							if _, err := fmt.Fprintf(
								os.Stderr, "ERROR: %s flag requires a non-empty effort level\n", key,
							); err != nil {
								logWarn("I/O operation failed: " + err.Error())
							}
						} else {
							if _, err := fmt.Fprintf(
								os.Stderr, "ERROR: %s flag requires a non-empty model name\n", key,
							); err != nil {
								logWarn("I/O operation failed: " + err.Error())
							}
						}
						return 1
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
					default:
						opencodeModel = value
					}
				default:
					extras = append(extras, arg)
				}
			}

			if len(extras) > 0 {
				if _, err := fmt.Fprintln(
					os.Stderr,
					"ERROR: --parallel reads task configuration from stdin; only recognized wrapper flags may be supplied.",
				); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				if _, err := fmt.Fprintln(os.Stderr, "Usage examples:"); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				if _, err := fmt.Fprintf(os.Stderr, "  %s --parallel < tasks.txt\n", name); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				if _, err := fmt.Fprintf(os.Stderr, "  echo '...' | %s --parallel\n", name); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				if _, err := fmt.Fprintf(os.Stderr, "  %s --parallel <<'EOF'\n", name); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				if _, err := fmt.Fprintf(
					os.Stderr, "  %s --parallel --full-output <<'EOF'  # include full task output\n", name,
				); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				return 1
			}

			backend, err := selectBackendFn(backendName)
			if err != nil {
				if _, err := fmt.Fprintf(os.Stderr, "ERROR: %v\n", err); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				return 1
			}
			backendName = backend.Name()
			data, err := io.ReadAll(stdinReader)
			if err != nil {
				if _, err := fmt.Fprintf(os.Stderr, "ERROR: failed to read stdin: %v\n", err); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				return 1
			}

			cfg, err := parseParallelConfig(data)
			if err != nil {
				if _, err := fmt.Fprintf(os.Stderr, "ERROR: %v\n", err); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				return 1
			}

			cfg.GlobalBackend = backendName
			usesClaudeBackend := false
			for i := range cfg.Tasks {
				if strings.TrimSpace(cfg.Tasks[i].Backend) == "" {
					cfg.Tasks[i].Backend = backendName
				}
				taskBackend, err := selectBackendFn(cfg.Tasks[i].Backend)
				if err != nil {
					if _, err := fmt.Fprintf(os.Stderr, "ERROR: %v\n", err); err != nil {
						logWarn("I/O operation failed: " + err.Error())
					}
					return 1
				}
				cfg.Tasks[i].Backend = taskBackend.Name()
				usesClaudeBackend = usesClaudeBackend || taskBackend.Name() == "claude"
				if noSessionPersistence && cfg.Tasks[i].Mode == "resume" {
					if _, err := fmt.Fprintln(
						os.Stderr, "ERROR: --no-session-persistence cannot be used with resume",
					); err != nil {
						logWarn("I/O operation failed: " + err.Error())
					}
					return 1
				}
				if noSessionPersistence && taskBackend.Name() != "claude" {
					if _, err := fmt.Fprintln(
						os.Stderr, "ERROR: --no-session-persistence is only supported by the claude "+
							"backend",
					); err != nil {
						logWarn("I/O operation failed: " + err.Error())
					}
					return 1
				}
			}
			if usesClaudeBackend && !isValidClaudeEffort(claudeEffort) {
				if _, err := fmt.Fprintln(
					os.Stderr, "ERROR: --claude-effort must be one of: low, medium, high, xhigh, max",
				); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				return 1
			}
			for i := range cfg.Tasks {
				cfg.Tasks[i].ClaudeModel = claudeModel
				cfg.Tasks[i].ClaudeEffort = claudeEffort
				cfg.Tasks[i].NoSessionPersistence = noSessionPersistence
				cfg.Tasks[i].GrokModel = grokModel
				cfg.Tasks[i].KimiModel = kimiModel
				cfg.Tasks[i].OpencodeModel = opencodeModel
				cfg.Tasks[i].Progress = progressFlag
				cfg.Tasks[i].WithMCP = withMCP
				// Inject ROLE_FILE content if present
				injectedTask, err := injectRoleFile(cfg.Tasks[i].Task)
				if err != nil {
					logWarn(fmt.Sprintf("Failed to inject ROLE_FILE for task %s: %v", cfg.Tasks[i].ID, err))
				} else {
					cfg.Tasks[i].Task = injectedTask
				}
			}

			timeoutSec := resolveTimeout()
			layers, err := topologicalSort(cfg.Tasks)
			if err != nil {
				if _, err := fmt.Fprintf(os.Stderr, "ERROR: %v\n", err); err != nil {
					logWarn("I/O operation failed: " + err.Error())
				}
				return 1
			}

			results := executeConcurrent(layers, timeoutSec)
			if noSessionPersistence {
				for i := range results {
					results[i].SessionID = ""
				}
			}

			// Extract structured report fields from each result
			for i := range results {
				results[i].CoverageTarget = defaultCoverageTarget
				if results[i].Message == "" {
					continue
				}

				lines := strings.Split(results[i].Message, "\n")

				// Coverage extraction
				results[i].Coverage = extractCoverageFromLines(lines)
				results[i].CoverageNum = extractCoverageNum(results[i].Coverage)

				// Files changed
				results[i].FilesChanged = extractFilesChangedFromLines(lines)

				// Test results
				results[i].TestsPassed, results[i].TestsFailed = extractTestResultsFromLines(lines)

				// Key output summary
				results[i].KeyOutput = extractKeyOutputFromLines(lines, 150)
			}

			// Default: summary mode (context-efficient)
			// --full-output: legacy full output mode
			if _, err := fmt.Println(generateFinalOutputWithMode(results, !fullOutput)); err != nil {
				logWarn("I/O operation failed: " + err.Error())
			}

			exitCode = 0
			for _, res := range results {
				if res.ExitCode != 0 {
					exitCode = res.ExitCode
				}
			}

			return exitCode
		}
	}

	logInfo("Script started")

	cfg, err := parseArgs()
	if err != nil {
		logError(err.Error())
		return 1
	}
	logInfo(fmt.Sprintf("Parsed args: mode=%s, task_len=%d, backend=%s", cfg.Mode, len(cfg.Task), cfg.Backend))

	backend, err := selectBackendFn(cfg.Backend)
	if err != nil {
		logError(err.Error())
		return 1
	}
	cfg.Backend = backend.Name()

	cmdInjected := codexCommand != defaultCodexCommand
	argsInjected := buildCodexArgsFn != nil &&
		reflect.ValueOf(buildCodexArgsFn).Pointer() != reflect.ValueOf(defaultBuildArgsFn).Pointer()

	// Wire selected backend into runtime hooks for the rest of the execution,
	// but preserve any injected test hooks for the default backend.
	if backend.Name() != defaultBackendName || !cmdInjected {
		codexCommand = backend.Command()
	}
	if backend.Name() != defaultBackendName || !argsInjected {
		buildCodexArgsFn = backend.BuildArgs
	}
	logInfo(fmt.Sprintf("Selected backend: %s", backend.Name()))

	timeoutSec := resolveTimeout()
	logInfo(fmt.Sprintf("Timeout: %ds", timeoutSec))
	cfg.Timeout = timeoutSec

	var taskText string
	var piped bool

	if cfg.ExplicitStdin {
		logInfo("Explicit stdin mode: reading task from stdin")
		data, err := io.ReadAll(stdinReader)
		if err != nil {
			logError("Failed to read stdin: " + err.Error())
			return 1
		}
		taskText = string(data)
		if taskText == "" {
			logError("Explicit stdin mode requires task input from stdin")
			return 1
		}
		// Inject ROLE_FILE content if present
		taskText, err = injectRoleFile(taskText)
		if err != nil {
			logWarn(fmt.Sprintf("Failed to inject ROLE_FILE: %v", err))
		}
		piped = !isTerminal()
	} else {
		pipedTask, err := readPipedTask()
		if err != nil {
			logError("Failed to read piped stdin: " + err.Error())
			return 1
		}
		piped = pipedTask != ""
		if piped {
			// Inject ROLE_FILE content if present
			taskText, err = injectRoleFile(pipedTask)
			if err != nil {
				logWarn(fmt.Sprintf("Failed to inject ROLE_FILE: %v", err))
			}
		} else {
			taskText = cfg.Task
		}
	}

	useStdin := cfg.ExplicitStdin || shouldUseStdin(taskText, piped)

	targetArg := taskText
	promptBackend := cfg.Backend == "antigravity" || cfg.Backend == "agy" || cfg.Backend == "grok" ||
		cfg.Backend == "kimi" ||
		cfg.Backend == "opencode"
	promptDirect := useStdin && promptBackend
	if useStdin && !promptDirect {
		targetArg = "-"
	}
	codexArgs := buildCodexArgsFn(cfg, targetArg)

	// Print startup information to stderr
	if _, err := fmt.Fprintf(os.Stderr, "[%s]\n", name); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if _, err := fmt.Fprintf(os.Stderr, "  Backend: %s\n", cfg.Backend); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if _, err := fmt.Fprintf(
		os.Stderr, "  Command: %s %s\n", codexCommand, strings.Join(redactTaskArgs(codexArgs, taskText), " "),
	); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if _, err := fmt.Fprintf(os.Stderr, "  PID: %d\n", os.Getpid()); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if _, err := fmt.Fprintf(os.Stderr, "  Log: %s\n", logger.logPath()); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}

	if useStdin {
		var reasons []string
		if piped {
			reasons = append(reasons, "piped input")
		}
		if cfg.ExplicitStdin {
			reasons = append(reasons, "explicit \"-\"")
		}
		if strings.Contains(taskText, "\n") {
			reasons = append(reasons, "newline")
		}
		if strings.Contains(taskText, "\\") {
			reasons = append(reasons, "backslash")
		}
		if strings.Contains(taskText, "\"") {
			reasons = append(reasons, "double-quote")
		}
		if strings.Contains(taskText, "'") {
			reasons = append(reasons, "single-quote")
		}
		if strings.Contains(taskText, "`") {
			reasons = append(reasons, "backtick")
		}
		if strings.Contains(taskText, "$") {
			reasons = append(reasons, "dollar")
		}
		if len(taskText) > 800 {
			reasons = append(reasons, "length>800")
		}
		if len(reasons) > 0 {
			logWarn(fmt.Sprintf("Using stdin mode for task due to: %s", strings.Join(reasons, ", ")))
		}
	}

	logInfo(fmt.Sprintf("%s running...", cfg.Backend))

	taskSpec := taskSpec{
		Task:                 taskText,
		WorkDir:              cfg.WorkDir,
		Mode:                 cfg.Mode,
		SessionID:            cfg.SessionID,
		UseStdin:             useStdin,
		ClaudeModel:          cfg.ClaudeModel,
		ClaudeEffort:         cfg.ClaudeEffort,
		NoSessionPersistence: cfg.NoSessionPersistence,
		GrokModel:            cfg.GrokModel,
		KimiModel:            cfg.KimiModel,
		OpencodeModel:        cfg.OpencodeModel,
		Progress:             cfg.Progress,
		WithMCP:              cfg.WithMCP,
		Backend:              cfg.Backend,
	}

	result := runTaskFn(taskSpec, false, cfg.Timeout)

	if result.ExitCode != 0 {
		return result.ExitCode
	}

	if _, err := fmt.Println(result.Message); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
	if result.SessionID != "" && !cfg.NoSessionPersistence {
		if _, err := fmt.Printf("\n---\nSESSION_ID: %s\n", result.SessionID); err != nil {
			logWarn("I/O operation failed: " + err.Error())
		}
	}

	// CRITICAL: Windows-specific fix for Git Bash background process output capture
	// Git Bash may buffer stdout when running in background mode, causing incomplete output
	if isWindows() {
		_ = os.Stdout.Sync()
	}

	return 0
}

func setLogger(l *fileLogger) {
	loggerPtr.Store(l)
}

func closeLogger() error {
	logger := loggerPtr.Swap(nil)
	if logger == nil {
		return nil
	}
	return logger.Close()
}

func activeLogger() *fileLogger {
	return loggerPtr.Load()
}

func logInfo(msg string) {
	if logger := activeLogger(); logger != nil {
		logger.info(msg)
	}
}

func logWarn(msg string) {
	if logger := activeLogger(); logger != nil {
		logger.warn(msg)
	}
}

func logError(msg string) {
	if logger := activeLogger(); logger != nil {
		logger.error(msg)
	}
}

func runCleanupHook() {
	if logger := activeLogger(); logger != nil {
		logger.Flush()
	}
	if cleanupHook != nil {
		cleanupHook()
	}
}

func printHelp() {
	name := currentWrapperName()
	help := fmt.Sprintf(
		`%[1]s - Go wrapper for AI CLI backends

Usage:
    %[1]s "task" [workdir]
    %[1]s --backend claude "task" [workdir]
    %[1]s --backend antigravity "task" [workdir]
    %[1]s --backend antigravity - [workdir] <<'EOF'
    %[1]s --lite "task" [workdir]     Lite mode is already the default
    %[1]s - [workdir]              Read task from stdin
    %[1]s resume <session_id> "task" [workdir]
    %[1]s resume <session_id> - [workdir]
    %[1]s --parallel               Run tasks in parallel (config from stdin)
    %[1]s --parallel --full-output Run tasks in parallel with full output (legacy)
    %[1]s --version
    %[1]s --help

Parallel mode examples:
    %[1]s --parallel < tasks.txt
    echo '...' | %[1]s --parallel
    %[1]s --parallel --full-output < tasks.txt
    %[1]s --parallel <<'EOF'

Options:
    --lite, -L            Lite mode is default: disable Web UI, faster response
    --backend <name>      Select backend (codex, antigravity, agy, claude, grok, kimi, opencode)
                          Gemini CLI is disabled because consumer OAuth requests stopped after 2026-06-18
                          Do not pass backend CLI flags like --add-dir or -p to wrapper
    --claude-model <name> Use this model for the Claude backend
    --claude-effort <n>   Set Claude effort (low, medium, high, xhigh, max)
    --grok-model <name>   Use this model for the Grok backend
    --kimi-model <name>   Use this model for the Kimi Code backend
    --opencode-model <provider/model>
                          Use this provider/model for the OpenCode backend
    --no-session-persistence
                          Run the Claude print-mode task without persisting a session; incompatible with resume
    --progress            Emit compact progress lines to stderr during execution
    --with-mcp            Let the sub-agent load configured MCP servers (off by default)

Environment Variables:
    CODEX_TIMEOUT              Timeout in milliseconds (default: 7200000)
    CODEX_REQUIRE_APPROVAL     Require manual approval for file operations (default: false)
    CODEX_DISABLE_SKIP_GIT_CHECK  Disable skip-git-repo-check flag (default: false)
    CLAUDE_MODEL               Default model for the Claude backend
    CLAUDE_EFFORT              Default effort for the Claude backend
    GROK_MODEL                 Default model for the Grok backend
    KIMI_MODEL                 Default model for the Kimi Code backend
    OPENCODE_MODEL             Default provider/model for the OpenCode backend
    CODEAGENT_ASCII_MODE       Use ASCII symbols instead of Unicode (PASS/WARN/FAIL)
    CODEAGENT_LITE_MODE        Lite mode is default; set false to enable Web UI

Exit Codes:
    0    Success
    1    General error (missing args, no output)
    124  Timeout
    127  backend command not found
    130  Interrupted (Ctrl+C)
    *    Passthrough from backend process`, name,
	)
	if _, err := fmt.Println(help); err != nil {
		logWarn("I/O operation failed: " + err.Error())
	}
}
