package main

import (
	"testing"
)

// BenchmarkLoggerWrite 测试日志写入性能
func BenchmarkLoggerWrite(b *testing.B) {
	logger, err := newLogger()
	if err != nil {
		b.Fatal(err)
	}
	defer func() {
		if err := logger.Close(); err != nil {
			b.Errorf("I/O operation failed: %v", err)
		}
	}()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		logger.info("benchmark log message")
	}
	b.StopTimer()
	logger.Flush()
}

// BenchmarkLoggerConcurrentWrite 测试并发日志写入性能
func BenchmarkLoggerConcurrentWrite(b *testing.B) {
	logger, err := newLogger()
	if err != nil {
		b.Fatal(err)
	}
	defer func() {
		if err := logger.Close(); err != nil {
			b.Errorf("I/O operation failed: %v", err)
		}
	}()

	b.ResetTimer()
	b.RunParallel(
		func(pb *testing.PB) {
			for pb.Next() {
				logger.info("concurrent benchmark log message")
			}
		},
	)
	b.StopTimer()
	logger.Flush()
}
