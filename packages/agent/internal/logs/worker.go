package logs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"
)

// One viewer subscription, end to end: resolve target, inspect TTY, open a
// single Docker follow source, decode incrementally, and upload bounded
// batches until the source completes or anything fails.
//
// Structural guarantees, in priority order:
//  1. Exactly one Docker follow request per subscription. No snapshot plus
//     follow (that gaps/duplicates); no reconnect; no tail re-read.
//  2. Cancellation joins every goroutine and closes the daemon body. Nothing
//     keeps reading after cancel, and nothing flushes new data afterwards.
//  3. Nothing is dropped silently: a full batch queue fails the stream with
//     stream_lost rather than discarding viewer-visible lines.
//  4. Every terminal path reports exactly once, with a safe code. Daemon
//     error bodies never reach the API, a log sink, or an exception.
//  5. Ready is only reported after the Docker log HTTP returns 2xx, so the
//     broker never advertises a live source it does not have.

// WorkerOptions bounds one subscription run.
type WorkerOptions struct {
	// Logger receives operational messages; the terminal outcome is logged
	// here. nil disables logging.
	Logger *log.Logger
	// MaxRun caps the whole subscription (broker-side max is 2h; reconnects
	// are the viewer's choice and get a fresh window).
	MaxRun time.Duration
	// IdleGrace is how long the daemon may stay silent before the broker
	// declares the stream lost. It must exceed the heartbeat interval.
	IdleGrace time.Duration
	// Now is injectable for tests.
	Now func() time.Time
}

// DefaultWorkerOptions matches the broker's timeouts: 2h maximum and a
// 10s heartbeat grace.
func DefaultWorkerOptions() WorkerOptions {
	return WorkerOptions{MaxRun: 2 * time.Hour, IdleGrace: 10 * time.Second}
}

// StreamDeps are the seams a Worker needs. *Client, *DockerSource and
// commands.TargetResolver satisfy them in production; tests inject fakes.
type StreamDeps struct {
	Transport Transport
	Source    DockerSourcePort
	Resolver  TargetResolver
}

// TargetResolver maps an opaque containerKey to the full 64-char lowercase
// hex daemon ID. commands.NewDockerTargetResolver satisfies this shape.
type TargetResolver func(containerKey string) (fullID string, ok bool)

// DockerSourcePort is the daemon-side surface of the log source.
type DockerSourcePort interface {
	InspectTTY(ctx context.Context, fullID string) (bool, error)
	OpenFollow(ctx context.Context, fullID string) (FollowResponse, error)
}

// FollowResponse is the open daemon source: a body plus its closer.
type FollowResponse interface {
	Body() io.ReadCloser
}

// httpFollowResponse adapts an *http.Response body to FollowResponse.
type httpFollowResponse struct{ body io.ReadCloser }

func (h httpFollowResponse) Body() io.ReadCloser { return h.body }

// Worker runs one claimed subscription to its terminal state.
type Worker struct {
	instanceID string
	deps       StreamDeps
	opts       WorkerOptions
	now        func() time.Time
	logger     *log.Logger
}

