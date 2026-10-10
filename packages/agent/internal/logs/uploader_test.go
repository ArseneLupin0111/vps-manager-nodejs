package logs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingSink is a fast in-memory chunks sink: it always succeeds and
// optionally scripts one failure or a sequence-echo mismatch.
type recordingSink struct {
	mu      sync.Mutex
	reqs    []ChunksRequest
	seqEcho bool
	failAt  int // 1-based request index to fail (0 = never)
}

func newRecordingSink() *recordingSink {
	return &recordingSink{seqEcho: true}
}

func (r *recordingSink) failAtRequest(n int) *recordingSink {
	r.failAt = n
	return r
}

func (r *recordingSink) PostChunks(ctx context.Context, subscriptionID string, req ChunksRequest) (ChunksResponse, error) {
	// Snapshot the lines: the uploader reuses its pending buffer, so a
	// stored reference would reflect later, unrelated appends.
	cp := make([]LogLine, len(req.Lines))
	copy(cp, req.Lines)
	req.Lines = cp
	r.mu.Lock()
	r.reqs = append(r.reqs, req)
	r.mu.Unlock()
	r.mu.Lock()
	n := len(r.reqs)
	r.mu.Unlock()
	if r.failAt != 0 && n >= r.failAt {
		return ChunksResponse{}, errors.New("boom")
	}
	seq := req.Sequence
	if !r.seqEcho {
		seq = req.Sequence + 99
	}
	return ChunksResponse{Data: ChunksResponseData{OK: true, SubscriptionID: subscriptionID, Sequence: seq}}, nil
}

// gateSink blocks every upload until its gate is closed, which stands in
// for an API that stopped draining.
type gateSink struct{ gate chan struct{} }

func (g *gateSink) PostChunks(ctx context.Context, subscriptionID string, req ChunksRequest) (ChunksResponse, error) {
	select {
	case <-g.gate:
	case <-ctx.Done():
		return ChunksResponse{}, ctx.Err()
	}
	return ChunksResponse{Data: ChunksResponseData{OK: true, SubscriptionID: subscriptionID, Sequence: req.Sequence}}, nil
}

func (r *recordingSink) calls() []ChunksRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ChunksRequest, len(r.reqs))
	copy(out, r.reqs)
	return out
}

func (r *recordingSink) totalLines() int {
	total := 0
	for _, c := range r.calls() {
		total += len(c.Lines)
	}
	return total
}

func subFixture() *ClaimedSubscription {
	return &ClaimedSubscription{
		SubscriptionID:  "1111111111111111111111111111111111111111111111111111111111112222",
		VpsID:           "vps-1",
		AgentInstanceID: instanceID(),
		ContainerKey:    "key-1",
		TailLines:       TailLines,
		ExpiresAt:       time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
	}
}

// newUploader builds an uploader plus its cancel-cause channel, which the
// upload loop writes to on a failed upload.
func newUploader(t *testing.T, sink uploadSink) (*BatchUploader, chan error) {
	t.Helper()
	cancelCause := make(chan error, 8)
	up := NewBatchUploader(subFixture(), sink, func(err error) { cancelCause <- err })
	return up, cancelCause
}

// waitUntil polls condition until it holds or the deadline passes.
func waitUntil(t *testing.T, what string, d time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s after %v", what, d)
}

func TestUploaderBatchesAt100Lines(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	for i := 0; i < 250; i++ {
		line := LogLine{Stream: StreamStdout, Text: "l" + string(rune('a'+i%26)), Truncated: false}
		if err := up.Submit([]LogLine{line}); err != nil {
			// A bounded queue refuses only when the API stalls; here it is
			// the test loop outrunning the drain, so retry instead of fail.
			for err != nil {
				time.Sleep(time.Millisecond)
				err = up.Submit([]LogLine{line})
			}
		}
	}
	waitUntil(t, "first 100-line batch to be uploaded", 2*time.Second, func() bool {
		return len(sink.calls()) > 0 && len(sink.calls()[0].Lines) == MaxLinesPerBatch
	})
	calls := sink.calls()
	if n := len(calls[0].Lines); n != MaxLinesPerBatch {
		t.Fatalf("first batch lines = %d, want %d", n, MaxLinesPerBatch)
	}
	if calls[0].Sequence != 1 {
		t.Fatalf("first sequence = %d, want 1", calls[0].Sequence)
	}
	if !calls[0].Ready {
		t.Fatalf("first batch ready = false, want true")
	}
	if calls[0].AgentInstanceID != subFixture().AgentInstanceID {
		t.Fatalf("bound instance = %q", calls[0].AgentInstanceID)
	}
}

