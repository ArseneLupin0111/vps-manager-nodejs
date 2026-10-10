package logs

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Bounded batch worker: the single upload loop for one subscription.
//
// Ownership split on purpose:
//   - The Docker reader goroutine (see worker.go) never blocks on the API.
//     It decodes the daemon stream, batches lines, and hands finished
//     batches to the uploader through a bounded queue.
//   - This uploader owns exactly one in-flight request and the sequence
//     counter, so batches can never be reordered or duplicated.
//
// Fail-closed rules implemented here:
//   - Queue full => cancel the whole stream (stream_lost) instead of
//     dropping data silently or growing memory.
//   - A periodic heartbeat keeps the subscription alive while the source is
//     silent (a container producing no lines is normal, not an error).
//   - A failed or echo-mismatched upload cancels the stream immediately;
//     no blind retry, because a re-sent batch would duplicate viewer lines.
//
// The uploader starts only after the Docker log HTTP returned 2xx, so every
// request it issues carries ready=true, exactly as the wire contract locks.
const (
	batchQueueSize    = 4
	heartbeatInterval = time.Second
	flushInterval     = 100 * time.Millisecond
)

// BatchUploader serializes uploads for a single subscription.
type BatchUploader struct {
	sub        *ClaimedSubscription
	sink       uploadSink
	instanceID string
	lines      chan []LogLine
	done       chan struct{}

	mu         sync.Mutex
	sequence   int64
	closed     bool
	onProgress func()

	// lastErr records the uploader's own terminal failure. A drain that
	// fails after a clean EOF must not be reported to the broker as
	// completed: the tail was lost, so the subscriber needs stream_lost.
	lastErr error

	// noMore is closed by Finish: the reader reached a clean EOF and will
	// not submit again, so the loop must flush what is still queued or
	// pending before returning instead of dropping the tail.
	noMore     chan struct{}
	finishOnce sync.Once

	cancelCause func(error)
}

// uploadSink is the minimum transport surface the uploader needs.
type uploadSink interface {
	PostChunks(ctx context.Context, subscriptionID string, req ChunksRequest) (ChunksResponse, error)
}

// NewBatchUploader builds the uploader for a claimed subscription.
// cancelCause is invoked to tear down the whole stream when an upload fails.
func NewBatchUploader(sub *ClaimedSubscription, sink uploadSink, cancelCause func(error)) *BatchUploader {
	return &BatchUploader{
		sub:         sub,
		sink:        sink,
		instanceID:  sub.AgentInstanceID,
		lines:       make(chan []LogLine, batchQueueSize),
		done:        make(chan struct{}),
		noMore:      make(chan struct{}),
		cancelCause: cancelCause,
	}
}

// Submit hands a decoded batch to the upload loop. It returns an error —
// and the caller must cancel the stream — when the bounded queue is full:
// the API is not draining, so buffering more would be unbounded.
//
// The batch is copied because the decoder reuses the backing array.
func (u *BatchUploader) Submit(lines []LogLine) error {
	u.mu.Lock()
	closed := u.closed
	u.mu.Unlock()
	if closed {
		return fmt.Errorf("logs: uploader stopped")
	}
	if len(lines) == 0 {
		return nil
	}
	// Enforce the caps at the entry point, not only inside the loop: a
	// reader that batches badly would otherwise push an oversize body
	// through the queue and have it rejected on the wire.
	if len(lines) > MaxLinesPerBatch {
		return fmt.Errorf("logs: submit batch overflow: %d > %d", len(lines), MaxLinesPerBatch)
	}
	seq := u.nextSequence()
	if n := serializedLinesSize(u.instanceID, seq, lines); n > MaxBodyBytes {
		return fmt.Errorf("logs: submit body oversize: %d > %d", n, MaxBodyBytes)
	}
	cp := make([]LogLine, len(lines))
	copy(cp, lines)
	select {
	case u.lines <- cp:
		return nil
	default:
		// The queue is bounded and the API stopped draining. Failing closed
		// here (and cancelling the stream through the returned error) beats
		// dropping lines silently or growing memory without limit.
		return fmt.Errorf("logs: upload queue full")
	}
}

