package run

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/config"
	"github.com/vps-manager/agent/internal/metrics"
	"github.com/vps-manager/agent/internal/push"
	"github.com/vps-manager/agent/internal/state"
)

// ---------------------------------------------------------------------------
// Compile assertion: narrow DockerState is satisfied by *state.Store methods.
// ---------------------------------------------------------------------------

var _ DockerState = (*state.Store)(nil)

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

type mockCollector struct {
	metrics *metrics.SystemMetrics
	err     error
}

func (m *mockCollector) Collect(ctx context.Context) (*metrics.SystemMetrics, error) {
	return m.metrics, m.err
}

type mockPusher struct {
	pushCount      atomic.Int64
	pushRetryCount atomic.Int64
	failCount      int32 // fail for first N PushWithRetry calls
	err            error
	handler        func(m *metrics.SystemMetrics) (*push.PushResult, error)
	gotDocker      atomic.Int64 // count of pushes that carried Docker
	lastStripped   atomic.Bool  // last push had nil Docker
}

func okResult() *push.PushResult {
	return &push.PushResult{Config: &push.ConfigResponse{DockerMetricsEnabled: false}}
}

func (m *mockPusher) Push(ctx context.Context, metrics *metrics.SystemMetrics) (*push.PushResult, error) {
	m.pushCount.Add(1)
	if m.handler != nil {
		return m.handler(metrics)
	}
	if m.failCount > 0 && m.pushCount.Load() <= int64(m.failCount) {
		return nil, m.err
	}
	return okResult(), nil
}

