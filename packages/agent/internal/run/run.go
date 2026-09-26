package run

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	mathrand "math/rand"
	"strconv"
	"sync"
	"time"

	"github.com/vps-manager/agent/internal/config"
	"github.com/vps-manager/agent/internal/metrics"
	"github.com/vps-manager/agent/internal/push"
	"github.com/vps-manager/agent/internal/state"
)

// MetricsCollector is the interface for collecting system metrics.
type MetricsCollector interface {
	Collect(ctx context.Context) (*metrics.SystemMetrics, error)
}

// MetricsPusher is the interface for pushing metrics to the backend.
// Typed result carries the structured ingest acknowledgement; Docker is nil
// for config-only, stripped, and invalid-ack fail-closed responses.
type MetricsPusher interface {
	PushWithRetry(ctx context.Context, m *metrics.SystemMetrics) (*push.PushResult, error)
	Push(ctx context.Context, m *metrics.SystemMetrics) (*push.PushResult, error)
}

// DockerState is the narrow durable-state contract needed by the Runner.
// It is implemented by *state.Store methods already present; the Runner
// never touches state files directly.
type DockerState interface {
	InstanceID() string
	Sequence() uint64
	ReserveSequence() (uint64, error)
	GetWatermark() state.Watermark
	GetPending() *state.PendingBatch
	PersistPending(state.PendingBatch) error
	CommitAcknowledgement(batchID, snapshotID, agentInstanceID string, committed state.Watermark) error
}

type Runner struct {
	cfg       *config.Config
	collector MetricsCollector
	pusher    MetricsPusher
	docker    DockerState
	runMu     sync.Mutex
}

// New creates a new Runner without durable Docker state: it pushes host
// metrics only and strips any Docker branch (fail closed — there is no
// durable identity to bind on the server).
func New(cfg *config.Config, collector MetricsCollector, pusher MetricsPusher) *Runner {
	return &Runner{
		cfg:       cfg,
		collector: collector,
		pusher:    pusher,
	}
}

// NewWithState creates a Runner with durable Docker state.
// A nil st behaves like New.
func NewWithState(cfg *config.Config, collector MetricsCollector, pusher MetricsPusher, st DockerState) *Runner {
	return &Runner{
		cfg:       cfg,
		collector: collector,
		pusher:    pusher,
		docker:    st,
	}
}

// SetDockerState attaches or detaches durable state after construction.
func (r *Runner) SetDockerState(st DockerState) {
	r.docker = st
}

// FinalizeDocker attaches durable identity and event-protocol metadata before
// PersistPending. The stamped sourceSequence is provisional: pushWithState
// rebinds every fresh snapshot at push time (minimal cycles to a durably
// reserved sequence, complete batches to the durable sequence) because the
// stamp alone repeats across cycles that never persist or commit.
func FinalizeDocker(st DockerState) func(*metrics.DockerMetrics) {
	return func(batch *metrics.DockerMetrics) {
		if batch == nil || st == nil {
			return
		}
		batch.AgentInstanceID = st.InstanceID()
		batch.SourceSequence = strconv.FormatUint(st.Sequence(), 10)
		batch.SnapshotID = opaqueID()
		if batch.EventWindow != nil && batch.FromWatermark != nil && batch.ProposedWatermark != nil {
			batch.BatchID = opaqueID()
		}
	}
}

func opaqueID() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// DockerEventInput supplies the durable fixed-window inputs for one
// collection cycle. While a pending batch exists the provider suppresses
// event input entirely so no later window can be created before the ack;
// otherwise the window runs from the committed watermark to now minus one
// second, carrying the persisted boundary digests.
func DockerEventInput(st DockerState) metrics.DockerEventInputProvider {
	return func() (metrics.DockerEventInput, bool) {
		if st == nil || st.GetPending() != nil {
			return metrics.DockerEventInput{}, false
		}
		w := st.GetWatermark()
		return metrics.DockerEventInput{
			SinceNano:       strconv.FormatInt(w.TimeNano, 10),
			UntilNano:       strconv.FormatInt(time.Now().Add(-time.Second).UnixNano(), 10),
			AgentInstanceID: st.InstanceID(),
			FromDigests:     w.BoundaryDigests,
		}, true
	}
}

