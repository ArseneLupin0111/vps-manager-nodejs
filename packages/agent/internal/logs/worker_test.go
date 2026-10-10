package logs

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTransport records what the worker sends and how it answers.
type fakeTransport struct {
	mu                   sync.Mutex
	claims               []string
	chunks               []ChunksRequest
	results              []ResultRequest
	claimSub             *ClaimedSubscription
	claimErr             error
	chunksErr            error
	chunksErrAt          int
	delayBeforeChunksErr time.Duration
	resultErr            error
	failEcho             bool
}

func (f *fakeTransport) Claim(ctx context.Context, agentInstanceID string) (*ClaimedSubscription, error) {
	f.mu.Lock()
	f.claims = append(f.claims, agentInstanceID)
	f.mu.Unlock()
	return f.claimSub, f.claimErr
}

func (f *fakeTransport) PostChunks(ctx context.Context, subscriptionID string, req ChunksRequest) (ChunksResponse, error) {
	f.mu.Lock()
	f.chunks = append(f.chunks, req)
	delay := f.delayBeforeChunksErr
	f.mu.Unlock()
	// A delayed failure models the API dying mid-stream: the reader has
	// already handed over its batches, so the loss can only surface while
	// the tail is being drained.
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ChunksResponse{}, ctx.Err()
		}
	}
	if f.chunksErr != nil && (f.chunksErrAt == 0 || f.chunksErrAt == len(f.chunks)) {
		return ChunksResponse{}, f.chunksErr
	}
	seq := req.Sequence
	if f.failEcho {
		seq = req.Sequence + 50
	}
	return ChunksResponse{Data: ChunksResponseData{OK: true, SubscriptionID: subscriptionID, Sequence: seq}}, nil
}

func (f *fakeTransport) PostResult(ctx context.Context, subscriptionID string, req ResultRequest) (ResultResponse, error) {
	f.mu.Lock()
	f.results = append(f.results, req)
	f.mu.Unlock()
	if f.resultErr != nil {
		return ResultResponse{}, f.resultErr
	}
	return ResultResponse{Data: ResultResponseData{OK: true, SubscriptionID: subscriptionID, AgentInstanceID: req.AgentInstanceID}}, nil
}

func (f *fakeTransport) allLines() []LogLine {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []LogLine
	for _, c := range f.chunks {
		out = append(out, c.Lines...)
	}
	return out
}

// closeTrackingBody records Close() and refuses further reads.
type closeTrackingBody struct {
	inner  io.Reader
	closes int
	mu     sync.Mutex
}

func (c *closeTrackingBody) Read(p []byte) (int, error) {
	c.mu.Lock()
	closed := c.closes
	inner := c.inner
	c.mu.Unlock()
	// The lock is not held while reading: a blocking Read would otherwise
	// make Close — which the worker must be able to call concurrently to
	// unblock the reader — wait forever on the same mutex.
	if closed > 0 {
		return 0, io.ErrClosedPipe
	}
	return inner.Read(p)
}

func (c *closeTrackingBody) Close() error {
	c.mu.Lock()
	c.closes++
	inner := c.inner
	c.mu.Unlock()
	// Forward to the underlying reader so a read blocked inside it — the
	// real Docker follow body, or a test double standing in for one — is
	// woken instead of leaving the reader goroutine stuck forever.
	if cl, ok := inner.(io.Closer); ok {
		return cl.Close()
	}
	return nil
}

func (c *closeTrackingBody) CloseCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closes
}

// fakeDockerSource implements DockerSourcePort.
type fakeDockerSource struct {
	mu         sync.Mutex
	tty        bool
	inspectErr error
	opens      int
	openErr    error
	body       io.Reader
	lastID     string
	followBody func() io.Reader
}

func (d *fakeDockerSource) InspectTTY(ctx context.Context, fullID string) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.inspectErr != nil {
		return false, d.inspectErr
	}
	return d.tty, nil
}