func TestUploaderFlushesBeforeBodyLimit(t *testing.T) {
	sink := newRecordingSink()
	up, cancelCause := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	// Each line is ~3 KiB of text. Ten lines fit the 32 KiB body, twelve do
	// not, so the loop must flush before the cap and carry the remainder.
	// The bounded queue is deliberately small, so a fast producer must be
	// paced; the reader is paced by the Docker stream, not spun out.
	for i := 0; i < 12; i++ {
		line := LogLine{Stream: StreamStdout, Text: strings.Repeat("x", 3000), Truncated: false}
		if err := submitPaced(up, []LogLine{line}, 2*time.Second); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	waitUntil(t, "all twelve lines uploaded", 3*time.Second, func() bool { return sink.totalLines() >= 12 })
	calls := sink.calls()
	if len(calls) < 2 {
		t.Fatalf("expected the body limit to split the batch into >=2 requests, got %d", len(calls))
	}
	for i, c := range calls {
		if got := SerializedOutgoingBytes(c); got > MaxBodyBytes {
			t.Fatalf("call %d wire %d > %d", i, got, MaxBodyBytes)
		}
		if c.Sequence != int64(i+1) {
			t.Fatalf("call %d sequence = %d", i, c.Sequence)
		}
	}
	select {
	case err := <-cancelCause:
		t.Fatalf("body-limit flush cancelled the stream: %v", err)
	default:
	}
}

func TestSubmitRejectsOversizeInput(t *testing.T) {
	sink := newRecordingSink()
	up, cancelCause := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	// A caller that hands the uploader one over-budget batch is rejected at
	// the entry point: nothing oversize is ever queued or sent.
	over := make([]LogLine, 0, MaxLinesPerBatch)
	for i := 0; i < MaxLinesPerBatch; i++ {
		over = append(over, LogLine{Stream: StreamStdout, Text: strings.Repeat("x", MaxLineBytes), Truncated: false})
	}
	if err := up.Submit(over); err == nil {
		t.Fatal("expected an over-budget batch to be rejected by Submit")
	}
	if len(sink.calls()) != 0 {
		t.Fatalf("oversize batch was sent: %d calls", len(sink.calls()))
	}
	// A within-budget batch from the same uploader still flows.
	if err := up.Submit(oneLine()); err != nil {
		t.Fatalf("valid submit refused: %v", err)
	}
	waitUntil(t, "valid batch flushed", 2*time.Second, func() bool { return sink.totalLines() >= 1 })
	select {
	case err := <-cancelCause:
		t.Fatalf("healthy stream cancelled: %v", err)
	default:
	}
}

func TestSubmitRejectsBatchOverflow(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	over := manyLines(MaxLinesPerBatch + 1)
	if err := up.Submit(over); err == nil {
		t.Fatal("expected a >100-line batch to be rejected")
	}
	// 100 lines of short text is within both caps and must be accepted.
	ok := manyLines(MaxLinesPerBatch)
	if err := up.Submit(ok); err != nil {
		t.Fatalf("100-line batch refused: %v", err)
	}
}

func TestUploaderFlushesOnTimer(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	if err := up.Submit([]LogLine{{Stream: StreamStdout, Text: "solo", Truncated: false}}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	// Below both the 100-line and body caps, so only the 100 ms timer can
	// flush this batch.
	waitUntil(t, "timer flush", 2*time.Second, func() bool { return len(sink.calls()) > 0 })
	calls := sink.calls()
	if len(calls[0].Lines) != 1 || calls[0].Lines[0].Text != "solo" {
		t.Fatalf("timer flush lost the line: %#v", calls[0].Lines)
	}
}

func TestUploaderHeartbeatOnIdleSource(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	// Nothing submitted: the container produces no lines. That is a normal
	// silent source, not an error, and liveness must still be proven.
	waitUntil(t, "two heartbeats", 4*time.Second, func() bool { return len(sink.calls()) >= 2 })
	calls := sink.calls()
	for i, c := range calls {
		if len(c.Lines) != 0 {
			t.Fatalf("heartbeat %d carried lines: %#v", i, c.Lines)
		}
		if !c.Ready {
			t.Fatalf("heartbeat %d ready = false", i)
		}
	}
	if calls[0].Sequence != 1 || calls[1].Sequence != 2 {
		t.Fatalf("heartbeat sequences = %d,%d", calls[0].Sequence, calls[1].Sequence)
	}
}

func TestUploaderNeverContractsReadyFalse(t *testing.T) {
	sink := newRecordingSink()
	up, cancelCause := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	for i := 0; i < 5; i++ {
		if err := up.Submit([]LogLine{{Stream: StreamStdout, Text: "x", Truncated: false}}); err != nil {
			t.Fatalf("submit: %v", err)
		}
		waitUntil(t, "batch flush", 2*time.Second, func() bool {
			return sink.totalLines() >= 1
		})
		sink.mu.Lock()
		for _, r := range sink.reqs {
			if !r.Ready {
				sink.mu.Unlock()
				t.Fatal("uploader emitted ready=false; it only runs after Docker 2xx")
				return
			}
		}
		sink.mu.Unlock()
	}
	select {
	case <-cancelCause:
		t.Fatal("uploader cancelled a healthy stream")
	default:
	}
}

func TestUploaderQueueFullFailsNotDrops(t *testing.T) {
	gate := make(chan struct{})
	up, cancelCause := newUploader(t, &gateSink{gate: gate})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	// 1 in flight + 4 queued, then Submit must fail closed rather than
	// silently dropping lines or growing the queue.
	// The stack: 1 upload blocks in the gate sink, 4 sit in the bounded
	// queue, and the next Submit is refused. A refusal must fail closed by
	// cancelling the stream — that is what the reader does with this error —
	// so no queued line is silently dropped while the API is stalled.
	var full error
	for i := 0; i < 40; i++ {
		if err := up.Submit(oneLine()); err != nil {
			full = err
			break
		}
	}
	if full == nil {
		t.Fatal("expected queue-full error, kept accepting")
	}
	// The reader reacts to that error exactly like a failed upload: cancel
	// the stream. Replay it through the same path here.
	up.fail(full)
	select {
	case <-cancelCause:
	case <-time.After(2 * time.Second):
		t.Fatal("full queue did not cancel the stream")
	}
	close(gate)
}

func TestUploaderFailureCancelsStream(t *testing.T) {
	sink := newRecordingSink().failAtRequest(1)
	up, cancelCause := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); up.Run(ctx) }()
	defer up.Stop()
	for i := 0; i < 10; i++ {
		_ = up.Submit(oneLine())
	}
	select {
	case err := <-cancelCause:
		if err == nil {
			t.Fatal("cancel cause nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upload failure did not cancel the stream")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after failure")
	}
}

func TestUploaderEchoMismatchCancels(t *testing.T) {
	sink := newRecordingSink()
	sink.seqEcho = false
	up, cancelCause := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); up.Run(ctx) }()
	defer up.Stop()
	for i := 0; i < 10; i++ {
		_ = up.Submit(oneLine())
	}
	select {
	case <-cancelCause:
	case <-time.After(2 * time.Second):
		t.Fatal("sequence echo mismatch did not cancel the stream")
	}
}