func (r *Runner) RunOnce(ctx context.Context) error {
	r.runMu.Lock()
	defer r.runMu.Unlock()
	log.Println("collecting metrics...")
	m, err := r.collector.Collect(ctx)
	if err != nil {
		return fmt.Errorf("collect: %w", err)
	}
	log.Printf("metrics collected: cpu=%.1f%% mem=%.1f%% disk=%.1f%% load=%.2f",
		m.CPU, m.Memory, m.Disk, m.LoadAverage)

	log.Println("pushing metrics...")
	if err := r.pushWithState(ctx, m); err != nil {
		return fmt.Errorf("push: %w", err)
	}
	log.Println("metrics pushed successfully")
	return nil
}

// RunLoop collects and pushes metrics on the configured interval.
// It uses retry/backoff on push failures. Returns when context is cancelled.
func (r *Runner) RunLoop(ctx context.Context) error {
	interval := time.Duration(r.cfg.IntervalSeconds) * time.Second
	log.Printf("starting loop mode (interval=%v)", interval)

	// Initial collection immediately
	if err := r.collectAndPush(ctx); err != nil {
		if push.IsFatal(err) {
			return fmt.Errorf("fatal push error, stopping: %w", err)
		}
		log.Printf("initial push failed: %v", err)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("loop stopped")
			return ctx.Err()
		case <-ticker.C:
			if err := r.collectAndPush(ctx); err != nil {
				// Fatal errors (auth, bad request) stop the loop immediately
				if push.IsFatal(err) {
					return fmt.Errorf("fatal push error, stopping: %w", err)
				}
				log.Printf("push failed: %v", err)
				// Add some backoff to avoid busy-looping on persistent errors
				backoff := time.Duration(mathrand.Int63n(int64(interval) / 2))
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(backoff):
				}
			}
		}
	}
}

func (r *Runner) collectAndPush(ctx context.Context) error {
	m, err := r.collector.Collect(ctx)
	if err != nil {
		return fmt.Errorf("collect: %w", err)
	}

	if err := r.pushWithState(ctx, m); err != nil {
		return fmt.Errorf("push: %w", err)
	}

	return nil
}

