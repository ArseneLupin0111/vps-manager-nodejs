package logs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testFullID() string { return strings.Repeat("a", 64) }

func TestDockerSource_OpenFollowBodySurvivesHeaderBound(t *testing.T) {
	payload := frame(streamIDStdout, []byte("live line\n"))
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			w.WriteHeader(http.StatusOK)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			// Headers are already delivered; the body arrives after the
			// configured header bound. A header-scoped context would have
			// cancelled the body before this write.
			time.Sleep(150 * time.Millisecond)
			w.Write(payload)
			return
		}
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	src, err := NewDockerSourceWithTimeout(srv.Client(), srv.URL, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("NewDockerSourceWithTimeout: %v", err)
	}
	resp, err := src.OpenFollow(context.Background(), testFullID())
	if err != nil {
		t.Fatalf("OpenFollow: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("body read after header bound: %v", err)
	}
	if !strings.Contains(string(body), "live line") {
		t.Fatalf("body = %q, want live line", body)
	}
}

func TestDockerSource_OpenFollowCancelUnblocksBody(t *testing.T) {
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			w.WriteHeader(http.StatusOK)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			<-release
			return
		}
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { close(release); srv.Close() })

	src, err := NewDockerSourceWithTimeout(srv.Client(), srv.URL, 5*time.Second)
	if err != nil {
		t.Fatalf("NewDockerSourceWithTimeout: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := src.OpenFollow(ctx, testFullID())
	if err != nil {
		t.Fatalf("OpenFollow: %v", err)
	}
	defer resp.Body.Close()
	cancel()
	// The body lives on the subscription context, so cancelling must
	// unblock a pending read.
	buf := make([]byte, 1)
	done := make(chan error, 1)
	go func() {
		_, err := resp.Body.Read(buf)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("read after cancel succeeded, want error")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("body read still blocked after subscription cancel")
	}
}

func TestDockerSource_OpenFollowHeaderTimeoutBounded(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			time.Sleep(500 * time.Millisecond)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	src, err := NewDockerSourceWithTimeout(srv.Client(), srv.URL, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("NewDockerSourceWithTimeout: %v", err)
	}
	start := time.Now()
	_, err = src.OpenFollow(context.Background(), testFullID())
	elapsed := time.Since(start)
	if err == nil {
		t.Fatalf("expected header timeout error")
	}
	var se *SourceError
	if !errors.As(err, &se) || se.Code != ErrDaemonUnreachable {
		t.Fatalf("err = %v, want %q", err, ErrDaemonUnreachable)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("header timeout took %v, want bounded", elapsed)
	}
}

func TestDockerSource_InspectStalledHeadersBounded(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			time.Sleep(500 * time.Millisecond)
			fmt.Fprintf(w, `{"Config":{"Tty":false}}`)
			return
		}
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	src, err := NewDockerSourceWithTimeout(srv.Client(), srv.URL, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("NewDockerSourceWithTimeout: %v", err)
	}
	start := time.Now()
	_, err = src.InspectTTY(context.Background(), testFullID())
	elapsed := time.Since(start)
	if err == nil {
		t.Fatalf("expected inspect timeout error")
	}
	var se *SourceError
	if !errors.As(err, &se) || se.Code != ErrDaemonUnreachable {
		t.Fatalf("err = %v, want %q", err, ErrDaemonUnreachable)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("inspect header stall took %v, want bounded", elapsed)
	}
}

func TestDockerSource_InspectStalledBodyBounded(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(500 * time.Millisecond)
			fmt.Fprintf(w, `{"Config":{"Tty":false}}`)
			return
		}
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	src, err := NewDockerSourceWithTimeout(srv.Client(), srv.URL, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("NewDockerSourceWithTimeout: %v", err)
	}
	start := time.Now()
	_, err = src.InspectTTY(context.Background(), testFullID())
	elapsed := time.Since(start)
	if err == nil {
		t.Fatalf("expected inspect body timeout error")
	}
	var se *SourceError
	if !errors.As(err, &se) || se.Code != ErrDaemonUnreachable {
		t.Fatalf("err = %v, want %q", err, ErrDaemonUnreachable)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("inspect body stall took %v, want bounded", elapsed)
	}
}