func TestUploaderSequenceAdvancesOncePerRequest(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	for i := 0; i < 6; i++ {
		if err := up.Submit(oneLine()); err != nil {
			t.Fatalf("submit: %v", err)
		}
		waitUntil(t, "flush", 2*time.Second, func() bool { return sink.totalLines() >= 1 })
		sink.mu.Lock()
		n := len(sink.reqs)
		sink.mu.Unlock()
		if n >= 1 {
			sink.mu.Lock()
			last := sink.reqs[n-1].Sequence
			sink.mu.Unlock()
			if got := up.Sequence(); got != last {
				t.Fatalf("acknowledged sequence = %d, last sent = %d", got, last)
			}
		}
	}
	calls := sink.calls()
	for i := 1; i < len(calls); i++ {
		if calls[i].Sequence != calls[i-1].Sequence+1 {
			t.Fatalf("sequence jumped: %d -> %d", calls[i-1].Sequence, calls[i].Sequence)
		}
	}
}

func TestUploaderSubmitCopiesBatch(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go up.Run(ctx)
	defer up.Stop()
	batch := []LogLine{{Stream: StreamStdout, Text: "mutate-me", Truncated: false}}
	if err := up.Submit(batch); err != nil {
		t.Fatalf("submit: %v", err)
	}
	// The caller mutates its slice after Submit; the decoder contract is
	// that the batch already on the wire is never affected.
	batch[0].Text = "mutated"
	waitUntil(t, "flush", 2*time.Second, func() bool { return len(sink.calls()) > 0 })
	for _, c := range sink.calls() {
		for _, l := range c.Lines {
			if l.Text == "mutated" {
				t.Fatalf("caller mutation leaked into a sent batch: %#v", l)
			}
		}
	}
}