// pushWithState implements I2 pending/ack semantics around PushWithRetry.
// Pending replay takes precedence over the freshly collected snapshot: while
// a durable pending exists the event provider (DockerEventInput) suppresses
// fresh event windows, so the fresh collection is batch-less by construction
// and the durable payload must still be replayed until acknowledged. A
// runner without durable state never emits a Docker branch (fail closed:
// there is no identity to bind); host metrics always push. A complete fresh
// batch binds the durable sequence and persists the exact marshalled branch
// before push (the persist bump keeps the counter above the bound value),
// replays the exact durable payload after restart, validates the typed ack,
// and commits only on the matching committed watermark. A minimal fresh
// snapshot (identity only, no event branch) durably reserves its sequence
// before push: minimal cycles never persist or commit, so without the
// reservation the finalize-time stamp would repeat the same value every
// cycle and after every restart, which the server rejects as a duplicate.
func (r *Runner) pushWithState(ctx context.Context, m *metrics.SystemMetrics) error {
	if r.docker != nil {
		if existing := r.docker.GetPending(); existing != nil {
			// A pending batch already exists: never collect/create a later
			// event window. Reconstruct the exact durable Docker branch,
			// validate it, attach it to the newly collected host metrics,
			// and push the reconstructed exact branch.
			// Never log event bodies; log only counts/ids.
			recon, err := reconstructPending(existing, r.docker.InstanceID())
			if err != nil {
				log.Printf("docker: pending batchId=%q corrupt (%v), fail closed, pending preserved", existing.BatchID, err)
				return fmt.Errorf("docker: pending batch %q corrupt: %w", existing.BatchID, err)
			}
			retry := *m
			retry.Docker = recon
			log.Printf("docker: pending batchId=%q exists, retrying exact pending payload", existing.BatchID)
			res, err := r.pusher.PushWithRetry(ctx, &retry)
			if err != nil {
				// 409, transport failures, fatal errors: leave pending.
				return err
			}
			return r.handleAck(res, existing)
		}
	} else if m != nil && m.Docker != nil {
		// Fail closed: missing durable state means no agentInstanceId/
		// snapshotId lifecycle to bind on the server. Never transmit the
		// branch; host metrics keep flowing.
		log.Printf("docker: durable state unavailable, stripping docker branch (host metrics only)")
		m = stripDocker(m)
	}

	batch := m.Docker
	if !isCompleteBatch(batch) {
		// Minimal snapshot (identity attached by the finalize hook) or a
		// stripped branch: no pending interaction, but each distinct
		// snapshotId must carry a distinct sourceSequence. Durably reserve
		// one first so a restart can never reissue it; if the reservation
		// cannot be written, push nothing — transmitting the finalize-time
		// stamp would duplicate a sequence the server already ingested.
		if batch != nil && r.docker != nil {
			reserved, err := r.docker.ReserveSequence()
			if err != nil {
				log.Printf("docker: reserve source sequence failed, refusing stale-stamp push: %v", err)
				return fmt.Errorf("docker: reserve sequence: %w", err)
			}
			batch.SourceSequence = strconv.FormatUint(reserved, 10)
		}
		if _, err := r.pusher.PushWithRetry(ctx, m); err != nil {
			return err
		}
		return nil
	}

	// No existing pending: bind the batch to the durable sequence before
	// marshaling; this value is then preserved in pending JSON and replayed
	// unchanged on retry. Every path that transmits a sequence has already
	// durably advanced the counter past it (reserve-before-push for minimal,
	// persist/commit around the batch), so this read is strictly above every
	// previously transmitted value — including across restarts.
	batch.SourceSequence = strconv.FormatUint(r.docker.Sequence(), 10)
	// marshal the exact branch with stable JSON, compute its digest, and
	// durably persist payload plus metadata before push.
	cand, err := derivePendingWithPayload(batch, r.docker.InstanceID())
	if err != nil {
		log.Printf("docker: collected batch invalid, pushing host-only")
		stripped := stripDocker(m)
		if _, pushErr := r.pusher.PushWithRetry(ctx, stripped); pushErr != nil {
			return pushErr
		}
		return fmt.Errorf("docker: collected batch invalid: %w", err)
	}
	if err := r.docker.PersistPending(cand); err != nil {
		// A durable write failure is not safe to downgrade to a host-only
		// push: doing so would acknowledge a snapshot whose Docker payload
		// was never durably recorded. Retry the same collection only after
		// the state store is healthy; the existing pending state is untouched.
		log.Printf("docker: persist batchId=%q failed, refusing host-only downgrade", cand.BatchID)
		return fmt.Errorf("docker: persist pending: %w", err)
	}
	res, err := r.pusher.PushWithRetry(ctx, m)
	if err != nil {
		// Crash after write/before request retries the single pending
		// batch next cycle; transport/409 failures leave pending.
		return err
	}
	return r.handleAck(res, &cand)
}

