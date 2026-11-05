package main

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestFilteringWriter(t *testing.T) {
	tests := []struct {
		name     string
		patterns []string
		input    string
		want     string
	}{
		{
			name:     "filter STARTUP lines",
			patterns: noisePatterns,
			input:    "[STARTUP] Recording metric\nHello World\n[STARTUP] Another line\n",
			want:     "Hello World\n",
		},
		{
			name:     "filter Warning lines",
			patterns: noisePatterns,
			input:    "Warning: something bad\nActual output\n",
			want:     "Actual output\n",
		},
		{
			name:     "filter multiple patterns",
			patterns: noisePatterns,
			input:    "YOLO mode is enabled\nSession cleanup disabled\nReal content\nLoading extension: foo\n",
			want:     "Real content\n",
		},
		{
			name:     "no filtering needed",
			patterns: noisePatterns,
			input:    "Line 1\nLine 2\nLine 3\n",
			want:     "Line 1\nLine 2\nLine 3\n",
		},
		{
			name:     "empty input",
			patterns: noisePatterns,
			input:    "",
			want:     "",
		},
	}

	for _, tt := range tests {
		t.Run(
			tt.name, func(t *testing.T) {
				var buf bytes.Buffer
				fw := newFilteringWriter(&buf, tt.patterns)
				if _, err := fw.Write([]byte(tt.input)); err != nil {
					t.Fatalf("Write: %v", err)
				}
				if err := fw.Flush(); err != nil {
					t.Fatalf("Flush: %v", err)
				}
				if got := buf.String(); got != tt.want {
					t.Errorf("got %q, want %q", got, tt.want)
				}
			},
		)
	}
}

func TestFilteringWriterPartialLines(t *testing.T) {
	var buf bytes.Buffer
	fw := newFilteringWriter(&buf, noisePatterns)

	// Write partial line
	if _, err := fw.Write([]byte("Hello ")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := fw.Write([]byte("World\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := fw.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if got := buf.String(); got != "Hello World\n" {
		t.Errorf("got %q, want %q", got, "Hello World\n")
	}
}

func TestFilteringWriterPropagatesWriteErrors(t *testing.T) {
	for _, flush := range []bool{false, true} {
		t.Run(
			map[bool]string{false: "Write", true: "Flush"}[flush], func(t *testing.T) {
				reader, writer := io.Pipe()
				if err := reader.Close(); err != nil {
					t.Fatalf("close reader: %v", err)
				}
				t.Cleanup(
					func() {
						if err := writer.Close(); err != nil {
							t.Errorf("close writer: %v", err)
						}
					},
				)
				filter := newFilteringWriter(writer, nil)
				text := "visible output\n"
				if flush {
					text = "visible output"
				}
				_, err := filter.Write([]byte(text))
				if flush {
					if err != nil {
						t.Fatalf("buffer partial output: %v", err)
					}
					err = filter.Flush()
				}
				if !errors.Is(err, io.ErrClosedPipe) {
					t.Fatalf("error = %v, want closed pipe", err)
				}
			},
		)
	}
}