func (d *fakeDockerSource) OpenFollow(ctx context.Context, fullID string) (FollowResponse, error) {
	d.mu.Lock()
	d.opens++
	d.lastID = fullID
	d.mu.Unlock()
	if d.openErr != nil {
		return nil, d.openErr
	}
	var r io.Reader
	if d.followBody != nil {
		r = d.followBody()
	} else {
		r = d.body
	}
	return httpFollowResponse{body: &closeTrackingBody{inner: r}}, nil
}

func (d *fakeDockerSource) OpenCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.opens
}

func workerSub() *ClaimedSubscription {
	return &ClaimedSubscription{
		SubscriptionID:  testSubID(),
		VpsID:           "vps-1",
		AgentInstanceID: "testinst000000000000000000000001",
		ContainerKey:    "ckey0001",
		TailLines:       TailLines,
		ExpiresAt:       time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	}
}

func newFakeWorker(t *testing.T, deps *StreamDeps) *Worker {
	t.Helper()
	inst := "testinst000000000000000000000001"
	w, err := NewWorker(inst, *deps, DefaultWorkerOptions())
	if err != nil {
		t.Fatalf("NewWorker: %v", err)
	}
	return w
}

func TestWorker_CleanEOFCompletes(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	body := frame(streamIDStdout, []byte("line one\nline two\n"))
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(body))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	if !errors.Is(err, ErrCompleted) {
		t.Fatalf("expected ErrCompleted, got %v", err)
	}
	got := tr.allLines()
	if len(got) != 2 || got[0].Text != "line one" || got[1].Text != "line two" {
		t.Fatalf("unexpected lines: %#v", got)
	}
	for _, l := range got {
		if l.Stream != StreamStdout {
			t.Fatalf("stream = %q, want stdout", l.Stream)
		}
	}
	if len(tr.results) != 1 || tr.results[0].Status != ResultCompleted {
		t.Fatalf("want one completed result, got %#v", tr.results)
	}
	if src.OpenCount() != 1 {
		t.Fatalf("follow opened %d times, want exactly 1", src.OpenCount())
	}
}

func TestWorker_StandaloneFrame(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	raw := make([]byte, 8+5)
	raw[0] = streamIDStdout
	binary.BigEndian.PutUint32(raw[4:], 5)
	copy(raw[8:], []byte("hello"))
	src := &fakeDockerSource{body: strings.NewReader(string(raw))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	if !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v, want ErrCompleted", err)
	}
	got := tr.allLines()
	if len(got) != 1 || got[0].Text != "hello" {
		t.Fatalf("lines = %#v", got)
	}
}

func TestWorker_ResolverMissTargetMismatch(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{body: strings.NewReader("")}
	resolve := func(key string) (string, bool) { return "", false }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	var te *terminalError
	if !errors.As(err, &te) || te.code != ErrTargetMismatch {
		t.Fatalf("code = %v, want %s", err, ErrTargetMismatch)
	}
	if src.OpenCount() != 0 {
		t.Fatalf("follow opened %d times after resolver miss", src.OpenCount())
	}
}

func TestWorker_Daemon404ContainerNotFound(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{inspectErr: &SourceError{Code: ErrContainerNotFound}}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrContainerNotFound)
}

func TestWorker_DaemonConnectErrorUnreachable(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{inspectErr: &SourceError{Code: ErrDaemonUnreachable}}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrDaemonUnreachable)
}

func TestWorker_Daemon5xxLogsUnavailable(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{inspectErr: &SourceError{Code: ErrLogsUnavailable}}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrLogsUnavailable)
}

func TestWorker_MalformedFrameInvalidStream(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	bad := []byte{0x09, 0, 0, 0, 0, 0, 0, 1, 'x'}
	src := &fakeDockerSource{body: strings.NewReader(string(bad))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrInvalidStream)
}

