//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func isolateProcessGroup(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.Cancel != nil {
		cmd.Cancel = func() error {
			if cmd.Process == nil {
				return os.ErrProcessDone
			}
			if err := killProcessTree(cmd.Process.Pid); err != nil {
				return err
			}
			return nil
		}
	}
}

func killProcessGroup(pid int, sig syscall.Signal) error {
	return errors.New("process groups are not supported on windows")
}