// handleAck validates the typed ack against the durable pending and the
// configured VPS/instance, then commits. Nil/malformed/mismatched acks,
// unexpected ingest statuses, 409-equivalents, and commit errors leave
// pending/watermark unchanged. committed, already_committed, and
// replay_ignored are accepted; the committed watermark must equal the pending
// proposed watermark exactly or pending is preserved.
func (r *Runner) handleAck(res *push.PushResult, pending *state.PendingBatch) error {
	if res == nil || res.Docker == nil {
		// The batch got a config-only response (old server, stripped retry,
		// or invalid ack failed closed to nil): host succeeded but the
		// batch is unacknowledged. Preserve pending for retry and
		// surface a non-fatal batch error. Never log event bodies.
		log.Printf("docker: missing ack, host success, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: missing acknowledgement for batch %q", pending.BatchID)
	}
	ack := res.Docker
	switch ack.IngestStatus {
	case "committed", "already_committed", "replay_ignored":
		// All successful ingest outcomes carry the server's durable watermark.
		// replay_ignored is a successful idempotent outcome, not a failure.
	default:
		log.Printf("docker: ingestStatus=%q not committable, pending batchId=%q preserved", ack.IngestStatus, pending.BatchID)
		return fmt.Errorf("docker: ingest status %q not committable", ack.IngestStatus)
	}
	if r.cfg != nil && r.cfg.VpsId != "" && res.VpsId != "" && res.VpsId != r.cfg.VpsId {
		log.Printf("docker: vps mismatch, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: vps mismatch")
	}
	if r.cfg != nil && r.cfg.VpsId != "" && res.VpsId == "" {
		// Empty server VPS with a batch ack cannot be matched safely.
		log.Printf("docker: empty vps in ack, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: vps mismatch")
	}
	if ack.BatchId != pending.BatchID || ack.SnapshotId != pending.SnapshotID || ack.AgentInstanceId != pending.AgentInstanceID {
		log.Printf("docker: ack id mismatch, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: acknowledgement id mismatch")
	}
	if ack.AgentInstanceId != r.docker.InstanceID() {
		log.Printf("docker: ack instance mismatch, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: acknowledgement instance mismatch")
	}
	committed, err := ackWatermarkToState(ack)
	if err != nil {
		log.Printf("docker: ack watermark invalid, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: acknowledgement watermark invalid: %w", err)
	}
	// Committed/proposed relationship: the server must confirm exactly the
	// batch this runner persisted. A stale, replayed, or foreign watermark
	// never advances local state, even if the store would reject it later.
	if !watermarkEqual(committed, pending.ProposedWatermark) {
		log.Printf("docker: committed watermark mismatch, pending batchId=%q preserved", pending.BatchID)
		return fmt.Errorf("docker: committed watermark mismatch")
	}
	if err := r.docker.CommitAcknowledgement(ack.BatchId, ack.SnapshotId, ack.AgentInstanceId, committed); err != nil {
		log.Printf("docker: commit batchId=%q failed, pending preserved", pending.BatchID)
		return fmt.Errorf("docker: commit: %w", err)
	}
	log.Printf("docker: committed batchId=%q watermark=%d", pending.BatchID, committed.TimeNano)
	return nil
}

// isCompleteBatch reports the all-or-none event protocol: batch carries
// events only when batchId+events+eventWindow+from+proposed are all present.
func isCompleteBatch(batch *metrics.DockerMetrics) bool {
	if batch == nil {
		return false
	}
	if batch.BatchID == "" {
		return false
	}
	if batch.Events == nil {
		return false
	}
	if batch.EventWindow == nil {
		return false
	}
	if batch.FromWatermark == nil || batch.ProposedWatermark == nil {
		return false
	}
	return true
}

func stripDocker(m *metrics.SystemMetrics) *metrics.SystemMetrics {
	if m == nil {
		return nil
	}
	cp := *m
	cp.Docker = nil
	return &cp
}