func TestWorker_StdoutStderrInterleavedOrdered(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	buf := frame(streamIDStdout, []byte("out1\n"))
	buf = append(buf, frame(streamIDStderr, []byte("err1\n"))...)
	buf = append(buf, frame(streamIDStdout, []byte("out2\n"))...)
	src := &fakeDockerSource{body: strings.NewReader(string(buf))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v, want ErrCompleted", err)
	}
	got := tr.allLines()
	want := []LogLine{
		{Stream: StreamStdout, Text: "out1"},
		{Stream: StreamStderr, Text: "err1"},
		{Stream: StreamStdout, Text: "out2"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d lines: %#v", len(got), got)
	}
	for i := range want {
		if got[i].Stream != want[i].Stream || got[i].Text != want[i].Text {
			t.Fatalf("line %d = %#v, want %#v", i, got[i], want[i])
		}
	}
}

func TestWorker_TTYCombined(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{tty: true, body: strings.NewReader("tty line one\ntty line two\n")}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v, want ErrCompleted", err)
	}
	got := tr.allLines()
	if len(got) != 2 || got[0].Text != "tty line one" || got[1].Text != "tty line two" {
		t.Fatalf("lines = %#v", got)
	}
	for _, l := range got {
		if l.Stream != StreamCombined {
			t.Fatalf("stream = %q, want combined", l.Stream)
		}
	}
}

func TestWorker_BlankLinePreserved(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(frame(streamIDStdout, []byte("a\n\nb\n"))))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v", err)
	}
	got := tr.allLines()
	if len(got) != 3 || got[1].Text != "" {
		t.Fatalf("blank line not preserved: %#v", got)
	}
}

func TestWorker_LongLineTruncatedOnce(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	long := strings.Repeat("z", MaxLineBytes+250) + "\n"
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(frame(streamIDStdout, []byte(long))))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v", err)
	}
	got := tr.allLines()
	if len(got) != 1 {
		t.Fatalf("want 1 line, got %d: %#v", len(got), got)
	}
	if !got[0].Truncated || len(got[0].Text) != MaxLineBytes {
		t.Fatalf("truncated=%v len=%d, want true/%d", got[0].Truncated, len(got[0].Text), MaxLineBytes)
	}
}

func TestWorker_EOFFlushesPartialLine(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(frame(streamIDStdout, []byte("full\npartial"))))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v", err)
	}
	got := tr.allLines()
	if len(got) != 2 || got[0].Text != "full" || got[1].Text != "partial" {
		t.Fatalf("lines = %#v", got)
	}
}

func TestWorker_UploadFailureCancelsWithStreamLost(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub(), chunksErr: errors.New("boom"), chunksErrAt: 1}
	// A long-lived source: the reader would block forever if not cancelled.
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	go func() {
		time.Sleep(80 * time.Millisecond)
		pw.Write(queueFrame("one line\n"))
	}()
	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrStreamLost)

	pr.Close()
	pw.Close()
	if len(tr.results) != 1 {
		t.Fatalf("want 1 result report, got %d", len(tr.results))
	}
	if tr.results[0].ErrorCode == nil || *tr.results[0].ErrorCode != ErrStreamLost {
		t.Fatalf("result code = %v, want %q", tr.results[0].ErrorCode, ErrStreamLost)
	}
}

func TestWorker_EchoMismatchCancels(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub(), failEcho: true}
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	go func() {
		time.Sleep(80 * time.Millisecond)
		pw.Write(queueFrame("x\n"))
	}()
	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrStreamLost)
	pr.Close()
	pw.Close()
}

func TestWorker_CancelClosesBodyAndStopsGoroutines(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	var body *closeTrackingBody
	src := &fakeDockerSource{followBody: func() io.Reader {
		body = &closeTrackingBody{inner: &blockingReader{}}
		return body
	}}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.RunClaimed(ctx, workerSub()) }()

	time.Sleep(80 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		assertCode(t, err, ErrStreamLost)
	case <-time.After(3 * time.Second):
		t.Fatal("RunClaimed did not return after cancel: goroutine leak")
	}
	if body == nil || body.CloseCount() != 1 {
		t.Fatalf("daemon body closed %d times, want exactly 1", bodyCloseCount(body))
	}
}

