package main

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "ccg-wrapper-test-home-")
	if err != nil {
		panic(fmt.Errorf("create isolated test home: %w", err))
	}
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if err := os.Setenv(key, home); err != nil {
			panic(fmt.Errorf("isolate test home: %w", err))
		}
	}
	code := m.Run()
	if err := os.RemoveAll(home); err != nil {
		panic(fmt.Errorf("remove isolated test home: %w", err))
	}
	os.Exit(code)
}
