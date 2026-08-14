//go:build !windows

package main

import (
	"bufio"
	"context"
	"errors"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestIsolateProcessGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "true")
	isolateProcessGroup(cmd)

	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid || cmd.SysProcAttr.Pgid != 0 {
		t.Fatalf("SysProcAttr = %#v, want Setpgid with Pgid 0", cmd.SysProcAttr)
	}
	if cmd.Cancel == nil {
		t.Fatal("Cancel is nil, want process-group termination callback")
	}
}

func TestKillProcessGroup(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	isolateProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start helper: %v", err)
	}
	defer func() { _ = cmd.Wait() }()

	pid := cmd.Process.Pid
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		t.Fatalf("Getpgid(%d): %v", pid, err)
	}
	if pgid != pid {
		t.Fatalf("pgid = %d, want %d", pgid, pid)
	}
	if ownPgid, err := syscall.Getpgid(0); err == nil && ownPgid == pgid {
		t.Fatalf("child shares the wrapper process group %d", pgid)
	}
	if err := killProcessGroup(pid, syscall.SIGKILL); err != nil {
		t.Fatalf("killProcessGroup(%d): %v", pid, err)
	}
}

func TestCommandContextCancellationTerminatesProcessGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", "sleep 30 & printf '%s\\n' \"$!\"; wait")
	isolateProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatalf("read child PID: %v", scanner.Err())
	}
	childPID, err := strconv.Atoi(scanner.Text())
	if err != nil {
		t.Fatalf("parse child PID: %v", err)
	}

	cancel()
	_ = cmd.Wait()

	deadline := time.Now().Add(time.Second)
	for {
		err = syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("child process %d remains after cancellation: %v", childPID, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestKillProcessGroupRejectsInvalidPID(t *testing.T) {
	if err := killProcessGroup(0, syscall.SIGTERM); err == nil {
		t.Fatal("killProcessGroup accepted pid 0")
	}
}