func bodyCloseCount(b *closeTrackingBody) int {
	if b == nil {
		return -1
	}
	return b.CloseCount()
}

// blockingReader blocks forever until Close wakes it, standing in for a live
// Docker follow stream.
type blockingReader struct {
	mu sync.Mutex
	ch chan struct{}
}

func (b *blockingReader) Read(p []byte) (int, error) {
	b.mu.Lock()
	if b.ch == nil {
		b.ch = make(chan struct{})
	}
	ch := b.ch
	b.mu.Unlock()
	<-ch
	return 0, io.EOF
}

// Close wakes a blocked Read so the reader goroutine can exit. It is
// idempotent: the worker may close the body more than once.
func (b *blockingReader) Close() error {
	b.mu.Lock()
	if b.ch == nil {
		b.ch = make(chan struct{})
	}
	select {
	case <-b.ch:
	default:
		close(b.ch)
	}
	b.mu.Unlock()
	return nil
}

func TestWorker_NoReconnectOnUploadGone(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub(), chunksErr: &ErrGone{StatusCode: 410}}
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	go func() {
		time.Sleep(80 * time.Millisecond)
		pw.Write(queueFrame("data\n"))
	}()
	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrStreamLost)
	pr.Close()
	pw.Close()

	if src.OpenCount() != 1 {
		t.Fatalf("follow opened %d times, want exactly 1 (no reconnect)", src.OpenCount())
	}
}

func TestWorker_SilentSourceStillHeartbeats(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.RunClaimed(ctx, workerSub()) }()

	// Silent container: wait long enough for several heartbeats.
	time.Sleep(2500 * time.Millisecond)
	cancel()
	<-done
	pr.Close()
	pw.Close()

	tr.mu.Lock()
	hb := 0
	for _, c := range tr.chunks {
		if len(c.Lines) == 0 {
			hb++
		}
	}
	tr.mu.Unlock()
	if hb < 2 {
		t.Fatalf("silent source produced %d heartbeats, want >=2", hb)
	}
}

func TestWorker_IdleTimeoutStreamLost(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	opts := DefaultWorkerOptions()
	opts.IdleGrace = 120 * time.Millisecond
	w, err := NewWorker("testinst000000000000000000000001", StreamDeps{Transport: tr, Source: src, Resolver: resolve}, opts)
	if err != nil {
		t.Fatal(err)
	}

	// The uploader heartbeats every second, which is longer than the short
	// grace used here, so the idle watchdog is expected to fire.
	err = w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrStreamLost)
	pr.Close()
	pw.Close()
}

func TestWorker_MaxRunExpiry(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	now := time.Now()
	opts := WorkerOptions{MaxRun: 60 * time.Millisecond, IdleGrace: 10 * time.Second, Now: func() time.Time { return now }}
	w, err := NewWorker("testinst000000000000000000000001", StreamDeps{Transport: tr, Source: src, Resolver: resolve}, opts)
	if err != nil {
		t.Fatal(err)
	}

	go func() {
		time.Sleep(80 * time.Millisecond)
		pw.Write(queueFrame("late\n"))
	}()
	err = w.RunClaimed(context.Background(), workerSub())
	var te *terminalError
	if !errors.As(err, &te) || te.code != ErrStreamLost {
		t.Fatalf("err = %v, want terminal stream_lost", err)
	}
	pr.Close()
	pw.Close()
	if len(tr.results) != 1 {
		t.Fatalf("want 1 result, got %d", len(tr.results))
	}
}

func TestWorker_ClaimInstanceMismatch(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	src := &fakeDockerSource{body: strings.NewReader("")}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	sub := workerSub()
	sub.AgentInstanceID = "otherinst00000000000000000000002"
	err := w.RunClaimed(context.Background(), sub)
	assertCode(t, err, ErrStreamLost)
}

// mustFrames lets callers pass raw bytes where a string is expected.
func mustFrames(b []byte) string { return string(b) }

