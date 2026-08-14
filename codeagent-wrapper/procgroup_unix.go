//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func isolateProcessGroup(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.SysProcAttr.Pgid = 0
	if cmd.Cancel != nil {
		cmd.Cancel = func() error {
			if cmd.Process == nil {
				return os.ErrProcessDone
			}
			if err := killProcessGroup(cmd.Process.Pid, syscall.SIGTERM); err != nil {
				if err == syscall.ESRCH {
					return os.ErrProcessDone
				}
				return err
			}
			return nil
		}
	}
}

func killProcessGroup(pid int, sig syscall.Signal) error {
	if pid <= 0 {
		return syscall.ESRCH
	}
	return syscall.Kill(-pid, sig)
}