// NewWorker builds a worker. deps and instanceID are required.
func NewWorker(instanceID string, deps StreamDeps, opts WorkerOptions) (*Worker, error) {
	if !validOpaqueID(instanceID, MaxInstanceIDLen) {
		return nil, fmt.Errorf("bad agentInstanceId")
	}
	if deps.Transport == nil || deps.Source == nil || deps.Resolver == nil {
		return nil, fmt.Errorf("nil logs worker dependency")
	}
	if opts.MaxRun <= 0 || opts.IdleGrace <= 0 {
		opts = DefaultWorkerOptions()
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Worker{instanceID: instanceID, deps: deps, opts: opts, now: now, logger: opts.Logger}, nil
}

// Run executes one subscription and returns its terminal error code (never
// a daemon body). It returns ErrCompleted on a clean Docker EOF.
var ErrCompleted = errors.New("logs: docker source completed")

// terminalError carries the safe failure code for one run.
type terminalError struct {
	code string
	err  error
}

func (t *terminalError) Error() string {
	if t.err != nil {
		return t.err.Error()
	}
	return "logs: " + t.code
}

func (t *terminalError) Unwrap() error { return t.err }

func failed(code string, err error) *terminalError { return &terminalError{code: code, err: err} }

// errPayloadAborted stops the payload pump when nobody is reading from its
// outbound channel any more. It never reaches a viewer or the broker: the
// pump is torn down by cancellation, which reports its own terminal state.
var errPayloadAborted = errors.New("logs: payload pump aborted")

// RunClaimed streams one claimed subscription.
func (w *Worker) RunClaimed(ctx context.Context, sub *ClaimedSubscription) error {
	if err := ValidateClaimedSubscription(*sub); err != nil {
		return failed(ErrStreamLost, fmt.Errorf("logs: claim invalid: %w", err))
	}
	if sub.AgentInstanceID != w.instanceID {
		return failed(ErrStreamLost, fmt.Errorf("logs: claim instance mismatch"))
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	deadline := w.now().Add(w.opts.MaxRun)
	if expiresAt, err := time.Parse(time.RFC3339, sub.ExpiresAt); err == nil && expiresAt.Before(deadline) {
		deadline = expiresAt
	}
	// The daemon stream is bound to this context, not a client timeout:
	// cancellation closes the body, which is what unblocks the reader.
	streamCtx, cancelStream := context.WithDeadline(runCtx, deadline)
	defer cancelStream()

	fullID, ok := w.deps.Resolver(sub.ContainerKey)
	if !ok {
		return failed(ErrTargetMismatch, fmt.Errorf("logs: container key unresolved"))
	}

	// Inspect is mandatory: TTY is never guessed from bytes, because a wrong
	// guess would either leak multiplex headers or mangle a raw stream.
	tty, err := w.deps.Source.InspectTTY(streamCtx, fullID)
	if err != nil {
		return failed(errCode(err), err)
	}

	follow, err := w.deps.Source.OpenFollow(streamCtx, fullID)
	if err != nil {
		return failed(errCode(err), err)
	}
	body := follow.Body()
	// The body is closed before every join, not only by a deferred close: a
	// fake or raw body that does not honour cancellation would otherwise
	// leave the reader blocked forever and deadlock the join below. Exactly
	// one Close may reach the daemon, so the follow is not torn down twice.
	closeBody := sync.OnceFunc(func() { _ = body.Close() })
	defer closeBody()

	progress := make(chan struct{}, 1)
	// Only past this point does the source exist, so only now may the
	// uploader run and claim readiness.
	up := NewBatchUploader(sub, w.deps.Transport, func(err error) {
		cancelStream()
	})
	up.SetOnProgress(func() {
		select {
		case progress <- struct{}{}:
		default:
		}
	})
	defer up.Stop()

	uploadDone := make(chan struct{})
	go func() {
		defer close(uploadDone)
		up.Run(streamCtx)
	}()

	readerDone := make(chan error, 1)
	go func() {
		readerDone <- w.readLoop(streamCtx, body, tty, up)
	}()

	// Watchdog: the broker declares stream_lost when no batch or heartbeat
	// arrives in time. A silent container still heartbeats, so silence here
	// means the daemon stopped delivering or the API stopped acknowledging.
	idle := time.NewTimer(w.opts.IdleGrace)
	defer idle.Stop()
	resetIdle := func() {
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		idle.Reset(w.opts.IdleGrace)
	}
	resetIdle()

	for {
		select {
		case <-ctx.Done():
			// Agent shutdown: stop reading, close the body, join both loops.
			cancelStream()
			closeBody()
			<-readerDone
			<-uploadDone
			return w.reportTerminal(ctx, sub, failed(ErrStreamLost, ctx.Err()))
		case <-streamCtx.Done():
			if deadlineReached(deadline, w.now()) {
				cancelStream()
				closeBody()
				<-readerDone
				<-uploadDone
				return w.reportTerminal(ctx, sub, failed(ErrStreamLost, ErrExpired))
			}
			cancelStream()
			closeBody()
			<-readerDone
			<-uploadDone
			return w.reportTerminal(ctx, sub, failed(ErrStreamLost, streamCtx.Err()))
		case <-progress:
			resetIdle()
		case err := <-readerDone:
			if err == nil || errors.Is(err, io.EOF) {
				// Clean end of source. The reader already handed every
				// batch to the uploader's queue, so the queue and the
				// uploader's pending buffer can now be flushed while the
				// stream is still live. Cancelling here instead would make
				// drain() discard the container's tail.
				up.Finish()
				<-uploadDone
				// A drain that failed loses the tail: report the failure,
				// never a completion the broker would show as an ended
				// container.
				if upErr := up.LastError(); upErr != nil {
					return w.reportTerminal(ctx, sub, failed(drainFailureCode(upErr), upErr))
				}
				return w.reportTerminal(ctx, sub, ErrCompleted)
			}
			// The reader failed (or the uploader cancelled it): nothing
			// further may be flushed.
			cancelStream()
			closeBody()
			<-uploadDone
			return w.reportTerminal(ctx, sub, failed(drainFailureCode(err), err))
		case <-idle.C:
			// No batch/heartbeat progress within the grace window.
			cancelStream()
			closeBody()
			<-readerDone
			<-uploadDone
			return w.reportTerminal(ctx, sub, failed(ErrStreamLost, fmt.Errorf("logs: no progress")))
		}
	}
}

// reportTerminal posts exactly one terminal result for the subscription and
// returns the run error it was given. Reporting from inside the worker —
// instead of from the claim loop — keeps the broker's terminal state
// consistent whether the worker runs under the claim loop, the smoke
// harness, or a test. A report failure never changes the returned run
// error: the outcome is what the caller acts on, not whether the broker
// acknowledged it.
func (w *Worker) reportTerminal(ctx context.Context, sub *ClaimedSubscription, runErr error) error {
	status := ResultFailed
	var code *string
	switch {
	case runErr == nil || errors.Is(runErr, ErrCompleted):
		status = ResultCompleted
	default:
		var te *terminalError
		if asTerminal(runErr, &te) {
			c := te.code
			code = &c
		} else {
			fallback := ErrStreamLost
			code = &fallback
		}
	}
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), reportTimeout)
	defer cancel()
	if _, err := w.deps.Transport.PostResult(reportCtx, sub.SubscriptionID, ResultRequest{
		AgentInstanceID: w.instanceID,
		Status:          status,
		ErrorCode:       code,
	}); err != nil {
		if w.logger != nil {
			w.logger.Printf("logs result report failed for %s", sub.SubscriptionID)
		}
	}
	return runErr
}

