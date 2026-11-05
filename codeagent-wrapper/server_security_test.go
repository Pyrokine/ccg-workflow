package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBrowserMode_DefaultsToExternalBrowser(t *testing.T) {
	for _, v := range []string{"", "default", "DEFAULT", "  default ", "unknown-value"} {
		t.Setenv("CODEAGENT_BROWSER", v)
		if got := browserMode(); got != browserModeDefault {
			t.Fatalf("CODEAGENT_BROWSER=%q: mode = %q, want %q", v, got, browserModeDefault)
		}
	}
}

func TestBrowserMode_Builtin(t *testing.T) {
	for _, v := range []string{"builtin", "BUILTIN", " builtin "} {
		t.Setenv("CODEAGENT_BROWSER", v)
		if got := browserMode(); got != browserModeBuiltin {
			t.Fatalf("CODEAGENT_BROWSER=%q: mode = %q, want %q", v, got, browserModeBuiltin)
		}
	}
}

func TestWebUIBanner(t *testing.T) {
	if got := webUIBanner("http://localhost:1234", browserModeBuiltin); !strings.Contains(got, "builtin browser") {
		t.Fatalf("builtin banner = %q", got)
	}
	if got := webUIBanner("http://localhost:1234", browserModeDefault); got != "  Web UI: http://localhost:1234\n" {
		t.Fatalf("default banner changed: %q", got)
	}
}

func TestWebServerStart_BindsLoopbackOnly(t *testing.T) {
	t.Setenv("CODEAGENT_BROWSER", browserModeBuiltin) // don't pop a real browser during tests
	ws := newWebServer("codex")
	if err := ws.start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(
		func() {
			if err := ws.stop(); err != nil {
				t.Errorf("Stop: %v", err)
			}
		},
	)

	host, _, err := net.SplitHostPort(ws.listenAddr)
	if err != nil {
		t.Fatalf("listenAddr %q: %v", ws.listenAddr, err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		t.Fatalf("web UI listens on %q, want a loopback address", ws.listenAddr)
	}
}

func TestWebServerStopClosesActiveStream(t *testing.T) {
	ws := newWebServer("codex")
	ws.server = &http.Server{}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		request := httptest.NewRequest(http.MethodGet, "/api/stream/active", nil).WithContext(ctx)
		ws.handleStream(httptest.NewRecorder(), request)
	}()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		ws.mu.RLock()
		registered := len(ws.clients["active"]) == 1
		ws.mu.RUnlock()
		if registered {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("stream did not register")
		case <-ticker.C:
		}
	}
	if err := ws.stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("stream did not exit after shutdown")
	}
}

func TestRequireLocalHost(t *testing.T) {
	handler := requireLocalHost(
		http.HandlerFunc(
			func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			},
		),
	)
	cases := map[string]int{
		"localhost:1234":    http.StatusOK,
		"LOCALHOST:1234":    http.StatusOK,
		"localhost":         http.StatusOK,
		"127.0.0.1:1234":    http.StatusOK,
		"[::1]:1234":        http.StatusOK,
		"[::1]":             http.StatusOK,
		"evil.example:1234": http.StatusForbidden,
		"evil.example":      http.StatusForbidden,
		"localhost.evil.io": http.StatusForbidden,
		"192.168.1.20:1234": http.StatusForbidden,
		"":                  http.StatusForbidden,
	}
	for host, want := range cases {
		req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("Host %q: status %d, want %d", host, rec.Code, want)
		}
	}
}

func TestHandleStream_NoCrossOriginAccess(t *testing.T) {
	ws := newWebServer("codex")
	ws.startSession("s1", "codex", "task")
	ws.endSession("s1", "codex")

	rec := httptest.NewRecorder()
	ws.handleStream(rec, httptest.NewRequest(http.MethodGet, "/api/stream/s1", nil))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, the page is same-origin", got)
	}
}

// Task text comes from prompts and repository content, so the page must never
// parse it as HTML.
func TestIndexPage_RendersTaskAsText(t *testing.T) {
	page := newWebServer("codex").generateIndexHTML()
	if strings.Contains(page, "innerHTML") {
		t.Fatal("index page uses innerHTML")
	}
	if !strings.Contains(page, "taskBody.textContent = session.task") {
		t.Fatal("index page does not render the task as text")
	}
}
