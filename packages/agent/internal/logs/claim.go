package logs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// ClaimWorker is the agent's logs goroutine. It polls the broker for a
// waiting viewer subscription and streams it to completion, bounded at
// MaxActiveSubscriptions concurrent Docker follow sources.
//
// It is separate from the commands worker and metrics by construction: this
// loop only ever asks whether a viewer is waiting. It never reads log
// history on its own, never touches the receipt store, and never blocks the
// other workers — each Docker source lives in its own goroutine on its own
// context, and a full source slot is simply left empty until the next poll.
//
// Fail-closed behaviour:
//   - A claim 404 means this API predates the logs route. The worker stops
//     for the lifetime of the process: no error spam, no fallback, and no
//     change to any other worker.
//   - Claim 401/403 stops it too (the credential is rejected).
//   - A per-subscription failure is reported once with a safe code, after
//     which that subscription is done.
const (
	// MaxActiveSubscriptions bounds concurrent Docker follow sources.
	MaxActiveSubscriptions = 4
	// ClaimPollInterval is the idle poll cadence while a slot is free.
	ClaimPollInterval = time.Second
)

// ClaimWorkerOptions configures the logs goroutine.
type ClaimWorkerOptions struct {
	// Interval overrides the claim poll cadence (tests).
	Interval time.Duration
	// Now overrides the clock used by the per-subscription Worker.
	Now func() time.Time
	// Logger receives operational messages. nil disables logging.
	Logger *log.Logger
}

// ClaimWorker owns this agent's subscription set.
type ClaimWorker struct {
	instanceID string
	transport  Transport
	source     DockerSourcePort
	resolve    TargetResolver
	opts       WorkerOptions
	interval   time.Duration
	logger     *log.Logger

	mu      sync.Mutex
	active  map[string]context.CancelFunc
	stopped bool
}

// NewClaimWorker builds the logs goroutine. All dependencies are required.
func NewClaimWorker(instanceID string, t Transport, source DockerSourcePort, resolve TargetResolver, opts ClaimWorkerOptions) (*ClaimWorker, error) {
	if !validOpaqueID(instanceID, MaxInstanceIDLen) {
		return nil, fmt.Errorf("bad agentInstanceId")
	}
	if t == nil || source == nil || resolve == nil {
		return nil, fmt.Errorf("nil logs claim dependency")
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = ClaimPollInterval
	}
	return &ClaimWorker{
		instanceID: instanceID,
		transport:  t,
		source:     source,
		resolve:    resolve,
		opts:       WorkerOptions{MaxRun: DefaultWorkerOptions().MaxRun, IdleGrace: DefaultWorkerOptions().IdleGrace, Now: opts.Now},
		interval:   interval,
		logger:     opts.Logger,
		active:     map[string]context.CancelFunc{},
	}, nil
}

// Run polls for subscriptions until ctx is cancelled. It joins every
// in-flight source before returning, so shutdown never leaks a goroutine.
func (c *ClaimWorker) Run(ctx context.Context) {
	defer c.joinAll()
	for {
		if err := c.pollOnce(ctx); err != nil {
			if err == errStopWorker {
				return
			}
			c.logf("logs claim failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.interval):
		}
	}
}

// errStopWorker is the internal sentinel for a terminal claim failure.
var errStopWorker = fmt.Errorf("logs: worker stopped")

// pollOnce claims at most one subscription per free slot.
func (c *ClaimWorker) pollOnce(ctx context.Context) error {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return errStopWorker
	}
	free := MaxActiveSubscriptions - len(c.active)
	c.mu.Unlock()
	if free <= 0 {
		return nil
	}
	sub, err := c.transport.Claim(ctx, c.instanceID)
	if err != nil {
		if IsGone(err) || IsAuth(err) || IsFatal(err) {
			// Terminal: an old API, a rejected credential, or a malformed
			// answer. Stop this worker for the process lifetime.
			c.mu.Lock()
			c.stopped = true
			c.mu.Unlock()
			return errStopWorker
		}
		return err
	}
	if sub == nil {
		// No viewer waiting; nothing to do this cycle.
		return nil
	}
	c.startSubscription(ctx, sub)
	return nil
}

// startSubscription runs one subscription in its own goroutine, registered
// so shutdown can cancel and join it.
func (c *ClaimWorker) startSubscription(parent context.Context, sub *ClaimedSubscription) {
	streamCtx, cancel := context.WithCancel(parent)
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		cancel()
		return
	}
	c.active[sub.SubscriptionID] = cancel
	c.mu.Unlock()

	go func() {
		defer cancel()
		defer func() {
			c.mu.Lock()
			delete(c.active, sub.SubscriptionID)
			c.mu.Unlock()
		}()
		w, err := NewWorker(c.instanceID, StreamDeps{
			Transport: c.transport,
			Source:    c.source,
			Resolver:  c.resolve,
		}, c.opts)
		if err != nil {
			c.logf("logs worker unavailable: %v", err)
			return
		}
		runErr := w.RunClaimed(streamCtx, sub)
		c.logOutcome(sub, runErr)
	}()
}

// logOutcome writes one sanitized line for the outcome. The terminal result
// itself is posted exactly once by the worker, so this is logging only.
func (c *ClaimWorker) logOutcome(sub *ClaimedSubscription, runErr error) {
	if runErr == nil || errors.Is(runErr, ErrCompleted) {
		c.logf("logs subscription %s completed", sub.SubscriptionID)
		return
	}
	var te *terminalError
	if asTerminal(runErr, &te) {
		c.logf("logs subscription %s ended (%s)", sub.SubscriptionID, te.code)
		return
	}
	c.logf("logs subscription %s ended", sub.SubscriptionID)
}

// reportTimeout bounds the terminal report.
const reportTimeout = 5 * time.Second

func asTerminal(err error, target **terminalError) bool {
	if te, ok := err.(*terminalError); ok {
		*target = te
		return true
	}
	return false
}

// Stop cancels every active source and prevents new claims. Run returns
// after joining them.
func (c *ClaimWorker) Stop() {
	c.mu.Lock()
	c.stopped = true
	for _, cancel := range c.active {
		cancel()
	}
	c.mu.Unlock()
}

// joinAll waits for every active source to finish.
func (c *ClaimWorker) joinAll() {
	for {
		c.mu.Lock()
		n := len(c.active)
		c.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(joinPollInterval)
	}
}

const joinPollInterval = 5 * time.Millisecond

// ActiveCount reports in-flight subscriptions (diagnostics/tests).
func (c *ClaimWorker) ActiveCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.active)
}

func (c *ClaimWorker) logf(format string, args ...any) {
	if c.logger == nil {
		return
	}
	c.logger.Printf(format, args...)
}