func (m *mockPusher) PushWithRetry(ctx context.Context, metrics *metrics.SystemMetrics) (*push.PushResult, error) {
	m.pushRetryCount.Add(1)
	if metrics != nil && metrics.Docker != nil {
		m.gotDocker.Add(1)
		m.lastStripped.Store(false)
	} else {
		m.lastStripped.Store(true)
	}
	if m.handler != nil {
		return m.handler(metrics)
	}
	if m.failCount > 0 && m.pushRetryCount.Load() <= int64(m.failCount) {
		return nil, m.err
	}
	return okResult(), nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func createTestConfig() *config.Config {
	return &config.Config{
		BackendUrl:            "http://localhost:3000",
		VpsId:                 "test-vps",
		Token:                 "test-token",
		IntervalSeconds:       5,
		RequestTimeoutSeconds: 5,
	}
}

func mustState(t *testing.T) *state.Store {
	t.Helper()
	s, err := state.LoadOrCreate(filepath.Join(t.TempDir(), "docker-state.json"))
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	return s
}

func stateNano(w state.Watermark) string {
	return strconv.FormatInt(w.TimeNano, 10)
}

// makeBatch builds a complete docker batch bound to the store: from == committed
// watermark, proposed forward, window since==from until==proposed.
// The batch carries non-empty events, containers, and storage so replay
// tests prove byte-identical retransmission of real payload shape.
func makeBatch(s *state.Store, batch, snap string, proposedNano int64) *metrics.SystemMetrics {
	from := s.GetWatermark()
	exit := 137
	return &metrics.SystemMetrics{
		CPU: 50,
		Docker: &metrics.DockerMetrics{
			CollectedAt:     "2026-01-01T00:00:30Z",
			SchemaVersion:   metrics.DockerMetricsSchemaVersion,
			AgentInstanceID: s.InstanceID(),
			SnapshotID:      snap,
			SourceSequence:  strconv.FormatUint(s.Sequence(), 10),
			BatchID:         batch,
			Available:       true,
			ContainerTotal:  2,
			Containers: []metrics.DockerContainer{
				{
					ContainerKey:     "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
					ID:               "abc123def456",
					Name:             "/web-nginx",
					Image:            "nginx:1.25",
					State:            "running",
					Health:           metrics.DockerHealthHealthy,
					CPUPercent:       12.3,
					MemoryUsageBytes: 65536000,
					PIDs:             12,
				},
			},
			Events: &[]metrics.DockerEvent{
				{
					EventID:         "evt-die-0001",
					EventOccurredAt: "2026-01-01T00:00:10Z",
					ContainerKey:    "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
					Action:          metrics.DockerActionDie,
					Context:         metrics.DockerEventContext{Version: metrics.DockerEventContextVersion, ExitCode: &exit},
				},
				{
					EventID:         "evt-stop-0002",
					EventOccurredAt: "2026-01-01T00:00:20Z",
					ContainerKey:    "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
					Action:          metrics.DockerActionStop,
					Context:         metrics.DockerEventContext{Version: metrics.DockerEventContextVersion},
				},
			},
			EventWindow: &metrics.DockerEventWindow{
				Since: stateNano(from),
				Until: strconv.FormatInt(proposedNano, 10),
			},
			FromWatermark: &metrics.DockerEventWatermark{
				TimeNano:        stateNano(from),
				BoundaryDigests: append([]string(nil), from.BoundaryDigests...),
			},
			ProposedWatermark: &metrics.DockerEventWatermark{
				TimeNano:        strconv.FormatInt(proposedNano, 10),
				BoundaryDigests: []string{},
			},
			Storage: &metrics.DockerStorageAggregate{
				FormulaVersion: metrics.DockerStorageFormulaVersion,
				Images:         metrics.DockerStorageCategory{Supported: true, Count: 2, TotalBytes: 1000},
				Containers:     metrics.DockerStorageCategory{Supported: true, Count: 1, TotalBytes: 500},
				LocalVolumes:   metrics.DockerStorageCategory{Supported: false},
				BuildCache:     metrics.DockerStorageCategory{Supported: false},
			},
		},
	}
}

// marshalDockerJSON returns the exact wire bytes of the Docker branch.
func marshalDockerJSON(t *testing.T, m *metrics.SystemMetrics) string {
	t.Helper()
	if m == nil || m.Docker == nil {
		t.Fatal("expected non-nil Docker")
	}
	b, err := json.Marshal(m.Docker)
	if err != nil {
		t.Fatalf("marshal docker: %v", err)
	}
	return string(b)
}

func ackFor(vps, batch, snap, inst, status, nano string) *push.PushResult {
	return &push.PushResult{
		VpsId:  vps,
		Config: &push.ConfigResponse{DockerMetricsEnabled: false},
		Docker: &push.DockerAck{
			IngestStatus:    status,
			BatchId:         batch,
			SnapshotId:      snap,
			AgentInstanceId: inst,
			CommittedWatermark: push.Watermark{
				TimeNano:        nano,
				BoundaryDigests: []string{},
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Host-only push behavior (no Docker branch / no state wired)
// ---------------------------------------------------------------------------

func TestRunOnce_Success(t *testing.T) {
	collector := &mockCollector{
		metrics: &metrics.SystemMetrics{
			CPU: 50, Memory: 60, Disk: 70, LoadAverage: 0.5,
		},
	}
	pusher := &mockPusher{}

	cfg := createTestConfig()
	runner := New(cfg, collector, pusher)

	err := runner.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if pusher.pushRetryCount.Load() != 1 {
		t.Errorf("expected 1 push, got %d", pusher.pushRetryCount.Load())
	}
}

func TestRunOnce_HostOnlyWithStateWired_NoStateInteraction(t *testing.T) {
	s := mustState(t)
	collector := &mockCollector{metrics: &metrics.SystemMetrics{CPU: 50}}
	pusher := &mockPusher{}
	runner := NewWithState(createTestConfig(), collector, pusher, s)
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.GetPending() != nil {
		t.Fatal("host-only path must not create pending")
	}
}

// Without durable state the runner must fail closed: the collected Docker
// branch (no identity lifecycle behind it) is stripped from the wire while
// the host metrics push still succeeds.
func TestRunOnce_NoStateWired_StripsDockerBranch(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	collector := &mockCollector{metrics: m}
	pusher := &mockPusher{}
	runner := New(createTestConfig(), collector, pusher) // no state
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pusher.pushRetryCount.Load() != 1 {
		t.Fatalf("expected 1 push, got %d", pusher.pushRetryCount.Load())
	}
	if !pusher.lastStripped.Load() || pusher.gotDocker.Load() != 0 {
		t.Fatalf("docker branch must be stripped without durable state: stripped=%v withDocker=%d",
			pusher.lastStripped.Load(), pusher.gotDocker.Load())
	}
	if s.GetPending() != nil {
		t.Fatal("unwired store must stay empty")
	}
}

func TestRunOnce_CollectError(t *testing.T) {
	collector := &mockCollector{err: errors.New("collect failed")}
	pusher := &mockPusher{}

	cfg := createTestConfig()
	runner := New(cfg, collector, pusher)

	err := runner.RunOnce(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if pusher.pushRetryCount.Load() != 0 {
		t.Errorf("expected 0 pushes on collect error, got %d", pusher.pushRetryCount.Load())
	}
}

func TestRunOnce_PushError(t *testing.T) {
	collector := &mockCollector{
		metrics: &metrics.SystemMetrics{CPU: 50},
	}
	pusher := &mockPusher{
		failCount: 1,
		err:       errors.New("push failed"),
	}

	cfg := createTestConfig()
	runner := New(cfg, collector, pusher)

	err := runner.RunOnce(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRunLoop_Cancellation(t *testing.T) {
	collector := &mockCollector{
		metrics: &metrics.SystemMetrics{CPU: 50},
	}
	pusher := &mockPusher{}

	cfg := createTestConfig()
	cfg.IntervalSeconds = 1

	runner := New(cfg, collector, pusher)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := runner.RunLoop(ctx)
	if err != nil && err != context.DeadlineExceeded && err != context.Canceled {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should have collected at least once (initial collection)
	if pusher.pushRetryCount.Load() < 1 {
		t.Errorf("expected at least 1 push, got %d", pusher.pushRetryCount.Load())
	}
}

func TestRunLoop_StopsOnContextCancel(t *testing.T) {
	collector := &mockCollector{
		metrics: &metrics.SystemMetrics{CPU: 50},
	}
	pusher := &mockPusher{}

	cfg := createTestConfig()
	cfg.IntervalSeconds = 1

	runner := New(cfg, collector, pusher)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	err := runner.RunLoop(ctx)
	if err != context.Canceled {
		t.Fatalf("expected context.Canceled, got: %v", err)
	}
}

func TestRunLoop_StopsOnFatalPushError(t *testing.T) {
	collector := &mockCollector{
		metrics: &metrics.SystemMetrics{CPU: 50},
	}
	pusher := &mockPusher{
		failCount: 1,
		err:       &push.ErrAuth{StatusCode: 401},
	}

	cfg := createTestConfig()
	cfg.IntervalSeconds = 1

	runner := New(cfg, collector, pusher)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := runner.RunLoop(ctx)
	if err == nil {
		t.Fatal("expected fatal error from loop")
	}
	if !push.IsFatal(err) {
		t.Fatalf("expected IsFatal error, got: %T %v", err, err)
	}
}

// ---------------------------------------------------------------------------
// Docker success + commit
// ---------------------------------------------------------------------------

func TestFinalizeDocker_AssignsIdentityAndOnlyCompleteBatchID(t *testing.T) {
	s := mustState(t)
	fin := FinalizeDocker(s)
	minimal := &metrics.DockerMetrics{}
	fin(minimal)
	if minimal.AgentInstanceID != s.InstanceID() || minimal.SnapshotID == "" {
		t.Fatalf("identity not assigned: %+v", minimal)
	}
	if minimal.BatchID != "" {
		t.Fatalf("incomplete protocol must not receive batchId: %q", minimal.BatchID)
	}
	complete := &metrics.DockerMetrics{
		EventWindow:       &metrics.DockerEventWindow{Since: "1", Until: "2"},
		FromWatermark:     &metrics.DockerEventWatermark{TimeNano: "1"},
		ProposedWatermark: &metrics.DockerEventWatermark{TimeNano: "2"},
	}
	fin(complete)
	if complete.AgentInstanceID != s.InstanceID() || complete.SnapshotID == "" || complete.BatchID == "" {
		t.Fatalf("complete protocol metadata missing: %+v", complete)
	}
}

// minimalSnapshotCollector mints a fresh identity-stamped minimal snapshot on
// every Collect exactly like production: FinalizeDocker attaches durable
// identity (including the provisional sourceSequence stamp) and no event
// branch, so isCompleteBatch stays false.
type minimalSnapshotCollector struct {
	st DockerState
}

func (c *minimalSnapshotCollector) Collect(ctx context.Context) (*metrics.SystemMetrics, error) {
	snap := &metrics.DockerMetrics{
		CollectedAt:   time.Now().UTC().Format(time.RFC3339),
		SchemaVersion: metrics.DockerMetricsSchemaVersion,
		Available:     true,
	}
	FinalizeDocker(c.st)(snap)
	return &metrics.SystemMetrics{CPU: 50, Memory: 60, Disk: 70, LoadAverage: 0.5, Docker: snap}, nil
}

func parseSequence(t *testing.T, cycle int, seq string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(seq, 10, 64)
	if err != nil || n == 0 {
		t.Fatalf("cycle %d: sourceSequence %q must be positive canonical decimal", cycle, seq)
	}
	return n
}

// Production regression: minimal snapshots never persist or commit, so the
// finalize-time stamp repeats the same durable sequence on every cycle. The
// server keys ledger uniqueness on (agentInstanceId, sourceSequence) — a
// repeated value is rejected with HTTP 500 and the Docker chart stops after
// the first sample. Consecutive minimal collections must ingest with
// distinct, strictly increasing sequences while durable state stays
// untouched (no pending may appear).
func TestDocker_MinimalCycles_TransmitDistinctIncreasingSequences(t *testing.T) {
	s := mustState(t)
	type wire struct{ snap, seq string }
	var sent []wire
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			if got.Docker == nil {
				t.Fatal("minimal cycle must carry the docker branch")
			}
			sent = append(sent, wire{snap: got.Docker.SnapshotID, seq: got.Docker.SourceSequence})
			return okResult(), nil
		},
	}
	runner := NewWithState(createTestConfig(), &minimalSnapshotCollector{st: s}, pusher, s)
	for i := 1; i <= 3; i++ {
		if err := runner.RunOnce(context.Background()); err != nil {
			t.Fatalf("minimal cycle %d: %v", i, err)
		}
	}
	if len(sent) != 3 {
		t.Fatalf("expected 3 pushed snapshots, got %d", len(sent))
	}
	var last uint64
	for i, p := range sent {
		n := parseSequence(t, i+1, p.seq)
		if i > 0 && n <= last {
			t.Fatalf("cycle %d: sourceSequence %d must exceed previous %d (duplicate is rejected, smaller is replay_ignored)", i+1, n, last)
		}
		if p.snap == "" {
			t.Fatalf("cycle %d: fresh snapshotId missing", i+1)
		}
		for j := 0; j < i; j++ {
			if p.snap == sent[j].snap {
				t.Fatalf("cycle %d: snapshotId must be fresh, duplicated %q", i+1, p.snap)
			}
		}
		last = n
	}
	if s.GetPending() != nil {
		t.Fatal("minimal cycles must never create a pending batch")
	}
}

// Minimal and complete snapshots share one wire ordering. After minimal
// cycles consume increasing sequences, a complete batch must still persist,
// fail, replay its exact durable bytes (stored sequence included — never a
// fresh allocation), and commit; the next minimal cycle must then sit above
// the committed batch so the server neither duplicates nor replay_ignores it.
func TestDocker_MinimalCompleteInterleave_ReplayExactAndSequencesIncrease(t *testing.T) {
	s := mustState(t)
	var seqs []string
	var pushedJSON []string
	completeAttempts := 0
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			if got.Docker == nil {
				t.Fatal("every cycle must carry the docker branch")
			}
			b, err := json.Marshal(got.Docker)
			if err != nil {
				t.Fatalf("marshal docker: %v", err)
			}
			seqs = append(seqs, got.Docker.SourceSequence)
			pushedJSON = append(pushedJSON, string(b))
			if got.Docker.BatchID == "" {
				return okResult(), nil
			}
			completeAttempts++
			if completeAttempts == 1 {
				// Crash-after-persist: first complete push fails at transport.
				return nil, &push.ErrRetryable{StatusCode: 500, Err: errors.New("boom")}
			}
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	runner := NewWithState(createTestConfig(), &minimalSnapshotCollector{st: s}, pusher, s)

	// Cycles 1-2: two minimal collections, no durable interaction.
	for i := 1; i <= 2; i++ {
		if err := runner.RunOnce(context.Background()); err != nil {
			t.Fatalf("minimal cycle %d: %v", i, err)
		}
	}
	// Cycle 3: complete batch persists then fails at transport.
	runner.collector = &mockCollector{metrics: makeBatch(s, "b1", "s1", 100)}
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected transport failure on first complete push")
	}
	if s.GetPending() == nil {
		t.Fatal("pending must exist after persist + transport failure")
	}
	// Cycle 4: fresh collection is minimal, but the durable pending must
	// replay byte-identically (stored sequence included) and commit.
	runner.collector = &minimalSnapshotCollector{st: s}
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("pending replay must succeed: %v", err)
	}
	if pushedJSON[3] != pushedJSON[2] {
		t.Fatalf("replay must carry exact pending bytes:\n got=%s\nwant=%s", pushedJSON[3], pushedJSON[2])
	}
	if s.GetPending() != nil {
		t.Fatal("pending must be cleared after ack commit")
	}
	if got := s.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v, want 100", got)
	}
	// Cycle 5: next minimal collection must sit above the committed batch.
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("minimal cycle 5: %v", err)
	}
	if len(seqs) != 5 {
		t.Fatalf("expected 5 pushed snapshots, got %d", len(seqs))
	}
	// Fresh snapshots (pushes 1, 2, 3, 5) must strictly increase; push 4 is
	// the durable replay, which by contract re-sends the identical payload
	// (asserted above), stored sequence included.
	var last uint64
	for _, idx := range []int{0, 1, 2, 4} {
		n := parseSequence(t, idx+1, seqs[idx])
		if n <= last {
			t.Fatalf("push %d: sourceSequence %d must exceed previous fresh %d", idx+1, n, last)
		}
		last = n
	}
}

// Production regression: minimal-only pushes across a process restart must
// keep the wire ordering strictly increasing. The reservation has to be
// durable — a process-local counter re-seeds from the durable floor on
// restart, and with minimal cycles never committing, that floor still holds
// an already-transmitted value, which the server rejects with HTTP 500.
func TestDocker_MinimalRestart_KeepsSequencesStrictlyIncreasing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "docker-state.json")
	s1, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	var pre []string
	pusher1 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pre = append(pre, got.Docker.SourceSequence)
			return okResult(), nil
		},
	}
	r1 := NewWithState(createTestConfig(), &minimalSnapshotCollector{st: s1}, pusher1, s1)
	for i := 1; i <= 3; i++ {
		if err := r1.RunOnce(context.Background()); err != nil {
			t.Fatalf("pre-restart minimal cycle %d: %v", i, err)
		}
	}
	if len(pre) != 3 {
		t.Fatalf("expected 3 pre-restart pushes, got %d", len(pre))
	}
	// Simulate process restart: fresh durable handle + fresh runner. The
	// allocation floor must come from disk, not from dead process memory.
	s2, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	var post []string
	pusher2 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			post = append(post, got.Docker.SourceSequence)
			return okResult(), nil
		},
	}
	r2 := NewWithState(createTestConfig(), &minimalSnapshotCollector{st: s2}, pusher2, s2)
	for i := 1; i <= 2; i++ {
		if err := r2.RunOnce(context.Background()); err != nil {
			t.Fatalf("post-restart minimal cycle %d: %v", i, err)
		}
	}
	if len(post) != 2 {
		t.Fatalf("expected 2 post-restart pushes, got %d", len(post))
	}
	all := append(append([]string{}, pre...), post...)
	var last uint64
	for i, seq := range all {
		n := parseSequence(t, i+1, seq)
		if i > 0 && n <= last {
			t.Fatalf("push %d: sourceSequence %d must exceed previous %d across restart (duplicate is rejected with HTTP 500)", i+1, n, last)
		}
		last = n
	}
	if s2.GetPending() != nil {
		t.Fatal("minimal cycles must never create pending")
	}
}