// Stop prevents further submissions. Idempotent.
func (u *BatchUploader) Stop() {
	u.mu.Lock()
	u.closed = true
	u.mu.Unlock()
}

// Finish marks a clean end of source: the reader will not submit again and
// the upload loop must flush everything still queued or pending before it
// returns. It is only legal on the clean-EOF path — never after a cancel,
// where no further data may be flushed. Idempotent.
func (u *BatchUploader) Finish() {
	u.finishOnce.Do(func() {
		close(u.noMore)
	})
}

// Done is closed once the upload loop has exited.
func (u *BatchUploader) Done() <-chan struct{} { return u.done }

// Run is the upload loop. It returns when ctx is cancelled or the stream
// fails; it never returns while an upload is in flight.
//
// A batch is uploaded when it reaches 100 lines, when it would push the
// serialized body past 32 KiB, or after 100 ms. Heartbeats go out every
// second so an idle source still proves liveness.
func (u *BatchUploader) Run(ctx context.Context) {
	defer u.Stop()
	defer close(u.done)
	// Failing submissions leave the stream, so queued batches can still be
	// sitting in the channel when the loop exits through ctx.Done or a
	// failed upload. Draining the queue releases any reader — it must never
	// block forever on a loop that will not consume again. The clean-EOF
	// path exits through the noMore case instead, which has already flushed
	// that same queue.
	defer u.drain()

	pending := make([]LogLine, 0, MaxLinesPerBatch)
	flushTimer := time.NewTimer(flushInterval)
	defer flushTimer.Stop()
	hb := time.NewTicker(heartbeatInterval)
	defer hb.Stop()

	upload := func(ctx context.Context, lines []LogLine) bool {
		if err := u.upload(ctx, lines); err != nil {
			u.fail(err)
			return false
		}
		return true
	}

	// absorb merges one queued batch into pending, flushing pending first
	// when combining them would exceed either wire cap. The check is made
	// on the exact bytes that would go out, so an oversize aggregate is
	// split into two requests instead of being rejected on the wire.
	absorb := func(lines []LogLine) bool {
		if len(lines) == 0 {
			return true
		}
		if len(pending) > 0 {
			wouldOverflowLines := len(pending)+len(lines) > MaxLinesPerBatch
			var wouldOverflowBytes bool
			if !wouldOverflowLines {
				combined := make([]LogLine, len(pending)+len(lines))
				copy(combined, pending)
				copy(combined[len(pending):], lines)
				wouldOverflowBytes = serializedLinesSize(u.instanceID, u.nextSequence(), combined) > MaxBodyBytes
			}
			if wouldOverflowLines || wouldOverflowBytes {
				if !upload(ctx, pending) {
					return false
				}
				pending = pending[:0]
			}
		}

		if len(lines) >= MaxLinesPerBatch || serializedLinesSize(u.instanceID, u.nextSequence(), lines) >= MaxBodyBytes {
			if !upload(ctx, lines) {
				return false
			}
		} else {
			pending = append(pending, lines...)
		}
		stopTimer(flushTimer)
		flushTimer.Reset(flushInterval)
		return true
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-u.noMore:
			// Clean end of source: the reader will not submit again, so the
			// bounded queue is drained and what is still pending is flushed
			// before the loop returns. Without this the tail of the
			// container — and the final partial batch — would be dropped.
		drainLoop:
			for {
				select {
				case lines := <-u.lines:
					if !absorb(lines) {
						return
					}
				default:
					break drainLoop
				}
			}
			if len(pending) > 0 {
				if !upload(ctx, pending) {
					return
				}
			}
			return
		case lines := <-u.lines:
			if !absorb(lines) {
				return
			}
		case <-flushTimer.C:
			if len(pending) > 0 {
				if !upload(ctx, pending) {
					return
				}
				pending = pending[:0]
			}
			stopTimer(flushTimer)
			flushTimer.Reset(flushInterval)
		case <-hb.C:
			// The heartbeat has its own 1 s cadence on purpose: it must not
			// be postponed by a busy flush timer, or a container that keeps
			// producing sub-batch lines could starve the broker's 10 s
			// liveness window.
			if !upload(ctx, nil) {
				return
			}
		}
	}
}