// ErrExpired marks the 2h / broker expiry boundary.
var ErrExpired = errors.New("logs: subscription expired")

func deadlineReached(deadline, now time.Time) bool { return !now.Before(deadline) }

// drainFailureCode keeps the safe code when the uploader was the cause,
// and otherwise classifies the reader error.
func drainFailureCode(err error) string {
	var se *SourceError
	if errors.As(err, &se) {
		return errCode(err)
	}
	var te *terminalError
	if errors.As(err, &te) {
		return te.code
	}
	if errors.Is(err, ErrInvalidFrame) {
		return ErrInvalidStream
	}
	return ErrStreamLost
}

// readLoop decodes the daemon stream into bounded batches and hands them to
// the uploader. It runs in its own goroutine so an idle Docker source still
// produces heartbeats: the uploader owns the send cadence, the reader only
// decodes.
//
// Batching: the reader accumulates completed lines locally and submits a
// batch on either cap — 100 lines, or a serialized body that would exceed
// 32 KiB. Partial batches stay in the uploader's own pending buffer and are
// flushed by its 100 ms timer, so latency stays bounded without the reader
// needing a timer of its own, and the bounded queue (4 batches) only ever
// holds real batches instead of single lines.
//
// Ordering: lines are submitted in the order their LF completes in the
// daemon stream. Each stdout/stderr (or, for TTY, the single raw) stream has
// its own assembler, so a partial line never gets stitched onto a fragment
// of another stream.
func (w *Worker) readLoop(ctx context.Context, body io.Reader, tty bool, up *BatchUploader) error {
	var stdoutA, stderrA, combinedA *lineAssembler
	var src payloadReader
	if tty {
		combinedA = newLineAssembler(StreamCombined)
		src = newRawReader(body, dockerPayloadBufferSize)
	} else {
		stdoutA = newLineAssembler(StreamStdout)
		stderrA = newLineAssembler(StreamStderr)
		src = newDemuxReader(body, dockerPayloadBufferSize)
	}

	pending := make([]LogLine, 0, MaxLinesPerBatch)
	// submit hands the accumulated batch to the uploader and resets pending.
	// It is the only path into the bounded queue, so it fails the stream
	// closed (exactly as a failed upload would) rather than growing memory.
	submit := func() error {
		if len(pending) == 0 {
			return nil
		}
		err := up.Submit(pending)
		pending = pending[:0]
		return err
	}

	// flushTimer bounds the latency of a partial batch. ReadPayload blocks
	// on the daemon read, so the payload pump runs in its own goroutine and
	// this loop selects over it: without the timer, a container that never
	// fills a cap or ends would hold its lines indefinitely, because the
	// uploader's own timer can only flush a batch it has been handed. It is
	// armed only while a batch is actually pending, so a silent container
	// costs nothing beyond the uploader's heartbeat.
	flushTimer := time.NewTimer(flushInterval)
	defer func() {
		if !flushTimer.Stop() {
			select {
			case <-flushTimer.C:
			default:
			}
		}
	}()
	flushTimer.Stop()

	// armFlush (re)starts the flush timer only when a batch is actually
	// waiting, so a silent container does not spin it.
	armFlush := func() {
		if len(pending) == 0 {
			return
		}
		if !flushTimer.Stop() {
			select {
			case <-flushTimer.C:
			default:
			}
		}
		flushTimer.Reset(flushInterval)
	}

	type payloadEvent struct {
		stream int
		chunk  []byte
		err    error
	}
	payloads := make(chan payloadEvent, 1)
	pumpCtx, stopPump := context.WithCancel(ctx)
	defer stopPump()
	go func() {
		defer close(payloads)
		for {
			var ev payloadEvent
			ev.stream, ev.err = src.ReadPayload(func(streamID int, chunk []byte) error {
				cp := append(make([]byte, 0, len(chunk)), chunk...)
				select {
				case payloads <- payloadEvent{stream: streamID, chunk: cp}:
				case <-pumpCtx.Done():
					return errPayloadAborted
				}
				return nil
			})
			// The payload chunks were delivered through the sink above; the
			// event now only carries the terminal outcome.
			ev.stream = 0
			ev.chunk = nil
			select {
			case payloads <- ev:
			case <-pumpCtx.Done():
			}
			if ev.err != nil {
				return
			}
		}
	}()

	// appendLine enforces both batch caps prospectively — checking the size
	// the batch would have once the line joins, so a batch is split before
	// it ever exceeds a cap and gets rejected on the wire.
	appendLine := func(l LogLine) error {
		if len(pending) >= MaxLinesPerBatch {
			if err := submit(); err != nil {
				return err
			}
		}
		// Sequence accounting uses the next unconsumed sequence, which is
		// the one this batch will carry.
		next := append(append(make([]LogLine, 0, len(pending)+1), pending...), l)
		if serializedLinesSize(up.instanceID, up.Sequence()+1, next) > MaxBodyBytes {
			if err := submit(); err != nil {
				return err
			}
		}
		pending = append(pending, l)
		return nil
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok := <-payloads:
			if !ok {
				// The pump exited without reporting: cancellation. Treat it
				// as a cancelled read rather than a completed source.
				return ctx.Err()
			}
			if ev.chunk != nil {
				a, aerr := assemblerFor(&ev.stream, tty, stdoutA, stderrA, combinedA)
				if aerr != nil {
					return aerr
				}
				if aerr := a.write(ev.chunk, appendLine); aerr != nil {
					return aerr
				}
				armFlush()
				continue
			}
			if ev.err != nil {
				if ev.err == io.EOF {
					// Clean end of source: flush each assembler's final
					// unterminated line, then submit what is left.
					var ferr error
					for _, a := range []*lineAssembler{stdoutA, stderrA, combinedA} {
						if a == nil {
							continue
						}
						if err := a.flush(appendLine); err != nil {
							ferr = err
							break
						}
					}
					if ferr != nil {
						return ferr
					}
					return submit()
				}
				return ev.err
			}
			// Chunk with a nil slice: an empty payload. Nothing to do.
		case <-flushTimer.C:
			// Latency bound for a partial batch, kept off the hot path.
			if len(pending) > 0 {
				if err := submit(); err != nil {
					return err
				}
			}
		}
	}
}

// assemblerFor selects the assembler for a payload's stream id. TTY bodies
// carry a single combined stream (id 0); multiplexed bodies only ever carry
// stdout/stderr, and anything else is invalid framing.
func assemblerFor(streamID *int, tty bool, out, errS, combined *lineAssembler) (*lineAssembler, error) {
	if streamID == nil {
		return nil, ErrInvalidFrame
	}
	if tty {
		if *streamID != 0 {
			return nil, ErrInvalidFrame
		}
		return combined, nil
	}
	switch *streamID {
	case streamIDStdout:
		return out, nil
	case streamIDStderr:
		return errS, nil
	default:
		return nil, ErrInvalidFrame
	}
}