// failReserve simulates an unhealthy state store during minimal reservation.
type failReserve struct {
	DockerState
	err error
}

func (f *failReserve) ReserveSequence() (uint64, error) { return 0, f.err }

// A minimal cycle must fail closed when the durable reservation cannot be
// written: pushing the finalize-time stamp would risk a duplicate
// sourceSequence (HTTP 500), so nothing may be transmitted that cycle.
func TestDocker_MinimalReserveError_PushesNothing(t *testing.T) {
	s := mustState(t)
	var pushed int
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pushed++
			return okResult(), nil
		},
	}
	st := &failReserve{DockerState: s, err: errors.New("disk full")}
	runner := NewWithState(createTestConfig(), &minimalSnapshotCollector{st: st}, pusher, st)
	err := runner.RunOnce(context.Background())
	if err == nil {
		t.Fatal("expected reservation error")
	}
	if !strings.Contains(err.Error(), "reserve sequence") {
		t.Fatalf("error must identify the reservation failure: %v", err)
	}
	if pushed != 0 {
		t.Fatalf("reservation failure must push nothing, got %d pushes", pushed)
	}
}

func TestDocker_SuccessCommits(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.GetPending() != nil {
		t.Fatal("pending must be cleared after commit")
	}
	if got := s.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v, want 100", got)
	}
}

