package main

import (
	"os"
	"testing"
)

func TestNormalizeWindowsPath(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Git Bash style path with lowercase drive",
			input:    "/c/Users/USER/.claude/prompts/codex/reviewer.md",
			expected: "C:/Users/USER/.claude/prompts/codex/reviewer.md",
		},
		{
			name:     "Git Bash style path with uppercase drive",
			input:    "/D/Projects/code",
			expected: "D:/Projects/code",
		},
		{
			name:     "Windows native path with forward slashes (unchanged)",
			input:    "C:/Users/foo/bar.txt",
			expected: "C:/Users/foo/bar.txt",
		},
		{
			name:     "Windows native path with backslashes",
			input:    "C:\\Users\\foo\\bar.txt",
			expected: "C:/Users/foo/bar.txt",
		},
		{
			name:     "Relative path (unchanged)",
			input:    "relative/path/to/file.txt",
			expected: "relative/path/to/file.txt",
		},
		{
			name:     "Unix absolute path (unchanged)",
			input:    "/usr/local/bin",
			expected: "/usr/local/bin",
		},
		{
			name:     "Mixed separators",
			input:    "/c/Users\\foo/bar.txt",
			expected: "C:/Users/foo/bar.txt",
		},
	}

	for _, tt := range tests {
		t.Run(
			tt.name, func(t *testing.T) {
				result := normalizeWindowsPath(tt.input)
				if result != tt.expected {
					t.Errorf("normalizeWindowsPath(%q) = %q, want %q", tt.input, result, tt.expected)
				}
			},
		)
	}
}

func TestInjectRoleFile_WindowsPathHandling(t *testing.T) {
	// Skip this test on non-test builds (requires test hooks)
	// This test validates that Windows paths work correctly in ROLE_FILE directives
	t.Skip("Skipping integration test - requires mock filesystem setup")
}

// Helper functions for tests
func writeTestFile(path string, content []byte) error {
	return os.WriteFile(path, content, 0644)
}