// derivePendingWithPayload builds the durable representation from a collected
// complete batch. The exact Docker branch is marshalled with stable JSON
// (encoding/json over the fixed struct shape), its SHA-256 digest computed,
// and both payload and metadata persisted in PendingBatch before push.
func derivePendingWithPayload(batch *metrics.DockerMetrics, instanceID string) (state.PendingBatch, error) {
	var zero state.PendingBatch
	if batch == nil || batch.SourceSequence == "" || batch.SourceSequence == "0" {
		return zero, fmt.Errorf("sourceSequence must be positive")
	}
	if batch == nil {
		return zero, fmt.Errorf("nil batch")
	}
	if batch.SchemaVersion != metrics.DockerMetricsSchemaVersion {
		return zero, fmt.Errorf("schemaVersion %d, want %d", batch.SchemaVersion, metrics.DockerMetricsSchemaVersion)
	}
	if batch.AgentInstanceID == "" || batch.AgentInstanceID != instanceID {
		return zero, fmt.Errorf("agentInstanceId mismatch")
	}
	from, err := watermarkToState(batch.FromWatermark)
	if err != nil {
		return zero, fmt.Errorf("fromWatermark: %w", err)
	}
	proposed, err := watermarkToState(batch.ProposedWatermark)
	if err != nil {
		return zero, fmt.Errorf("proposedWatermark: %w", err)
	}
	if batch.EventWindow == nil {
		return zero, fmt.Errorf("nil eventWindow")
	}
	until, err := parseNano(batch.EventWindow.Until)
	if err != nil {
		return zero, fmt.Errorf("eventWindow.until: %w", err)
	}
	if batch.Events == nil {
		return zero, fmt.Errorf("nil events")
	}
	digest, err := eventsDigest(*batch.Events)
	if err != nil {
		return zero, fmt.Errorf("events digest: %w", err)
	}
	payload, err := json.Marshal(batch)
	if err != nil {
		return zero, fmt.Errorf("batch marshal: %w", err)
	}
	if len(payload) == 0 || len(payload) > state.MaxPendingPayloadBytes {
		return zero, fmt.Errorf("pending payload oversize")
	}
	sum := sha256.Sum256(payload)
	return state.PendingBatch{
		BatchID:              batch.BatchID,
		SnapshotID:           batch.SnapshotID,
		SourceSequence:       batch.SourceSequence,
		AgentInstanceID:      batch.AgentInstanceID,
		FromWatermark:        from,
		ProposedWatermark:    proposed,
		EventsDigest:         digest,
		EventWindowUntil:     until,
		PendingPayloadJSON:   string(payload),
		PendingPayloadDigest: hex.EncodeToString(sum[:]),
	}, nil
}