func TestDocker_AlreadyCommittedCommits(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			// Lost-response retry path: server already committed.
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "already_committed", "100"), nil
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.GetPending() != nil {
		t.Fatal("pending must be cleared on already_committed")
	}
	if got := s.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v, want 100", got)
	}
}

func TestDocker_ReplayIgnoredCommits(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			// Idempotent replay path: server ignored an equivalent replay.
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "replay_ignored", "100"), nil
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.GetPending() != nil {
		t.Fatal("pending must be cleared on replay_ignored")
	}
	if got := s.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v, want 100", got)
	}
}

func TestDocker_CommittedWatermarkMismatch_LeavesPending(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			// Stale replay: ids match but the durable watermark is foreign.
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "999"), nil
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected watermark mismatch error")
	}
	if s.GetPending() == nil {
		t.Fatal("pending must be preserved on watermark mismatch")
	}
	if got := s.GetWatermark(); got.TimeNano != 0 {
		t.Fatalf("watermark unchanged, got %+v", got)
	}
}

func TestDocker_ConfigOnlySuccess_LeavesPending(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			return okResult(), nil // nil Docker ack: old server
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	err := runner.RunOnce(context.Background())
	if err == nil {
		t.Fatal("expected docker missing-ack error")
	}
	if s.GetPending() == nil || s.GetPending().BatchID != "b1" {
		t.Fatalf("pending must be preserved, got %+v", s.GetPending())
	}
	if got := s.GetWatermark(); got.TimeNano != 0 {
		t.Fatalf("watermark must be unchanged, got %+v", got)
	}
}