// drain discards queued batches after the loop exits so a decoder blocked
// on Submit is released instead of leaking the goroutine.
func (u *BatchUploader) drain() {
	for {
		select {
		case <-u.lines:
		default:
			return
		}
	}
}

// stopTimer stops a timer and drains a value it may already have delivered.
func stopTimer(t *time.Timer) {
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
}

// nextSequence returns the sequence for the next upload. Each
// batch/heartbeat consumes exactly one value; the broker accepts only the
// immediately following one.
func (u *BatchUploader) nextSequence() int64 {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.sequence + 1
}

// SetOnProgress registers an optional callback fired on successful chunk/heartbeat upload.
func (u *BatchUploader) SetOnProgress(fn func()) {
	u.mu.Lock()
	u.onProgress = fn
	u.mu.Unlock()
}

// upload performs one chunks request. On success it commits the sequence.
func (u *BatchUploader) upload(ctx context.Context, lines []LogLine) error {
	req := ChunksRequest{
		AgentInstanceID: u.instanceID,
		Sequence:        u.sequence + 1,
		Ready:           true,
		Lines:           lines,
	}
	if req.Lines == nil {
		req.Lines = []LogLine{}
	}
	// The budget is measured on the exact bytes that will be sent. This is
	// the last gate before the wire, and it never lets an oversize body
	// out — but it must also not fire on a body the loop believed was fine.
	wire := SerializedOutgoingBytes(req)
	if err := ValidateChunksRequest(req, wire); err != nil {
		return fmt.Errorf("logs: chunks invalid: %w (seq=%d n=%d wire=%d)", err, req.Sequence, len(req.Lines), wire)
	}
	resp, err := u.sink.PostChunks(ctx, u.sub.SubscriptionID, req)
	if err != nil {
		return err
	}
	if resp.Data.Sequence != req.Sequence {
		return fmt.Errorf("logs: chunks sequence echo mismatch")
	}
	u.mu.Lock()
	u.sequence = req.Sequence
	onProg := u.onProgress
	u.mu.Unlock()
	if onProg != nil {
		onProg()
	}
	return nil
}

// fail reports an upload failure to the stream owner exactly once.
func (u *BatchUploader) fail(err error) {
	u.mu.Lock()
	if u.lastErr == nil {
		u.lastErr = err
	}
	u.mu.Unlock()
	u.Stop()
	if u.cancelCause != nil {
		u.cancelCause(err)
	}
}

// LastError returns the uploader's terminal failure, if any. It is the
// authority for the clean-EOF path: a drain that failed must be reported as
// a failure, not as completion.
func (u *BatchUploader) LastError() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.lastErr
}

// Sequence returns the last acknowledged sequence (diagnostics/tests).
func (u *BatchUploader) Sequence() int64 {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.sequence
}

// serializedLinesSize measures the serialized chunks body for the given
// pending lines (bytes, not text length). Marshalling errors count as
// oversize so the upload fails closed rather than splitting a frame.
func serializedLinesSize(instanceID string, seq int64, lines []LogLine) int {
	if lines == nil {
		lines = []LogLine{}
	}
	return SerializedOutgoingBytes(ChunksRequest{
		AgentInstanceID: instanceID,
		Sequence:        seq,
		Ready:           true,
		Lines:           lines,
	})
}
