package updater

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- shared fault-injection harness ----------

// eventLog is the cross-component timeline: the fake API and the fake
// systemctl append here so tests can assert ordering across components
// (e.g. the restarting progress POST precedes the actual restart).
type eventLog struct {
	mu    sync.Mutex
	items []string
}

func (e *eventLog) add(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.items = append(e.items, s)
}

func (e *eventLog) index(s string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, v := range e.items {
		if v == s {
			return i
		}
	}
	return -1
}

func (e *eventLog) contains(prefix string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, v := range e.items {
		if strings.HasPrefix(v, prefix) {
			return true
		}
	}
	return false
}

// releaseFixture is a self-contained signed release: the daemon/helper
// contract under test must accept ANY properly signed manifest, so tests
// generate their own keypair instead of depending on release fixtures.
type releaseFixture struct {
	pubKeyB64   string
	manifestRaw []byte
	releaseID   string
	buildID     string
	sha         string
	content     []byte
	artifactURL string
}

// newRelease signs a manifest over an artifact of the given content with the
// given URL (must pass the host allowlist of the test config).
func newRelease(t *testing.T, content []byte, artifactURL string) *releaseFixture {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	seed := SHA256Hex(content)
	rel := &releaseFixture{
		pubKeyB64:   base64.StdEncoding.EncodeToString(pub),
		releaseID:   seed[:40],
		buildID:     SHA256Hex([]byte(seed + "b"))[:40],
		sha:         SHA256Hex(content),
		content:     content,
		artifactURL: artifactURL,
	}
	doc := map[string]any{
		"releaseId":        rel.releaseID,
		"version":          "9.9.9",
		"buildId":          rel.buildID,
		"channel":          "stable",
		"publishedAt":      "2026-09-27T00:00:00Z",
		"apiCompatibility": map[string]any{"min": 1, "max": 2},
		"artifacts": []any{map[string]any{
			"os": "linux", "arch": "amd64",
			"size": len(content), "sha256": rel.sha, "url": artifactURL,
		}},
	}
	unsigned, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	canon, err := CanonicalJSON(unsigned)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	doc["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, canon))
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal signed manifest: %v", err)
	}
	rel.manifestRaw = raw
	// Sanity: the harness manifest must verify — a test bug must not look
	// like a production failure later.
	if _, err := VerifyManifest(raw, rel.pubKeyB64); err != nil {
		t.Fatalf("harness manifest does not verify: %v", err)
	}
	return rel
}

// tamper flips the first hex digit of the signed artifact sha WITHOUT
// re-signing — the exact attacker model the signature check must stop.
func (r *releaseFixture) tamper(t *testing.T) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(r.manifestRaw, &doc); err != nil {
		t.Fatalf("unmarshal for tamper: %v", err)
	}
	arts := doc["artifacts"].([]any)
	a := arts[0].(map[string]any)
	sha := a["sha256"].(string)
	flipped := "0" + sha[1:]
	if flipped == sha {
		flipped = "1" + sha[1:]
	}
	a["sha256"] = flipped
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal tampered: %v", err)
	}
	return raw
}

func testConfig(t *testing.T, rel *releaseFixture) *Config {
	t.Helper()
	stateDir := t.TempDir()
	binDir := t.TempDir()
	cfg := &Config{
		APIBase:                "https://api.test.invalid",
		Credential:             "vma_test_credential",
		PinnedPublicKey:        rel.pubKeyB64,
		AllowedHosts:           []string{"localhost", "example.com"},
		AgentBinary:            filepath.Join(binDir, "vps-manager-agent"),
		AgentUnit:              "vps-manager-agent.service",
		StateDir:               stateDir,
		HTTPTimeoutSec:         2,
		ClaimIntervalSec:       1,
		HeartbeatIntervalSec:   1,
		AwaitHeartbeatGraceSec: 360,
		HelperTimeoutSec:       30,
	}
	// In-process fault harness only: redirect the fixed production targets
	// and allowlist at temp dirs.
	cfg.EnableTestOverrides()
	if err := cfg.NormalizeAndValidate(); err != nil {
		t.Fatalf("test config: %v", err)
	}
	// Fast polling for the harness; the production cadence (60s/15s) is a
	// config concern, not a state-machine concern.
	cfg.HeartbeatInterval = 50 * time.Millisecond
	cfg.ClaimInterval = 200 * time.Millisecond
	cfg.HelperTimeout = 30 * time.Second
	return cfg
}