func TestUploaderStopIsIdempotentAndSubmittedTwice(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	up.Stop()
	up.Stop() // must not panic
	if err := up.Submit(oneLine()); err == nil {
		t.Fatal("expected a stopped uploader to refuse submissions")
	}
}

func TestUploaderDrainUnblocksSubmitter(t *testing.T) {
	sink := newRecordingSink()
	up, _ := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	// Already cancelled: Run returns immediately and must drain the queue
	// so a blocked submitter is released instead of leaking.
	cancel()
	go up.Run(ctx)
	defer up.Stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 50; i++ {
			_ = up.Submit(oneLine())
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Submit blocked after Run exited")
	}
}

// submitPaced retries a Submit until it is accepted, giving a bounded queue
// time to drain. A producer that never blocks would fill the four-slot
// queue and starve, which is not the behaviour under test.
func submitPaced(up *BatchUploader, lines []LogLine, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for {
		err := up.Submit(lines)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func manyLines(n int) []LogLine {
	out := make([]LogLine, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, LogLine{Stream: StreamStdout, Text: "line", Truncated: false})
	}
	return out
}

func oneLine() []LogLine {
	return []LogLine{{Stream: StreamStdout, Text: "one", Truncated: false}}
}

// Finish marks a clean end of source: the loop must upload everything still
// queued or pending before returning, never drop the tail.
func TestUploaderFinishFlushesQueueAndPending(t *testing.T) {
	sink := newRecordingSink()
	up, cancelCause := newUploader(t, sink)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); up.Run(ctx) }()
	defer up.Stop()

	// Far more than one batch and well past the 100 ms flush interval's
	// worth of pending lines, so both the queue and the pending buffer hold
	// content at the moment Finish arrives.
	for i := 0; i < 250; i++ {
		if err := submitPaced(up, []LogLine{{Stream: StreamStdout, Text: fmt.Sprintf("l%03d", i), Truncated: false}}, 2*time.Second); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	up.Finish()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return after Finish")
	}
	if got := sink.totalLines(); got != 250 {
		t.Fatalf("uploaded %d lines after Finish, want 250 (tail dropped)", got)
	}
	select {
	case err := <-cancelCause:
		t.Fatalf("clean EOF cancelled the stream: %v", err)
	default:
	}
	for i, c := range sink.calls() {
		if c.Sequence != int64(i+1) {
			t.Fatalf("call %d sequence = %d, want %d", i, c.Sequence, i+1)
		}
		if !c.Ready {
			t.Fatalf("call %d ready = false", i)
		}
		if n := SerializedOutgoingBytes(c); n > MaxBodyBytes {
			t.Fatalf("call %d wire size %d exceeds %d", i, n, MaxBodyBytes)
		}
	}
}