// queueFrame wraps a payload in a valid multiplexed Docker frame. Pipe
// based tests must write framed bytes: the decoder validates framing, so
// raw text would fail closed as invalid_docker_stream instead of exercising
// the upload-failure path under test.
func queueFrame(payload string) []byte {
	return frame(streamIDStdout, []byte(payload))
}

func assertCode(t *testing.T, err error, want string) {
	t.Helper()
	var te *terminalError
	if !errors.As(err, &te) {
		t.Fatalf("err = %v (%T), want terminal %s", err, err, want)
	}
	if te.code != want {
		t.Fatalf("code = %q, want %q", te.code, want)
	}
}

// fakeDaemon serves a real Docker log endpoint over HTTP so the worker can
// be exercised through the real DockerSource.Close path.
func fakeDaemon(t *testing.T, tty bool, payload []byte, status int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"Config":{"Tty":%v}}`, tty)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/logs") {
			if status != 0 {
				w.WriteHeader(status)
				return
			}
			w.WriteHeader(200)
			w.Write(payload)
			return
		}
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestWorker_ThroughRealDockerSource(t *testing.T) {
	inst := strings.Repeat("a", 64)
	srv := fakeDaemon(t, false, frame(streamIDStdout, []byte("real daemon\n")), 0)
	tr := &fakeTransport{claimSub: workerSub()}
	source, err := NewDockerSource(srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("NewDockerSource: %v", err)
	}
	resolve := func(key string) (string, bool) { return inst, true }
	w, err := NewWorker("testinst000000000000000000000001", StreamDeps{Transport: tr, Source: NewDockerSourcePort(source), Resolver: resolve}, DefaultWorkerOptions())
	if err != nil {
		t.Fatal(err)
	}

	err = w.RunClaimed(context.Background(), workerSub())
	if !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v, want ErrCompleted", err)
	}
	got := tr.allLines()
	if len(got) != 1 || got[0].Text != "real daemon" {
		t.Fatalf("lines = %#v", got)
	}
}

func TestWorker_ThroughRealDockerSource404(t *testing.T) {
	inst := strings.Repeat("a", 64)
	srv := fakeDaemon(t, false, nil, 404)
	tr := &fakeTransport{claimSub: workerSub()}
	source, err := NewDockerSource(srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("NewDockerSource: %v", err)
	}
	resolve := func(key string) (string, bool) { return inst, true }
	w, err := NewWorker("testinst000000000000000000000001", StreamDeps{Transport: tr, Source: NewDockerSourcePort(source), Resolver: resolve}, DefaultWorkerOptions())
	if err != nil {
		t.Fatal(err)
	}
	err = w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrContainerNotFound)
}

func TestWorker_ThroughRealDockerSource500(t *testing.T) {
	inst := strings.Repeat("a", 64)
	srv := fakeDaemon(t, false, nil, 500)
	tr := &fakeTransport{claimSub: workerSub()}
	source, err := NewDockerSource(srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("NewDockerSource: %v", err)
	}
	resolve := func(key string) (string, bool) { return inst, true }
	w, err := NewWorker("testinst000000000000000000000001", StreamDeps{Transport: tr, Source: NewDockerSourcePort(source), Resolver: resolve}, DefaultWorkerOptions())
	if err != nil {
		t.Fatal(err)
	}
	err = w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrLogsUnavailable)
}

// A tail batch submitted after the queue has already been filled must not
// be discarded by the clean-EOF path: the uploader drains its queue and
// flushes what is still pending before returning.
func TestWorker_EOFTailBatchesAreFlushed(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	// 250 lines must span several batches; the last one is submitted just
	// before EOF, so it is only delivered if the tail is drained.
	var buf []byte
	for i := 0; i < 250; i++ {
		buf = append(buf, frame(streamIDStdout, []byte(fmt.Sprintf("line-%03d\n", i)))...)
	}
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(buf))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v, want ErrCompleted", err)
	}
	got := tr.allLines()
	if len(got) != 250 {
		t.Fatalf("delivered %d lines, want 250 (tail was dropped)", len(got))
	}
	for i := 0; i < 250; i++ {
		want := fmt.Sprintf("line-%03d", i)
		if got[i].Text != want {
			t.Fatalf("line %d = %q, want %q", i, got[i].Text, want)
		}
	}
}

// A container emitting one short line per payload must not wait for EOF:
// the reader submits its partial batch and the uploader's 100 ms timer
// flushes it, so a live single-line container stays realtime.
func TestWorker_PartialBatchFlushesWithoutEOF(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	pr, pw := io.Pipe()
	src := &fakeDockerSource{followBody: func() io.Reader { return pr }}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- w.RunClaimed(ctx, workerSub()) }()

	time.Sleep(60 * time.Millisecond)
	if _, err := pw.Write(queueFrame("solo line\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(tr.allLines()) >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := tr.allLines(); len(got) < 1 || got[0].Text != "solo line" {
		t.Fatalf("partial batch was not flushed before EOF: %#v", got)
	}
	cancel()
	<-done
	pr.Close()
	pw.Close()
}

// Many oversized lines must be split into multiple capped batches rather
// than failing the stream: the cap check is made before the line is added.
func TestWorker_OversizeLinesSplitAcrossBatches(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	var buf []byte
	for i := 0; i < 30; i++ {
		buf = append(buf, frame(streamIDStdout, []byte(strings.Repeat("x", MaxLineBytes-16)+"\n"))...)
	}
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(buf))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	if err := w.RunClaimed(context.Background(), workerSub()); !errors.Is(err, ErrCompleted) {
		t.Fatalf("got %v, want ErrCompleted", err)
	}
	got := tr.allLines()
	if len(got) != 30 {
		t.Fatalf("delivered %d of 30 lines", len(got))
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if len(tr.chunks) < 2 {
		t.Fatalf("oversize lines were not split into multiple batches: %d calls", len(tr.chunks))
	}
	for i, c := range tr.chunks {
		if n := SerializedOutgoingBytes(c); n > MaxBodyBytes {
			t.Fatalf("batch %d wire size %d exceeds %d", i, n, MaxBodyBytes)
		}
	}
}

// A clean EOF whose final drain fails to upload must not be reported as
// completed: the tail was lost, so the broker needs stream_lost. The
// failure is injected into the last upload after the reader has already
// handed the queue over, so only the drain can observe it.
func TestWorker_EOFDrainFailureIsNotCompleted(t *testing.T) {
	tr := &fakeTransport{claimSub: workerSub()}
	var buf []byte
	// Enough batches that at least one upload is still in flight when the
	// delayed failure lands after the reader's EOF.
	for i := 0; i < 250; i++ {
		buf = append(buf, frame(streamIDStdout, []byte(fmt.Sprintf("line-%03d\n", i)))...)
	}
	src := &fakeDockerSource{body: strings.NewReader(mustFrames(buf))}
	resolve := func(key string) (string, bool) { return strings.Repeat("a", 64), true }
	w := newFakeWorker(t, &StreamDeps{Transport: tr, Source: src, Resolver: resolve})

	// The failure lands during the post-EOF drain, after the reader has
	// already handed over its batches, so only the drain can observe it.
	tr.mu.Lock()
	tr.chunksErrAt = 1
	tr.chunksErr = errors.New("boom")
	tr.delayBeforeChunksErr = 60 * time.Millisecond
	tr.mu.Unlock()

	err := w.RunClaimed(context.Background(), workerSub())
	assertCode(t, err, ErrStreamLost)
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if len(tr.results) == 0 {
		t.Fatal("no terminal result reported")
	}
	for i, r := range tr.results {
		if r.Status != ResultFailed {
			t.Fatalf("result %d status = %v, want failed", i, r.Status)
		}
		if r.ErrorCode == nil || *r.ErrorCode != ErrStreamLost {
			t.Fatalf("result %d code = %v, want %q", i, r.ErrorCode, ErrStreamLost)
		}
	}
}