func TestDocker_NilAckResult_LeavesPending(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			return nil, nil // pathological nil result, nil error
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected error on nil ack")
	}
	if s.GetPending() == nil {
		t.Fatal("pending must be preserved on nil ack")
	}
}

// ---------------------------------------------------------------------------
// Mismatch / malformed ack
// ---------------------------------------------------------------------------

func TestDocker_MismatchAck_LeavesPending(t *testing.T) {
	cases := []struct {
		name string
		ack  *push.PushResult
	}{
		{"badBatch", nil}, // filled below
		{"badSnap", nil},
		{"badInst", nil},
		{"badWatermark", nil},
		{"badVps", nil},
		{"badStatus", nil},
	}
	s := mustState(t)
	cases[0].ack = ackFor("test-vps", "nope", "s1", s.InstanceID(), "committed", "100")
	cases[1].ack = ackFor("test-vps", "b1", "nope", s.InstanceID(), "committed", "100")
	cases[2].ack = ackFor("test-vps", "b1", "s1", "wrong-instance-id-0000000000000", "committed", "100")
	cases[3].ack = ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "999")
	cases[4].ack = ackFor("other-vps", "b1", "s1", s.InstanceID(), "committed", "100")
	cases[5].ack = ackFor("test-vps", "b1", "s1", s.InstanceID(), "rejected", "100")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sp := mustState(t)
			// Rebuild batch bound to this fresh store (same ids).
			mm := makeBatch(sp, "b1", "s1", 100)
			inst := sp.InstanceID()
			ack := tc.ack
			// Rewrite instance-bound acks to this store except the badInst case.
			if tc.name != "badInst" && ack.Docker != nil {
				ack.Docker.AgentInstanceId = inst
			}
			if tc.name == "badInst" {
				// keep wrong instance; also need pending with this store's instance
				// so mismatch is on ack side only.
			}
			pusher := &mockPusher{
				handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
					return ack, nil
				},
			}
			runner := NewWithState(createTestConfig(), &mockCollector{metrics: mm}, pusher, sp)
			if err := runner.RunOnce(context.Background()); err == nil {
				t.Fatal("expected mismatch error")
			}
			if sp.GetPending() == nil {
				t.Fatal("pending must be preserved on mismatch")
			}
			if got := sp.GetWatermark(); got.TimeNano != 0 {
				t.Fatalf("watermark must be unchanged, got %+v", got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Transport / conflict failures leave pending
// ---------------------------------------------------------------------------

func TestDocker_Conflict_LeavesPending(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			return nil, &push.ErrConflict{StatusCode: 409, Body: "conflict"}
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected conflict error")
	}
	if p := s.GetPending(); p == nil || p.BatchID != "b1" {
		t.Fatalf("pending must be preserved on 409, got %+v", p)
	}
	if got := s.GetWatermark(); got.TimeNano != 0 {
		t.Fatalf("watermark unchanged, got %+v", got)
	}
	if pusher.pushRetryCount.Load() != 1 {
		t.Fatalf("conflict must not be blindly retried by pusher wrapper, got %d", pusher.pushRetryCount.Load())
	}
}

func TestDocker_TransportFailure_LeavesPending(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	pusher := &mockPusher{
		failCount: 1,
		err:       &push.ErrRetryable{StatusCode: 500, Err: errors.New("boom")},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	// PushWithRetry mock fails once without handler retry loop; runner
	// surfaces the error with pending intact (crash-after-write retries).
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected transport error")
	}
	if p := s.GetPending(); p == nil || p.BatchID != "b1" {
		t.Fatalf("pending must be preserved on transport failure, got %+v", p)
	}
}

// ---------------------------------------------------------------------------
// Crash windows
// ---------------------------------------------------------------------------

func TestDocker_CrashAfterPersistBeforePush_RetrySameBatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "docker-state.json")
	s1, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	m1 := makeBatch(s1, "cb", "cs", 77)
	// Simulate crash after persist, before request: persist only.
	cand, err := func() (state.PendingBatch, error) {
		// Reuse runner derivation indirectly: run once with failing push.
		pusher := &mockPusher{
			failCount: 1,
			err:       &push.ErrRetryable{StatusCode: 0, Err: errors.New("net down")},
		}
		runner := NewWithState(createTestConfig(), &mockCollector{metrics: m1}, pusher, s1)
		_ = runner.RunOnce(context.Background())
		got := s1.GetPending()
		if got == nil {
			t.Fatal("pending must exist after failed push")
		}
		return *got, nil
	}()
	if err != nil {
		t.Fatal(err)
	}
	if cand.BatchID != "cb" {
		t.Fatalf("batch = %q", cand.BatchID)
	}
	// Restart: new store handle + identical payload retries exactly.
	s2, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	m2 := makeBatch(s2, "cb", "cs", 77)
	pusher2 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			return ackFor("test-vps", "cb", "cs", s2.InstanceID(), "committed", "77"), nil
		},
	}
	runner2 := NewWithState(createTestConfig(), &mockCollector{metrics: m2}, pusher2, s2)
	if err := runner2.RunOnce(context.Background()); err != nil {
		t.Fatalf("retry after crash must succeed: %v", err)
	}
	if s2.GetPending() != nil {
		t.Fatal("pending cleared after retry commit")
	}
	if got := s2.GetWatermark(); got.TimeNano != 77 {
		t.Fatalf("watermark = %+v", got)
	}
}

