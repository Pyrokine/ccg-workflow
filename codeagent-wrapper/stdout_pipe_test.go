package main

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"
)

func TestExecutorStdinWriteFailure(t *testing.T) {
	reader, writer := io.Pipe()
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(
		func() {
			if err := writer.Close(); err != nil {
				t.Errorf("close input pipe: %v", err)
			}
		},
	)
	original := newCommandRunner
	t.Cleanup(func() { newCommandRunner = original })
	newCommandRunner = func(context.Context, string, ...string) commandRunner {
		return &execFakeRunner{
			stdout: newReasonReadCloser(
				`{"type":"item.completed","item":{"type":"agent_message","text":"partial output"}}`,
			),
			stdin:   writer,
			process: &execFakeProcess{pid: 1234},
		}
	}
	result := runCodexTaskWithContext(
		t.Context(), taskSpec{
			ID: "stdin-write", Task: "payload", WorkDir: ".", Backend: "codex", UseStdin: true,
		}, nil, nil, false, false, 5,
	)
	if result.ExitCode != 1 || result.Error != "failed to write task input: "+io.ErrClosedPipe.Error() ||
		result.Message != "partial output" {
		t.Fatalf("result=%+v", result)
	}
}

func TestStdoutPipeDrain(t *testing.T) {
	for _, buffered := range []bool{true, false} {
		name := "blocked read"
		if buffered {
			name = "buffered output after parsing delay"
		}
		t.Run(
			name, func(t *testing.T) {
				reader, writer, err := os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(
					func() {
						for _, file := range []*os.File{reader, writer} {
							if err := file.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
								t.Errorf("close pipe: %v", err)
							}
						}
					},
				)
				if err := reader.SetReadDeadline(time.Time{}); err != nil {
					t.Skipf("pipe read deadlines are unavailable: %v", err)
				}
				if buffered {
					if _, err := io.WriteString(writer, "complete output"); err != nil {
						t.Fatal(err)
					}
					if err := writer.Close(); err != nil {
						t.Fatal(err)
					}
				}
				pipe := &stdoutPipe{file: reader}
				if err := pipe.drain(); err != nil {
					t.Fatal(err)
				}
				if buffered {
					time.Sleep(2 * stdoutDrainTimeout)
				}
				output, err := io.ReadAll(pipe)
				if buffered {
					if err != nil || string(output) != "complete output" {
						t.Fatalf("output=%q error=%v", output, err)
					}
				} else if !errors.Is(err, os.ErrDeadlineExceeded) {
					t.Fatalf("error=%v, want a blocked-read deadline", err)
				}
			},
		)
	}
}
