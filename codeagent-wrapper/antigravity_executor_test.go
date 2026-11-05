package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

func TestParseAntigravityStream_ReadFailure(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input io.Reader
		want  string
	}{
		{
			name: "reader error",
			input: io.MultiReader(
				strings.NewReader(agyStreamSample),
				iotest.ErrReader(errors.New("reader failed")),
			),
			want: "reader failed",
		},
		{
			name:  "line limit",
			input: strings.NewReader(agyStreamSample + strings.Repeat("x", 11*1024*1024)),
			want:  "token too long",
		},
	} {
		t.Run(
			tc.name, func(t *testing.T) {
				msg, id, failure := parseAntigravityStream(tc.input, agyStreamHandlers{})
				if msg != "Found 3 bugs." || id != "602e61bb-d2a0" || !strings.Contains(failure, tc.want) {
					t.Fatalf("result = (%q, %q, %q)", msg, id, failure)
				}
			},
		)
	}
}

func TestAntigravityExecutor_StreamResult(t *testing.T) {
	original := newCommandRunner
	t.Cleanup(func() { newCommandRunner = original })
	for _, tc := range []struct {
		name   string
		stream string
		failed bool
	}{
		{"success", agyStreamSample, false},
		{
			"error with response",
			`{"event":"result","result":{"conversation_id":"failed-id","status":"ERROR","response":"partial text","error":"quota exhausted"}}`,
			true,
		},
		{"oversized stream", agyStreamSample + strings.Repeat("x", 11*1024*1024), true},
	} {
		t.Run(
			tc.name, func(t *testing.T) {
				newCommandRunner = func(context.Context, string, ...string) commandRunner {
					return &execFakeRunner{stdout: newReasonReadCloser(tc.stream), process: &execFakeProcess{pid: 1234}}
				}
				result := runCodexTaskWithContext(
					context.Background(), taskSpec{
						ID: "agy-stream", Task: "task", WorkDir: ".", Backend: "agy",
					}, antigravityBackend{}, nil, false, false, 5,
				)
				if (result.ExitCode != 0) != tc.failed || result.SessionID == "" {
					t.Fatalf("result = %+v", result)
				}
				if tc.failed && result.Error == "" {
					t.Fatalf("failure has no diagnostic: %+v", result)
				}
				if !tc.failed && result.Message != "Found 3 bugs." {
					t.Fatalf("message = %q", result.Message)
				}
			},
		)
	}
}

func TestExecutorRealPipe(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh is unavailable")
	}
	original := newCommandRunner
	t.Cleanup(func() { newCommandRunner = original })
	for _, tc := range []struct {
		backend string
		delta   string
		result  string
	}{
		{
			backend: "agy",
			delta:   "{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"agent_response\",\"text_delta\":\"chunk\"}}\n",
			result:  agyStreamSample,
		},
		{
			backend: "codex",
			delta:   "{\"type\":\"progress\"}\n",
			result: "{\"type\":\"thread.started\",\"thread_id\":\"602e61bb-d2a0\"}\n" +
				"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Found 3 bugs.\"}}\n" +
				"{\"type\":\"turn.completed\"}\n",
		},
	} {
		for _, count := range []int{1, 8192} {
			t.Run(
				fmt.Sprintf("%s/events-%d", tc.backend, count), func(t *testing.T) {
					file := filepath.Join(t.TempDir(), "events.jsonl")
					stream := strings.Repeat(tc.delta, count) + tc.result
					if err := writeTestFile(file, []byte(stream)); err != nil {
						t.Fatalf("write stream: %v", err)
					}
					newCommandRunner = func(ctx context.Context, _ string, _ ...string) commandRunner {
						return &realCmd{cmd: exec.CommandContext(ctx, "sh", "-c", `cat "$1"`, "sh", file)}
					}
					result := runCodexTaskWithContext(
						t.Context(), taskSpec{
							ID: "real-pipe", Task: "task", WorkDir: ".", Backend: tc.backend,
						}, nil, nil, false, false, 5,
					)
					if result.ExitCode != 0 || result.Message != "Found 3 bugs." || result.SessionID != "602e61bb-d2a0" {
						t.Fatalf(
							"exit=%d messageBytes=%d session=%q error=%q", result.ExitCode, len(result.Message),
							result.SessionID, result.Error,
						)
					}
				},
			)
		}
	}
}

func TestExecutorRealPipeCancelledWhileDraining(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX shell")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh is unavailable")
	}
	original := newCommandRunner
	t.Cleanup(func() { newCommandRunner = original })
	file := filepath.Join(t.TempDir(), "events.jsonl")
	if err := writeTestFile(file, []byte(agyStreamSample)); err != nil {
		t.Fatal(err)
	}
	newCommandRunner = func(ctx context.Context, _ string, _ ...string) commandRunner {
		command := `(cat "$1"; while printf '%s\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"chunk"}}'; do sleep 0.01; done) 2>/dev/null &`
		return &realCmd{cmd: exec.CommandContext(ctx, "sh", "-c", command, "sh", file)}
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	result := runCodexTaskWithContext(
		ctx, taskSpec{
			ID: "drain-cancel", Task: "task", WorkDir: ".", Backend: "agy",
		}, nil, nil, false, false, 5,
	)
	if result.ExitCode != 124 || result.SessionID != "602e61bb-d2a0" {
		t.Fatalf("exit=%d session=%q error=%q", result.ExitCode, result.SessionID, result.Error)
	}
}

func TestAntigravityPTYRetry_Cancelled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY retry is unavailable on Windows")
	}
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("script is unavailable")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := runAntigravityPTYRetry(ctx, "printf", []string{"text"}, ".", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
}

func TestAntigravityPTYRetry_StreamResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY retry is unavailable on Windows")
	}
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("script is unavailable")
	}
	for _, tc := range []struct {
		name   string
		stream string
		failed bool
	}{
		{"success", agyStreamSample, false},
		{
			"error with response",
			`{"event":"result","result":{"conversation_id":"failed-id","status":"ERROR","response":"partial text","error":"quota exhausted"}}`,
			true,
		},
		{"oversized stream", agyStreamSample + strings.Repeat("x", 11*1024*1024), true},
	} {
		t.Run(
			tc.name, func(t *testing.T) {
				file := t.TempDir() + "/stream.jsonl"
				if err := writeTestFile(file, []byte(tc.stream)); err != nil {
					t.Fatalf("write stream fixture: %v", err)
				}
				result, err := runAntigravityPTYRetry(context.Background(), "cat", []string{file}, ".", nil)
				if (err != nil) != tc.failed || result.threadID == "" {
					t.Fatalf("result = %+v, error = %v", result, err)
				}
				if !tc.failed && result.message != "Found 3 bugs." {
					t.Fatalf("message = %q", result.message)
				}
			},
		)
	}
}