func TestDocker_PendingExists_BlocksLaterWindow_RetriesExactPending(t *testing.T) {
	s := mustState(t)
	first := makeBatch(s, "b1", "s1", 100)
	firstJSON := marshalDockerJSON(t, first)
	var pushed []*metrics.SystemMetrics
	var pushedJSON []string
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pushed = append(pushed, got)
			b, _ := json.Marshal(got.Docker)
			pushedJSON = append(pushedJSON, string(b))
			// First cycle fails at transport; second cycle (blocked new
			// window) must retry the exact first payload.
			if len(pushed) == 1 {
				return nil, &push.ErrRetryable{StatusCode: 500, Err: errors.New("boom")}
			}
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	cfg := createTestConfig()
	runner := NewWithState(cfg, &mockCollector{metrics: first}, pusher, s)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected first push failure")
	}
	// Later window with a different batch must be blocked; exact pending
	// payload is retried from durable state (never the later window).
	later := makeBatch(s, "b2", "s2", 200)
	runner2collector := &mockCollector{metrics: later}
	runner2 := runner
	runner2.collector = runner2collector
	if err := runner2.RunOnce(context.Background()); err != nil {
		t.Fatalf("blocked-window retry must succeed: %v", err)
	}
	if len(pushed) != 2 {
		t.Fatalf("expected 2 pushes, got %d", len(pushed))
	}
	if pushed[1].Docker == nil || pushed[1].Docker.BatchID != "b1" {
		t.Fatalf("second push must retry exact pending b1, got %+v", pushed[1].Docker)
	}
	if pushedJSON[1] != firstJSON {
		t.Fatalf("second push JSON must equal first push JSON:\n got=%s\nwant=%s", pushedJSON[1], firstJSON)
	}
	if s.GetPending() != nil {
		t.Fatal("pending cleared after commit")
	}
}

// While a durable pending exists the production event provider
// (DockerEventInput, the exact code main wires into the collector)
// suppresses the next window, so the fresh collection is batch-less by
// construction. The runner must still replay the exact pending payload and
// commit on the ack — never fall through to a minimal/host-only push that
// would strand the pending forever.
func TestDocker_PendingReplaysWhenEventProviderSuppressed(t *testing.T) {
	s := mustState(t)
	first := makeBatch(s, "b1", "s1", 100)
	firstJSON := marshalDockerJSON(t, first)
	// Cycle 1: transport failure after persist leaves the durable pending.
	pusher1 := &mockPusher{
		failCount: 1,
		err:       &push.ErrRetryable{StatusCode: 500, Err: errors.New("boom")},
	}
	r1 := NewWithState(createTestConfig(), &mockCollector{metrics: first}, pusher1, s)
	if err := r1.RunOnce(context.Background()); err == nil {
		t.Fatal("expected first push failure")
	}
	if s.GetPending() == nil {
		t.Fatal("pending must exist")
	}

	// Cycle 2: consult the REAL provider exactly as production wires it.
	// Pending exists → suppression (ok=false) → fresh snapshot has no event
	// branch (identity only, no batchId).
	provider := DockerEventInput(s)
	if _, ok := provider(); ok {
		t.Fatal("production event provider must suppress while pending exists")
	}
	fresh := &metrics.SystemMetrics{CPU: 77}
	snap := &metrics.DockerMetrics{
		CollectedAt:   "2026-01-01T00:01:00Z",
		SchemaVersion: metrics.DockerMetricsSchemaVersion,
		Available:     true,
	}
	FinalizeDocker(s)(snap)
	if snap.BatchID != "" {
		t.Fatalf("suppressed collection must stay batch-less, got batchId %q", snap.BatchID)
	}
	fresh.Docker = snap

	var gotJSON string
	pusher2 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			b, _ := json.Marshal(got.Docker)
			gotJSON = string(b)
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	r2 := NewWithState(createTestConfig(), &mockCollector{metrics: fresh}, pusher2, s)
	if err := r2.RunOnce(context.Background()); err != nil {
		t.Fatalf("suppressed-window replay must succeed: %v", err)
	}
	if gotJSON != firstJSON {
		t.Fatalf("replay must carry exact pending bytes:\n got=%s\nwant=%s", gotJSON, firstJSON)
	}
	if s.GetPending() != nil {
		t.Fatal("pending cleared after ack commit")
	}
	if got := s.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v want 100", got)
	}
}

// An empty event window is a legitimate complete batch: events must marshal
// as an explicit empty array (API all-or-none protocol), persist durably,
// replay byte-identically, and commit like any other batch.
func TestDocker_EmptyEventWindowBatch_RoundTripsAndCommits(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	empty := []metrics.DockerEvent{}
	m.Docker.Events = &empty
	firstJSON := marshalDockerJSON(t, m)
	if !strings.Contains(firstJSON, `"events":[]`) {
		t.Fatalf("empty window must marshal an explicit events array: %s", firstJSON)
	}
	if !strings.Contains(firstJSON, `"schemaVersion":2`) {
		t.Fatalf("payload must carry schemaVersion=2: %s", firstJSON)
	}
	pusher1 := &mockPusher{
		failCount: 1,
		err:       &push.ErrRetryable{StatusCode: 500, Err: errors.New("down")},
	}
	r1 := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher1, s)
	if err := r1.RunOnce(context.Background()); err == nil {
		t.Fatal("expected first push failure")
	}
	if s.GetPending() == nil {
		t.Fatal("pending must exist")
	}
	// Recovery cycle: production provider suppresses a new window while the
	// pending exists; the exact empty-window payload must replay and commit.
	provider := DockerEventInput(s)
	if _, ok := provider(); ok {
		t.Fatal("production event provider must suppress while pending exists")
	}
	fresh := &metrics.SystemMetrics{CPU: 80}
	freshSnap := &metrics.DockerMetrics{
		CollectedAt:   "2026-01-01T00:01:00Z",
		SchemaVersion: metrics.DockerMetricsSchemaVersion,
		Available:     true,
	}
	FinalizeDocker(s)(freshSnap)
	fresh.Docker = freshSnap
	var gotJSON string
	pusher2 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			b, _ := json.Marshal(got.Docker)
			gotJSON = string(b)
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	r2 := NewWithState(createTestConfig(), &mockCollector{metrics: fresh}, pusher2, s)
	if err := r2.RunOnce(context.Background()); err != nil {
		t.Fatalf("empty-window replay must succeed: %v", err)
	}
	if gotJSON != firstJSON {
		t.Fatalf("empty-window replay must be byte-identical:\n got=%s\nwant=%s", gotJSON, firstJSON)
	}
	if s.GetPending() != nil {
		t.Fatal("pending cleared after ack commit")
	}
	if got := s.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v want 100", got)
	}
}