// fakeSystemctl replaces the systemctl seam: scripted restart failures,
// instantaneous is-active answers, everything on a shared timeline.
type fakeSystemctl struct {
	mu          sync.Mutex
	restartErrs []error
	restarts    int
	inactive    bool // when true, is-active reports "inactive"
	events      *eventLog
}

func (f *fakeSystemctl) call(_ context.Context, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(args) > 0 && args[0] == "restart" {
		f.events.add("systemctl:restart")
		f.restarts++
		if len(f.restartErrs) > 0 {
			err := f.restartErrs[0]
			f.restartErrs = f.restartErrs[1:]
			return "Job for vps-manager-agent.service failed", err
		}
		return "", nil
	}
	if len(args) > 0 && args[0] == "is-active" {
		if f.inactive {
			return "inactive", nil
		}
		return "active", nil
	}
	return "", nil
}

func (f *fakeSystemctl) restartCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.restarts
}

// installSeams swaps the process/systemd seams for the duration of the test.
func installSeams(t *testing.T, events *eventLog, buildID string) *fakeSystemctl {
	t.Helper()
	oldExec, oldSys := execStagedVersion, runSystemctl
	oldWait, oldPoll := serviceActiveWait, servicePollEvery
	fs := &fakeSystemctl{events: events}
	execStagedVersion = func(_ context.Context, _ string) (string, error) {
		return "9.9.9+" + buildID, nil
	}
	runSystemctl = fs.call
	serviceActiveWait = 200 * time.Millisecond
	servicePollEvery = 20 * time.Millisecond
	t.Cleanup(func() {
		execStagedVersion, runSystemctl = oldExec, oldSys
		serviceActiveWait, servicePollEvery = oldWait, oldPoll
	})
	return fs
}

// fakeAPI implements the API interface: an in-memory server view with the
// same terminal/lease semantics the real contract has.
type fakeAPI struct {
	mu            sync.Mutex
	job           *ClaimedJob
	claimErr      error
	claims        int // successful claim deliveries
	calls         int // total Claim invocations (incl. failures)
	phases        []string
	results       []string // "outcome|reportedBuildId"
	flipAfterGets int      // >0: after N Gets while awaiting, rule success
	events        *eventLog
}

func newFakeAPI(job *ClaimedJob, events *eventLog) *fakeAPI {
	return &fakeAPI{job: job, events: events}
}

func (f *fakeAPI) Claim(_ context.Context) (*ClaimedJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if f.job == nil || f.claims > 0 {
		return nil, nil
	}
	f.claims++
	return f.job, nil
}

func (f *fakeAPI) Progress(_ context.Context, _ string, token int64, phase string, _ *int, _ string) (*ClaimedJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.phases = append(f.phases, phase)
	f.events.add("progress:" + phase)
	if f.job != nil {
		f.job.Phase = phase
		f.job.FencingToken = token
	}
	return f.job, nil
}

func (f *fakeAPI) Result(_ context.Context, _ string, _ int64, outcome, buildID, _ string) (*ClaimedJob, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, outcome+"|"+buildID)
	f.events.add("result:" + outcome)
	if f.job != nil {
		f.job.Phase = outcome // terminal ruling, same as the real server
	}
	return f.job, false, nil
}

func (f *fakeAPI) Get(_ context.Context, _ string) (*ClaimedJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.flipAfterGets > 0 && f.job != nil && f.job.Phase == PhaseAwaitingHB {
		f.flipAfterGets--
		if f.flipAfterGets == 0 {
			f.job.Phase = "succeeded"
		}
	}
	return f.job, nil
}

func (f *fakeAPI) phaseList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.phases...)
}

func (f *fakeAPI) resultList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.results...)
}

func (f *fakeAPI) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// serverPhase exposes the fake server's current job phase for assertions.
func (f *fakeAPI) serverPhase() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.job == nil {
		return ""
	}
	return f.job.EffectivePhase()
}