// reconstructPending rebuilds the exact DockerMetrics branch from durable
// pending state. It fail-closes on any corruption: empty payload, digest
// mismatch, malformed JSON, non-canonical bytes, incomplete batch, instance
// mismatch, or metadata/payload divergence. On success the returned branch
// re-marshals to the exact stored bytes.
func reconstructPending(p *state.PendingBatch, instanceID string) (*metrics.DockerMetrics, error) {
	if p == nil {
		return nil, fmt.Errorf("nil pending")
	}
	if p.AgentInstanceID == "" || p.AgentInstanceID != instanceID {
		return nil, fmt.Errorf("agentInstanceId mismatch")
	}
	if p.PendingPayloadJSON == "" {
		return nil, fmt.Errorf("empty pending payload")
	}
	if len(p.PendingPayloadJSON) > state.MaxPendingPayloadBytes {
		return nil, fmt.Errorf("pending payload oversize")
	}
	if p.PendingPayloadDigest == "" {
		return nil, fmt.Errorf("empty pending payload digest")
	}
	sum := sha256.Sum256([]byte(p.PendingPayloadJSON))
	if hex.EncodeToString(sum[:]) != p.PendingPayloadDigest {
		return nil, fmt.Errorf("pending payload digest mismatch")
	}
	var batch metrics.DockerMetrics
	dec := json.NewDecoder(bytes.NewReader([]byte(p.PendingPayloadJSON)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		return nil, fmt.Errorf("invalid pending payload: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("trailing pending payload")
		}
		return nil, fmt.Errorf("trailing pending payload: %w", err)
	}
	if batch.SchemaVersion != metrics.DockerMetricsSchemaVersion {
		// Pre-discriminator (schemaVersion-less) pending payloads are old
		// format: fail closed, never auto-migrate.
		return nil, fmt.Errorf("schemaVersion %d, want %d", batch.SchemaVersion, metrics.DockerMetricsSchemaVersion)
	}
	if !isCompleteBatch(&batch) {
		return nil, fmt.Errorf("incomplete batch")
	}
	if batch.AgentInstanceID != instanceID {
		return nil, fmt.Errorf("agentInstanceId mismatch")
	}
	canon, err := json.Marshal(&batch)
	if err != nil {
		return nil, fmt.Errorf("batch remarshal: %w", err)
	}
	if string(canon) != p.PendingPayloadJSON {
		return nil, fmt.Errorf("pending payload not canonical")
	}
	from, err := watermarkToState(batch.FromWatermark)
	if err != nil {
		return nil, fmt.Errorf("fromWatermark: %w", err)
	}
	if !watermarkEqual(from, p.FromWatermark) {
		return nil, fmt.Errorf("fromWatermark mismatch")
	}
	proposed, err := watermarkToState(batch.ProposedWatermark)
	if err != nil {
		return nil, fmt.Errorf("proposedWatermark: %w", err)
	}
	if !watermarkEqual(proposed, p.ProposedWatermark) {
		return nil, fmt.Errorf("proposedWatermark mismatch")
	}
	if batch.EventWindow == nil {
		return nil, fmt.Errorf("nil eventWindow")
	}
	until, err := parseNano(batch.EventWindow.Until)
	if err != nil {
		return nil, fmt.Errorf("eventWindow.until: %w", err)
	}
	if until != p.EventWindowUntil {
		return nil, fmt.Errorf("eventWindowUntil mismatch")
	}
	if batch.Events == nil {
		return nil, fmt.Errorf("nil events")
	}
	digest, err := eventsDigest(*batch.Events)
	if err != nil {
		return nil, fmt.Errorf("events digest: %w", err)
	}
	if digest != p.EventsDigest {
		return nil, fmt.Errorf("eventsDigest mismatch")
	}
	if batch.BatchID != p.BatchID || batch.SnapshotID != p.SnapshotID {
		return nil, fmt.Errorf("batch id mismatch")
	}
	return &batch, nil
}

func watermarkToState(w *metrics.DockerEventWatermark) (state.Watermark, error) {
	var zero state.Watermark
	if w == nil {
		return zero, fmt.Errorf("nil watermark")
	}
	n, err := parseNano(w.TimeNano)
	if err != nil {
		return zero, err
	}
	digests := append([]string(nil), w.BoundaryDigests...)
	if digests == nil {
		digests = []string{}
	}
	return state.Watermark{TimeNano: n, BoundaryDigests: digests}, nil
}

func parseNano(s string) (int64, error) {
	if s == "" || len(s) > 32 {
		return 0, fmt.Errorf("bad nano")
	}
	if s != "0" {
		if s[0] < '1' || s[0] > '9' {
			return 0, fmt.Errorf("bad nano")
		}
		for i := 1; i < len(s); i++ {
			if s[i] < '0' || s[i] > '9' {
				return 0, fmt.Errorf("bad nano")
			}
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("bad nano: %w", err)
	}
	if n < 0 {
		return 0, fmt.Errorf("bad nano")
	}
	return n, nil
}

// eventsDigest is the bounded retry-equality representation: SHA-256 hex
// over the canonical JSON encoding of the transmitted events.
func eventsDigest(evs []metrics.DockerEvent) (string, error) {
	if evs == nil {
		return "", fmt.Errorf("nil events")
	}
	b, err := json.Marshal(evs)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func watermarkEqual(a, b state.Watermark) bool {
	if a.TimeNano != b.TimeNano || len(a.BoundaryDigests) != len(b.BoundaryDigests) {
		return false
	}
	for i := range a.BoundaryDigests {
		if a.BoundaryDigests[i] != b.BoundaryDigests[i] {
			return false
		}
	}
	return true
}

func ackWatermarkToState(ack *push.DockerAck) (state.Watermark, error) {
	if ack == nil {
		return state.Watermark{}, fmt.Errorf("nil ack")
	}
	n, err := parseNano(ack.CommittedWatermark.TimeNano)
	if err != nil {
		return state.Watermark{}, err
	}
	digests := append([]string(nil), ack.CommittedWatermark.BoundaryDigests...)
	if digests == nil {
		digests = []string{}
	}
	return state.Watermark{TimeNano: n, BoundaryDigests: digests}, nil
}