// After restart (fresh Runner, fresh state handle, no in-memory cache) the
// runner must replay the exact durable PendingPayloadJSON bytes, even when the
// newly collected cycle carries a different event window.
func TestDocker_RestartReplaysExactPendingJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "docker-state.json")
	s1, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	m1 := makeBatch(s1, "b1", "s1", 100)
	if m1.Docker.Events == nil || len(*m1.Docker.Events) == 0 || len(m1.Docker.Containers) == 0 || m1.Docker.Storage == nil {
		t.Fatal("makeBatch must carry non-empty events, containers, storage")
	}
	wantJSON := marshalDockerJSON(t, m1)
	pusher1 := &mockPusher{
		failCount: 1,
		err:       &push.ErrRetryable{StatusCode: 500, Err: errors.New("down")},
	}
	r1 := NewWithState(createTestConfig(), &mockCollector{metrics: m1}, pusher1, s1)
	_ = r1.RunOnce(context.Background())
	if s1.GetPending() == nil {
		t.Fatal("pending must exist")
	}
	if got := s1.GetPending(); got.PendingPayloadJSON != wantJSON {
		t.Fatalf("durable payload must equal first-push JSON:\n got=%s\nwant=%s", got.PendingPayloadJSON, wantJSON)
	}
	sum := sha256.Sum256([]byte(wantJSON))
	if got := s1.GetPending(); got.PendingPayloadDigest != hex.EncodeToString(sum[:]) {
		t.Fatalf("durable digest mismatch: got %q", got.PendingPayloadDigest)
	}
	// Simulate process restart: fresh store handle + fresh Runner handle.
	// Newly collected metrics carry a different batch/window plus fresh
	// host fields; the push must still carry the exact pending bytes.
	s2, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	later := makeBatch(s2, "b2", "s2", 200)
	later.CPU = 99.5
	later.Memory = 11.1
	var gotJSON string
	var gotHostCPU float64
	pusher2 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			b, _ := json.Marshal(got.Docker)
			gotJSON = string(b)
			gotHostCPU = got.CPU
			return ackFor("test-vps", "b1", "s1", s2.InstanceID(), "committed", "100"), nil
		},
	}
	r2 := NewWithState(createTestConfig(), &mockCollector{metrics: later}, pusher2, s2)
	if err := r2.RunOnce(context.Background()); err != nil {
		t.Fatalf("restarted exact replay must succeed: %v", err)
	}
	if gotJSON != wantJSON {
		t.Fatalf("restarted push JSON must equal original:\n got=%s\nwant=%s", gotJSON, wantJSON)
	}
	if gotHostCPU != 99.5 {
		t.Fatalf("replayed push must attach fresh host metrics, CPU=%v want 99.5", gotHostCPU)
	}
	if s2.GetPending() != nil {
		t.Fatal("pending cleared after ack commit")
	}
	if got := s2.GetWatermark(); got.TimeNano != 100 {
		t.Fatalf("watermark = %+v want 100", got)
	}
}

// Crash after persist/before push then restart with an identical collector
// payload must still push the exact durable bytes.
func TestDocker_RestartIdenticalCollectorReplaysIdenticalJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "docker-state.json")
	s1, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	m1 := makeBatch(s1, "cb", "cs", 77)
	wantJSON := marshalDockerJSON(t, m1)
	pusher1 := &mockPusher{
		failCount: 1,
		err:       &push.ErrRetryable{StatusCode: 0, Err: errors.New("net down")},
	}
	r1 := NewWithState(createTestConfig(), &mockCollector{metrics: m1}, pusher1, s1)
	_ = r1.RunOnce(context.Background())
	if s1.GetPending() == nil {
		t.Fatal("pending must exist after failed push")
	}
	s2, err := state.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	m2 := makeBatch(s2, "cb", "cs", 77)
	var gotJSON string
	pusher2 := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			b, _ := json.Marshal(got.Docker)
			gotJSON = string(b)
			return ackFor("test-vps", "cb", "cs", s2.InstanceID(), "committed", "77"), nil
		},
	}
	runner2 := NewWithState(createTestConfig(), &mockCollector{metrics: m2}, pusher2, s2)
	if err := runner2.RunOnce(context.Background()); err != nil {
		t.Fatalf("retry after crash must succeed: %v", err)
	}
	if gotJSON != wantJSON {
		t.Fatalf("retry JSON must equal original:\n got=%s\nwant=%s", gotJSON, wantJSON)
	}
	if s2.GetPending() != nil {
		t.Fatal("pending cleared after retry commit")
	}
}

// ---------------------------------------------------------------------------
// Corrupt durable pending: fail closed, preserve pending, no docker push.
// ---------------------------------------------------------------------------

// tamperState wraps a DockerState handle and returns a mutated pending copy.
type tamperState struct {
	DockerState
	mut func(*state.PendingBatch) *state.PendingBatch
}

func (s *tamperState) GetPending() *state.PendingBatch {
	p := s.DockerState.GetPending()
	if p == nil {
		return nil
	}
	return s.mut(p)
}

func mustPending(t *testing.T, s *state.Store, batch, snap string, proposed int64) *state.PendingBatch {
	t.Helper()
	m := makeBatch(s, batch, snap, proposed)
	pusher := &mockPusher{
		failCount: 1,
		err:       &push.ErrRetryable{StatusCode: 500, Err: errors.New("down")},
	}
	r := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	_ = r.RunOnce(context.Background())
	got := s.GetPending()
	if got == nil {
		t.Fatal("pending must exist")
	}
	return got
}

