//go:build windows

package main

import (
	"fmt"
	"syscall"
)

func sendTestSignal(int, syscall.Signal) error {
	return fmt.Errorf("signals are not supported on windows")
}