// seedStaging writes the signed manifest + artifact the daemon stages for
// the helper.
func seedStaging(t *testing.T, cfg *Config, rel *releaseFixture) {
	t.Helper()
	dir := stagingDir(cfg.StateDir, faultJobID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), rel.manifestRaw, 0o644); err != nil {
		t.Fatalf("write staging manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "artifact.bin"), rel.content, 0o755); err != nil {
		t.Fatalf("write staging artifact: %v", err)
	}
}

func writeFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func shaOf(t *testing.T, path string) string {
	t.Helper()
	sha, err := sha256File(path)
	if err != nil {
		t.Fatalf("hash %s: %v", path, err)
	}
	return sha
}

func readResultT(t *testing.T, cfg *Config, action, jobID string) *HelperResult {
	t.Helper()
	res, err := ReadResult(cfg.StateDir, action, jobID)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	if res == nil {
		t.Fatalf("expected %s result for %s, none written", action, jobID)
	}
	return res
}

func writePending(t *testing.T, cfg *Config, action, jobID string) {
	t.Helper()
	if err := os.MkdirAll(pendingDir(cfg.StateDir), 0o770); err != nil {
		t.Fatalf("mkdir pending: %v", err)
	}
	if err := atomicWriteFile(pendingPath(cfg.StateDir, action, jobID), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("write pending: %v", err)
	}
}

const faultJobID = "lug_faulttestjob1"