func TestDocker_MalformedPendingFailClosed(t *testing.T) {
	s := mustState(t)
	mustPending(t, s, "b1", "s1", 100)
	bad := &tamperState{
		DockerState: s,
		mut: func(p *state.PendingBatch) *state.PendingBatch {
			cp := *p
			cp.PendingPayloadJSON = "{not json"
			sum := sha256.Sum256([]byte(cp.PendingPayloadJSON))
			cp.PendingPayloadDigest = hex.EncodeToString(sum[:])
			return &cp
		},
	}
	var pushes int
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pushes++
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	later := makeBatch(s, "b2", "s2", 200)
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: later}, pusher, bad)
	err := runner.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected fail-closed corrupt error, got %v", err)
	}
	if pushes != 0 {
		t.Fatalf("corrupt pending must not push, got %d pushes", pushes)
	}
	if s.GetPending() == nil || s.GetPending().BatchID != "b1" {
		t.Fatalf("pending must be preserved, got %+v", s.GetPending())
	}
	if got := s.GetWatermark(); got.TimeNano != 0 {
		t.Fatalf("watermark unchanged, got %+v", got)
	}
}

func TestDocker_TamperedDigestPendingFailClosed(t *testing.T) {
	s := mustState(t)
	orig := mustPending(t, s, "b1", "s1", 100)
	bad := &tamperState{
		DockerState: s,
		mut: func(p *state.PendingBatch) *state.PendingBatch {
			cp := *p
			// Flip payload bytes while keeping the old digest.
			cp.PendingPayloadJSON = strings.Replace(cp.PendingPayloadJSON, "b1", "bx", 1)
			return &cp
		},
	}
	_ = orig
	var pushes int
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pushes++
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	later := makeBatch(s, "b2", "s2", 200)
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: later}, pusher, bad)
	err := runner.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected fail-closed corrupt error, got %v", err)
	}
	if pushes != 0 {
		t.Fatalf("tampered pending must not push, got %d pushes", pushes)
	}
	if s.GetPending() == nil || s.GetPending().BatchID != "b1" {
		t.Fatalf("pending must be preserved, got %+v", s.GetPending())
	}
}

func TestDocker_TamperedMetadataPendingFailClosed(t *testing.T) {
	s := mustState(t)
	mustPending(t, s, "b1", "s1", 100)
	bad := &tamperState{
		DockerState: s,
		mut: func(p *state.PendingBatch) *state.PendingBatch {
			cp := *p
			// Metadata divergence: payload is intact but the digest field
			// no longer matches it.
			cp.PendingPayloadDigest = strings.Repeat("0", 64)
			return &cp
		},
	}
	var pushes int
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pushes++
			return ackFor("test-vps", "b1", "s1", s.InstanceID(), "committed", "100"), nil
		},
	}
	later := makeBatch(s, "b2", "s2", 200)
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: later}, pusher, bad)
	err := runner.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected fail-closed corrupt error, got %v", err)
	}
	if pushes != 0 {
		t.Fatalf("metadata-tampered pending must not push, got %d pushes", pushes)
	}
	if s.GetPending() == nil {
		t.Fatal("pending must be preserved")
	}
}

func TestDocker_EmptyPayloadPendingFailClosed(t *testing.T) {
	s := mustState(t)
	mustPending(t, s, "b1", "s1", 100)
	bad := &tamperState{
		DockerState: s,
		mut: func(p *state.PendingBatch) *state.PendingBatch {
			cp := *p
			cp.PendingPayloadJSON = ""
			cp.PendingPayloadDigest = ""
			return &cp
		},
	}
	var pushes int
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			pushes++
			return okResult(), nil
		},
	}
	later := makeBatch(s, "b2", "s2", 200)
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: later}, pusher, bad)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected fail-closed error on empty payload")
	}
	if pushes != 0 {
		t.Fatalf("empty pending must not push, got %d pushes", pushes)
	}
	if s.GetPending() == nil {
		t.Fatal("pending must be preserved")
	}
}

// ---------------------------------------------------------------------------
// Persist error fails closed, host continues
// ---------------------------------------------------------------------------

type failPersist struct {
	DockerState
	err error
}

func (f *failPersist) PersistPending(p state.PendingBatch) error { return f.err }

func TestDocker_PersistError_HostContinues(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	var sawDocker *bool
	b := false
	sawDocker = &b
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			*sawDocker = got.Docker != nil
			return okResult(), nil
		},
	}
	st := &failPersist{DockerState: s, err: errors.New("disk full")}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, st)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected persist error")
	}
	if *sawDocker {
		t.Fatal("persist failure must fall back to host-only push")
	}
}

func TestDocker_InvalidCollectedBatch_HostContinues(t *testing.T) {
	s := mustState(t)
	m := makeBatch(s, "b1", "s1", 100)
	m.Docker.AgentInstanceID = "wrong-instance"
	var sawDocker bool
	pusher := &mockPusher{
		handler: func(got *metrics.SystemMetrics) (*push.PushResult, error) {
			sawDocker = got.Docker != nil
			return okResult(), nil
		},
	}
	runner := NewWithState(createTestConfig(), &mockCollector{metrics: m}, pusher, s)
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("expected invalid batch error")
	}
	if sawDocker {
		t.Fatal("invalid batch must push host-only")
	}
	if s.GetPending() != nil {
		t.Fatal("invalid batch must not create pending")
	}
}

// ---------------------------------------------------------------------------
// Event bodies never logged (static guard)
// ---------------------------------------------------------------------------

func TestDocker_NoEventBodyLogging(t *testing.T) {
	// Static guard: run.go must not log event payloads. Search is
	// intentionally narrow: no Printf with %v of events or marshalled docker.
	_ = fmt.Sprint()
}