// startHelperLoop simulates the systemd path unit: a goroutine that keeps
// draining pending actions while the daemon runs. It stops automatically at
// test end, so a t.Fatalf mid-test cannot leak it.
func startHelperLoop(t *testing.T, cfg *Config, events *eventLog) {
	t.Helper()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			pending, err := os.ReadDir(pendingDir(cfg.StateDir))
			if err == nil && len(pending) > 0 {
				events.add("helper:run")
				if err := RunHelper(context.Background(), cfg); err != nil {
					events.add("helper:error:" + err.Error())
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	t.Cleanup(func() {
		close(stop)
		wg.Wait()
	})
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return raw
}

// ---------- signature verification ----------

// TestHelperRejectsTamperedManifestNoSwap: a one-byte tamper of the signed
// manifest must abort the privileged apply before ANY mutation: binary
// untouched, no backup, no helper journal, verify_failed reported.
func TestHelperRejectsTamperedManifestNoSwap(t *testing.T) {
	rel := newRelease(t, []byte("new-agent-binary-content"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("old-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	// Stage a tampered manifest with a matching (but now-unsigned) artifact.
	seedStaging(t, cfg, rel)
	tampered := rel.tamper(t)
	if err := os.WriteFile(filepath.Join(stagingDir(cfg.StateDir, faultJobID), "manifest.json"), tampered, 0o644); err != nil {
		t.Fatalf("overwrite tampered manifest: %v", err)
	}
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "verify_failed" {
		t.Fatalf("outcome = %q, want verify_failed (detail: %s)", res.Outcome, res.Detail)
	}
	if !strings.Contains(res.Detail, "signature") {
		t.Fatalf("detail %q does not mention signature verification", res.Detail)
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha || string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("binary mutated by rejected apply: sha %s", got)
	}
	if hj, err := LoadHelperJournal(cfg.StateDir); err != nil || hj != nil {
		t.Fatalf("helper journal must be absent, got %v / %v", hj, err)
	}
	if _, err := os.Stat(backupDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup dir must not exist after rejected apply: %v", err)
	}
	if events.contains("systemctl:restart") {
		t.Fatalf("service must not be restarted for a rejected manifest: %v", events.items)
	}
	// verify_failed keeps the pending file: the daemon still sees the request
	// until it fails the job pre-swap.
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); err != nil {
		t.Fatalf("pending apply must be retained on verify_failed: %v", err)
	}
}

// TestDaemonFailsPreSwapOnTamperedManifest: the same failure at daemon level
// reports outcome=failed to the API, never writes an apply request, and
// clears its journal only after the server's terminal ruling.
func TestDaemonFailsPreSwapOnTamperedManifest(t *testing.T) {
	rel := newRelease(t, []byte("daemon-tampered-content"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("old-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	job := &ClaimedJob{JobID: faultJobID, Phase: "queued", FencingToken: 1,
		ManifestRaw: string(rel.tamper(t))}
	job.Release.ReleaseID, job.Release.BuildID = rel.releaseID, rel.buildID
	job.Release.Version, job.Release.TargetSha256 = "9.9.9", rel.sha
	api := newFakeAPI(job, events)

	startHelperLoop(t, cfg, events)

	d := NewDaemon(cfg, api)
	d.stepClaim(context.Background())
	j, err := d.journal.Load()
	if err != nil || j == nil {
		t.Fatalf("journal after claim: %v / %v", j, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	if got := api.resultList(); len(got) != 1 || !strings.HasPrefix(got[0], "failed|") {
		t.Fatalf("results = %v, want exactly failed", got)
	}
	if strings.Contains(strings.Join(api.phaseList(), ","), "restarting") {
		t.Fatalf("phases = %v, must never reach restarting", api.phaseList())
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary mutated: %s", got)
	}
	if hj, _ := LoadHelperJournal(cfg.StateDir); hj != nil {
		t.Fatalf("helper journal must be absent")
	}
	if j, err := d.journal.Load(); err != nil || j != nil {
		t.Fatalf("journal must be consumed after terminal ruling, got %v / %v", j, err)
	}
}

// ---------- crash after swap ----------

// TestCrashAfterSwapReconcilesNoDoubleSwap: helper journal says "intent" but
// the binary already hashes to the new build — the crash landed between
// rename and journal update. The re-triggered helper must adopt the swap and
// finish the restart, never re-run the backup/swap (which would back up the
// NEW binary and destroy the rollback path).
func TestCrashAfterSwapReconcilesNoDoubleSwap(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-after-swap"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("OLD-agent-binary")
	newSha := rel.sha
	oldSha := SHA256Hex(oldContent)

	// On-disk crash state: swap happened, journal update was lost.
	writeFile(t, cfg.AgentBinary, rel.content, 0o755) // post-rename
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755) // backup of the OLD binary
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjIntent,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	seedStaging(t, cfg, rel)
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "recovered_restarted" {
		t.Fatalf("outcome = %q, want recovered_restarted (detail: %s)", res.Outcome, res.Detail)
	}
	// No double swap: binary still the new build, backup still the OLD bytes
	// (a fresh apply would have tried to re-create the backup and failed or
	// worse, overwritten the rollback source).
	if got := shaOf(t, cfg.AgentBinary); got != newSha {
		t.Fatalf("binary sha %s != new %s (double swap?)", got, newSha)
	}
	if got := shaOf(t, backupPath); got != oldSha {
		t.Fatalf("backup sha %s != old %s (rollback source destroyed)", got, oldSha)
	}
	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil || hj == nil || hj.Phase != hjRestarted {
		t.Fatalf("helper journal = %+v / %v, want phase restarted", hj, err)
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want exactly 1", fs.restartCount())
	}
	// Pending consumed: a consumable outcome must not leave the request around.
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending apply must be consumed: %v", err)
	}
}

// TestCrashBeforeRenameReconcilesNoSwap: crash landed before the rename —
// reconciliation must report that no swap happened (daemon then fails the
// job pre-swap) and must not touch the binary.
func TestCrashBeforeRenameReconcilesNoSwap(t *testing.T) {
	rel := newRelease(t, []byte("NEW-never-swapped"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("OLD-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjIntent,
		OldSha256: oldSha, NewSha256: rel.sha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	seedStaging(t, cfg, rel)
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "recovered_no_swap" {
		t.Fatalf("outcome = %q, want recovered_no_swap (detail: %s)", res.Outcome, res.Detail)
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary mutated: %s", got)
	}
}

// ---------- disk full ----------

// TestJournalENOSPCAbortsPreSwap: an ENOSPC on the durability-critical
// journal write must abort the job step before any helper request exists.
func TestJournalENOSPCAbortsPreSwap(t *testing.T) {
	rel := newRelease(t, []byte("enospc-artifact"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("old-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	d := NewDaemon(cfg, newFakeAPI(nil, events))
	// Journal exists at downloading with a valid manifest; the next Save
	// (the phase transition) hits a full disk.
	j := &Journal{
		JobID: faultJobID, FencingToken: 1,
		ReleaseID: rel.releaseID, BuildID: rel.buildID, Version: "9.9.9",
		TargetSha256: rel.sha, ManifestRaw: string(rel.manifestRaw),
		Phase: PhaseDownloading, CreatedAt: time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		t.Fatalf("seed journal: %v", err)
	}
	d.journal.faultWrite = func() error {
		return errors.New("no space left on device")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := d.runJob(ctx, j)
	if err == nil || !strings.Contains(err.Error(), "injected fault") {
		t.Fatalf("runJob err = %v, want injected fault", err)
	}

	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary mutated under ENOSPC: %s", got)
	}
	if entries, err := os.ReadDir(pendingDir(cfg.StateDir)); err == nil && len(entries) > 0 {
		t.Fatalf("helper request must not exist, found %v", entries)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read pending dir: %v", err)
	}
	// On-disk journal unchanged: still downloading.
	got, err := NewJournalStore(cfg.StateDir).Load()
	if err != nil || got == nil || got.Phase != PhaseDownloading {
		t.Fatalf("journal on disk = %+v / %v, want phase downloading", got, err)
	}
}

// ---------- offline ----------

// TestOfflineClaimRetriesNeverMutates: with the API unreachable the daemon
// must keep retrying claims without creating any local state or touching the
// healthy agent.
func TestOfflineClaimRetriesNeverMutates(t *testing.T) {
	rel := newRelease(t, []byte("offline-artifact"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("healthy-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	api := &fakeAPI{claimErr: errors.New("dial tcp: connection refused"), events: events}
	d := NewDaemon(cfg, api)

	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	if err := d.Run(ctx); err != nil {
		t.Fatalf("Run must not fail offline, got %v", err)
	}

	if api.callCount() < 2 {
		t.Fatalf("expected retried claims while offline, got %d", api.callCount())
	}
	if j, _ := d.journal.Load(); j != nil {
		t.Fatalf("no journal may be created offline: %+v", j)
	}
	if fs.restartCount() != 0 {
		t.Fatalf("restarts = %d, want 0", fs.restartCount())
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("healthy agent mutated offline: %s", got)
	}
	if events.contains("progress:") {
		t.Fatalf("no progress may be posted offline: %v", events.items)
	}
}

// TestOfflineDownloadRetriesPreSwap: an unreachable artifact host during the
// downloading phase is a retry state — no phase advance, no helper request,
// no rollback of the healthy agent.
func TestOfflineDownloadRetriesPreSwap(t *testing.T) {
	rel := newRelease(t, []byte("unreachable-download"), "https://localhost:443/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("healthy-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	api := newFakeAPI(nil, events)
	d := NewDaemon(cfg, api)
	j := &Journal{
		JobID: faultJobID, FencingToken: 1,
		ReleaseID: rel.releaseID, BuildID: rel.buildID, Version: "9.9.9",
		TargetSha256: rel.sha, ManifestRaw: string(rel.manifestRaw),
		Phase: PhaseDownloading, CreatedAt: time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		t.Fatalf("seed journal: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err := d.runJob(ctx, j)
	if err == nil || !strings.Contains(err.Error(), "download") {
		t.Fatalf("runJob err = %v, want download error", err)
	}

	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("healthy agent mutated after failed download: %s", got)
	}
	if fs.restartCount() != 0 {
		t.Fatalf("restarts = %d, want 0", fs.restartCount())
	}
	if entries, e := os.ReadDir(pendingDir(cfg.StateDir)); e == nil && len(entries) > 0 {
		t.Fatalf("no helper request may exist: %v", entries)
	}
	if got, e := NewJournalStore(cfg.StateDir).Load(); e != nil || got.Phase != PhaseDownloading {
		t.Fatalf("journal = %+v / %v, want staying at downloading", got, e)
	}
}

// ---------- rollback verification ----------

// TestFailedRestartAutoRollsBack: restart fails after the swap → the helper
// must restore the backup byte-identically, restart the old binary and
// report auto_rolled_back with the OLD hash.
func TestFailedRestartAutoRollsBack(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-v2"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)
	fs.restartErrs = []error{errors.New("unit failed to start")}

	oldContent := []byte("OLD-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	seedStaging(t, cfg, rel)
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "auto_rolled_back" {
		t.Fatalf("outcome = %q, want auto_rolled_back (detail: %s)", res.Outcome, res.Detail)
	}
	if res.BinarySha256 != oldSha {
		t.Fatalf("binarySha256 = %s, want old %s", res.BinarySha256, oldSha)
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary after auto-rollback = %s, want byte-identical old %s", got, oldSha)
	}
	if string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("restored binary content differs from original")
	}
	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil || hj == nil || hj.Phase != hjRolledBack {
		t.Fatalf("helper journal = %+v / %v, want rolled_back", hj, err)
	}
	// Backup retained until the server's terminal ruling (cleanup is a
	// separate action the daemon only triggers after seeing the ruling).
	if _, err := os.Stat(hj.BackupPath); err != nil {
		t.Fatalf("backup must be retained after auto-rollback: %v", err)
	}
	if fs.restartCount() != 2 {
		t.Fatalf("restarts = %d, want 2 (failed + rollback)", fs.restartCount())
	}
}

// TestRollbackRefusesTamperedBackup: a backup that no longer hashes to the
// recorded old value must never be restored — rollback_failed, binary left
// exactly as it was, pending request retained for the operator.
func TestRollbackRefusesTamperedBackup(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-tamper-backup"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	writeFile(t, cfg.AgentBinary, rel.content, 0o755)
	newSha := shaOf(t, cfg.AgentBinary)
	oldSha := SHA256Hex([]byte("OLD-agent-binary"))

	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, []byte("TAMPERED-backup-bytes"), 0o755) // sha != oldSha
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	writePending(t, cfg, actionRollback, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionRollback, faultJobID)
	if res.Outcome != "rollback_failed" {
		t.Fatalf("outcome = %q, want rollback_failed (detail: %s)", res.Outcome, res.Detail)
	}
	if !strings.Contains(res.Detail, "backup sha") {
		t.Fatalf("detail %q must explain the backup hash mismatch", res.Detail)
	}
	if got := shaOf(t, cfg.AgentBinary); got != newSha {
		t.Fatalf("binary must be untouched when restore refuses: %s", got)
	}
	// Unclear/failed outcomes keep the pending file so the daemon still sees
	// the request until it halts the job.
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionRollback, faultJobID)); err != nil {
		t.Fatalf("pending rollback must be retained: %v", err)
	}
}

// TestRollbackRestoresOldBinary: the explicit rollback action restores the
// backup byte-identically, restarts and reports rolled_back.
func TestRollbackRestoresOldBinary(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-rollback-path"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("OLD-agent-binary")
	writeFile(t, cfg.AgentBinary, rel.content, 0o755)
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: SHA256Hex(oldContent), NewSha256: rel.sha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	writePending(t, cfg, actionRollback, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionRollback, faultJobID)
	if res.Outcome != "rolled_back" {
		t.Fatalf("outcome = %q, want rolled_back (detail: %s)", res.Outcome, res.Detail)
	}
	if string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("binary not restored byte-identically")
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want 1", fs.restartCount())
	}
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionRollback, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending rollback must be consumed: %v", err)
	}
}

// ---------- daemon end-to-end ----------

// TestDaemonEndToEndUpgrade runs the full state machine against the fake API
// and helper loop: claim → download (pre-seeded) → verify → stage →
// progress(restarting) BEFORE the privileged restart → await heartbeat →
// observe terminal succeeded → cleanup → journal consumed.
func TestDaemonEndToEndUpgrade(t *testing.T) {
	rel := newRelease(t, []byte("E2E-new-agent-binary"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	writeFile(t, cfg.AgentBinary, []byte("E2E-old-agent-binary"), 0o755)

	job := &ClaimedJob{JobID: faultJobID, Phase: "queued", FencingToken: 1,
		ManifestRaw: string(rel.manifestRaw)}
	job.Release.ReleaseID, job.Release.BuildID = rel.releaseID, rel.buildID
	job.Release.Version, job.Release.TargetSha256 = "9.9.9", rel.sha
	api := newFakeAPI(job, events)
	api.flipAfterGets = 2 // server observes the target heartbeat, then rules

	// Pre-seed the staged artifact: the download path is exercised by its own
	// tests; here the URL is unreachable by design.
	seedStaging(t, cfg, rel)

	startHelperLoop(t, cfg, events)

	d := NewDaemon(cfg, api)
	d.stepClaim(context.Background())
	j, err := d.journal.Load()
	if err != nil || j == nil {
		t.Fatalf("journal after claim: %v / %v", j, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	// Server view: the happy path is server-ruled — the updater posts no
	// result on success, only phases; the server rules succeeded after
	// observing the target heartbeat and the daemon consumes from GET.
	if got := api.resultList(); len(got) != 0 {
		t.Fatalf("results = %v, want none: success is server-ruled", got)
	}
	if got := api.serverPhase(); got != "succeeded" {
		t.Fatalf("server phase = %q, want succeeded", got)
	}
	phases := api.phaseList()
	wantOrder := []string{PhaseDownloading, PhaseVerifying, PhaseStaging, PhaseRestarting, PhaseAwaitingHB}
	var seq int
	for _, want := range wantOrder {
		found := -1
		for i := seq; i < len(phases); i++ {
			if phases[i] == want {
				found = i
				break
			}
		}
		if found == -1 {
			t.Fatalf("phases = %v, missing %q in order", phases, want)
		}
		seq = found + 1
	}
	// Contract: the restarting progress POST must precede the actual restart
	// so the server's heartbeat baseline is older than the first
	// post-restart heartbeat.
	ri, si := events.index("progress:restarting"), events.index("systemctl:restart")
	if ri < 0 || si < 0 || ri > si {
		t.Fatalf("progress:restarting (%d) must precede systemctl:restart (%d): %v", ri, si, events.items)
	}
	// Awaiting must be reported after the restart as well.
	ai := events.index("progress:awaiting_heartbeat")
	if ai < si {
		t.Fatalf("awaiting_heartbeat (%d) reported before restart (%d)", ai, si)
	}

	// Local view: swapped, consumed, cleaned.
	if got := shaOf(t, cfg.AgentBinary); got != rel.sha {
		t.Fatalf("binary sha %s, want new %s", got, rel.sha)
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want 1", fs.restartCount())
	}
	if j, err := d.journal.Load(); err != nil || j != nil {
		t.Fatalf("journal must be consumed, got %v / %v", j, err)
	}
	if _, err := os.Stat(backupDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup must be cleaned after succeeded ruling: %v", err)
	}
	if _, err := os.Stat(stagingDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging must be cleaned: %v", err)
	}
}

// TestDaemonRollbackOnHeartbeatTimeout: post-swap awaiting with a baseline
// older than the grace deadline (server reachable, non-terminal) must trigger
// the rollback request, restore the old binary and report rolled_back.
func TestDaemonRollbackOnHeartbeatTimeout(t *testing.T) {
	rel := newRelease(t, []byte("grace-timeout-new-binary"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("grace-old-binary")
	newSha := rel.sha
	oldSha := SHA256Hex(oldContent)
	writeFile(t, cfg.AgentBinary, rel.content, 0o755) // post-swap state

	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}

	job := &ClaimedJob{JobID: faultJobID, Phase: PhaseAwaitingHB, FencingToken: 7,
		ManifestRaw: string(rel.manifestRaw)}
	job.Release.ReleaseID, job.Release.BuildID = rel.releaseID, rel.buildID
	api := newFakeAPI(job, events) // never flips: heartbeat never arrives

	d := NewDaemon(cfg, api)
	j := &Journal{
		JobID: faultJobID, FencingToken: 7, PostSwap: true, SwapRequested: true,
		ReleaseID: rel.releaseID, BuildID: rel.buildID, Version: "9.9.9",
		TargetSha256: newSha, ManifestRaw: string(rel.manifestRaw),
		Phase:    PhaseAwaitingHB,
		OldSha256: oldSha, NewSha256: newSha,
		// Baseline far in the past: grace already expired on entry.
		BaselineHBAt: time.Now().Add(-30 * time.Minute).UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		t.Fatalf("seed journal: %v", err)
	}

	startHelperLoop(t, cfg, events)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	if !events.contains("progress:rolling_back") {
		t.Fatalf("rolling_back progress missing: %v", events.items)
	}
	if got := api.resultList(); len(got) != 1 || !strings.HasPrefix(got[0], "rolled_back|") {
		t.Fatalf("results = %v, want rolled_back", got)
	}
	if string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("binary not restored after grace-triggered rollback")
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want exactly the rollback restart", fs.restartCount())
	}
	if j, err := d.journal.Load(); err != nil || j != nil {
		t.Fatalf("journal must be consumed after ruled rollback, got %v / %v", j, err)
	}
	if _, err := os.Stat(backupDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup must be cleaned after rolled_back ruling: %v", err)
	}
}
