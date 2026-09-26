package state

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func testPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "docker-state.json")
}

func mustStore(t *testing.T, path string) *Store {
	t.Helper()
	s, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	return s
}

func pendingPayloadFor(batch, snap string) (string, string) {
	payload := `{"batchId":` + strconv.Quote(batch) + `,"snapshotId":` + strconv.Quote(snap) + `}`
	sum := sha256.Sum256([]byte(payload))
	return payload, hex.EncodeToString(sum[:])
}

func makePending(s *Store, batch, snap string, proposed Watermark) PendingBatch {
	payload, digest := pendingPayloadFor(batch, snap)
	return PendingBatch{
		BatchID:              batch,
		SnapshotID:           snap,
		AgentInstanceID:      s.InstanceID(),
		FromWatermark:        s.GetWatermark(),
		ProposedWatermark:    proposed,
		EventsDigest:         "edigest-" + batch,
		EventWindowUntil:     proposed.TimeNano,
		PendingPayloadJSON:   payload,
		PendingPayloadDigest: digest,
	}
}

func TestCreateAndReloadStable(t *testing.T) {
	p := testPath(t)
	a := mustStore(t, p)
	b := mustStore(t, p)
	if a.InstanceID() != b.InstanceID() {
		t.Fatalf("instance id unstable: %q vs %q", a.InstanceID(), b.InstanceID())
	}
	if len(a.InstanceID()) != DerivedIDLen {
		t.Fatalf("instance id len = %d, want %d", len(a.InstanceID()), DerivedIDLen)
	}
	// Key stored encoded, decodes to 32 bytes.
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var ps persistedState
	if err := json.Unmarshal(raw, &ps); err != nil {
		t.Fatal(err)
	}
	if ps.Version != StateVersion {
		t.Fatalf("version = %d", ps.Version)
	}
	kb, err := base64.RawURLEncoding.DecodeString(ps.InstallationKey)
	if err != nil {
		// allow padded fallback decode
		if kb2, err2 := base64.StdEncoding.DecodeString(ps.InstallationKey); err2 == nil {
			kb = kb2
		} else {
			t.Fatalf("key not decodable: %v", err)
		}
	}
	if len(kb) != InstallationKeyBytes {
		t.Fatalf("key len = %d", len(kb))
	}
	if ps.Sequence == 0 {
		t.Fatalf("sequence must be set")
	}
}

func TestFileMode0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits unsupported on windows")
	}
	p := testPath(t)
	mustStore(t, p)
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %04o, want 0600", fi.Mode().Perm())
	}
}

func TestDerivationExactVectors(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	// Recompute expected values directly from contract using stored key.
	raw, _ := os.ReadFile(p)
	var ps persistedState
	if err := json.Unmarshal(raw, &ps); err != nil {
		t.Fatal(err)
	}
	key, err := base64.RawURLEncoding.DecodeString(ps.InstallationKey)
	if err != nil {
		t.Fatal(err)
	}
	// agentInstanceId vector
	m := hmac.New(sha256.New, key)
	_, _ = m.Write([]byte("vps-manager/docker/agent-instance/v1"))
	want := base64.RawURLEncoding.EncodeToString(m.Sum(nil))[:32]
	if s.InstanceID() != want {
		t.Fatalf("agentInstanceId mismatch: got %q want %q", s.InstanceID(), want)
	}
	// containerKey vector with NUL separator
	full := "abc123def456fulldockerid789"
	m2 := hmac.New(sha256.New, key)
	_, _ = m2.Write([]byte("vps-manager/docker/container/v1"))
	_, _ = m2.Write([]byte{0})
	_, _ = m2.Write([]byte(full))
	wantC := base64.RawURLEncoding.EncodeToString(m2.Sum(nil))[:32]
	if got := s.ContainerKey(full); got != wantC {
		t.Fatalf("containerKey mismatch: got %q want %q", got, wantC)
	}
	// Without NUL must differ (guards separator regression).
	m3 := hmac.New(sha256.New, key)
	_, _ = m3.Write([]byte("vps-manager/docker/container/v1"))
	_, _ = m3.Write([]byte(full))
	bad := base64.RawURLEncoding.EncodeToString(m3.Sum(nil))[:32]
	if bad == wantC {
		t.Fatalf("NUL separator has no effect; contract violated")
	}
	if AgentInstanceDomain != "vps-manager/docker/agent-instance/v1" {
		t.Fatalf("domain constant changed")
	}
	if ContainerDomainPrefix != "vps-manager/docker/container/v1" {
		t.Fatalf("domain constant changed")
	}
	if DerivedIDLen != 32 {
		t.Fatalf("output length changed")
	}
}

func TestDerivationStableNoTokenDependency(t *testing.T) {
	p1 := testPath(t)
	p2 := filepath.Join(t.TempDir(), "other.json")
	a := mustStore(t, p1)
	b := mustStore(t, p2)
	if a.InstanceID() == b.InstanceID() {
		t.Fatalf("two independent installs must differ (random key, not token-derived)")
	}
	// Same store stable across calls and reloads.
	c1 := a.ContainerKey("full-id-xyz")
	c2 := a.ContainerKey("full-id-xyz")
	if c1 != c2 || len(c1) != 32 {
		t.Fatalf("containerKey unstable: %q %q", c1, c2)
	}
	if a.ContainerKey("id-a") == a.ContainerKey("id-b") {
		t.Fatalf("different containers must differ")
	}
	// base64url charset check
	for _, ch := range a.InstanceID() + c1 {
		if !(ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			t.Fatalf("non-base64url char %q", ch)
		}
	}
}

func TestRaceCreation(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "race.json")
	const n = 16
	var wg sync.WaitGroup
	ids := make([]string, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, err := LoadOrCreate(p)
			if err != nil {
				errs[i] = err
				return
			}
			ids[i] = s.InstanceID()
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: %v", i, err)
		}
	}
	for i := 1; i < n; i++ {
		if ids[i] != ids[0] {
			t.Fatalf("race winners diverged: %q vs %q", ids[0], ids[i])
		}
	}
	assertNoTempLeftovers(t, dir)
	// Winner file validates on plain reload.
	s := mustStore(t, p)
	if s.InstanceID() != ids[0] {
		t.Fatalf("reload mismatch")
	}
}

func TestCorruptionFailClosedNeverReplaced(t *testing.T) {
	cases := map[string]func(ps persistedState) []byte{
		"malformed":    func(ps persistedState) []byte { return []byte("{not json") },
		"empty":        func(ps persistedState) []byte { return []byte("") },
		"wrongVersion": func(ps persistedState) []byte { ps.Version = 99; b, _ := json.Marshal(ps); return b },
		"shortKey": func(ps persistedState) []byte {
			ps.InstallationKey = base64.RawURLEncoding.EncodeToString([]byte("short"))
			b, _ := json.Marshal(ps)
			return b
		},
		"badKey": func(ps persistedState) []byte {
			ps.InstallationKey = "!!!not-base64!!!"
			b, _ := json.Marshal(ps)
			return b
		},
		"negTime": func(ps persistedState) []byte {
			ps.Watermark.TimeNano = -5
			b, _ := json.Marshal(ps)
			return b
		},
		"tooManyDigests": func(ps persistedState) []byte {
			ps.Watermark.BoundaryDigests = make([]string, MaxBoundaryDigests+1)
			for i := range ps.Watermark.BoundaryDigests {
				ps.Watermark.BoundaryDigests[i] = fmt.Sprintf("d-%04d", i)
			}
			b, _ := json.Marshal(ps)
			return b
		},
		"unsortedDigests": func(ps persistedState) []byte {
			ps.Watermark = Watermark{TimeNano: 1, BoundaryDigests: []string{"b", "a"}}
			// need consistent pending nil; from==watermark fine
			b, _ := json.Marshal(ps)
			return b
		},
		"trailingData": func(ps persistedState) []byte {
			b, _ := json.Marshal(ps)
			return append(b, []byte(" trailing")...)
		},
		"unknownField": func(ps persistedState) []byte {
			b, _ := json.Marshal(ps)
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			m["surprise"] = 1
			b2, _ := json.Marshal(m)
			return b2
		},
		"nilDigests": func(ps persistedState) []byte {
			b, _ := json.Marshal(ps)
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			wm := m["watermark"].(map[string]any)
			wm["boundaryDigests"] = nil
			b2, _ := json.Marshal(m)
			return b2
		},
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "s.json")
			s := mustStore(t, p)
			_ = s
			raw, _ := os.ReadFile(p)
			var ps persistedState
			if err := json.Unmarshal(raw, &ps); err != nil {
				t.Fatal(err)
			}
			bad := mut(ps)
			if err := os.WriteFile(p, bad, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadOrCreate(p); err == nil {
				t.Fatalf("expected fail-closed error for %s", name)
			}
			// Never replaced: content still exactly the bad bytes (not rewritten).
			after, _ := os.ReadFile(p)
			if string(after) != string(bad) {
				t.Fatalf("corrupt file was modified; must never be replaced")
			}
		})
	}
}

func TestOverPermissiveFailsClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits unsupported on windows")
	}
	p := testPath(t)
	mustStore(t, p)
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(p); err == nil {
		t.Fatalf("expected over-permissive fail-closed")
	} else if !strings.Contains(err.Error(), "over-permissive") {
		t.Fatalf("unexpected error: %v", err)
	}
	// Fix perms still fails closed? No — after restoring 0600 it must load.
	if err := os.Chmod(p, 0o600); err != nil {
		t.Fatal(err)
	}
	mustStore(t, p)
}

func TestPendingIdempotentAndConflict(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	seq0 := s.Sequence()
	prop := Watermark{TimeNano: 100, BoundaryDigests: []string{}}
	batch := makePending(s, "b1", "snap1", prop)
	if err := s.PersistPending(batch); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if s.GetPending() == nil {
		t.Fatalf("pending missing")
	}
	seq1 := s.Sequence()
	if seq1 != seq0+1 {
		t.Fatalf("sequence must bump once: %d -> %d", seq0, seq1)
	}
	// Idempotent retry of identical batch.
	if err := s.PersistPending(batch); err != nil {
		t.Fatalf("idempotent retry must succeed: %v", err)
	}
	if s.Sequence() != seq1 {
		t.Fatalf("idempotent retry must not bump sequence")
	}
	// Second distinct batch conflicts.
	other := makePending(s, "b2", "snap2", Watermark{TimeNano: 200, BoundaryDigests: []string{}})
	if err := s.PersistPending(other); err == nil {
		t.Fatalf("second batch must conflict")
	}
	if got := s.GetPending(); got.BatchID != "b1" {
		t.Fatalf("pending must be unchanged")
	}
	// fromWatermark mismatch conflicts (fresh store without pending).
	p2 := testPath(t)
	s2 := mustStore(t, p2)
	stale := makePending(s2, "bx", "snapx", Watermark{TimeNano: 50, BoundaryDigests: []string{}})
	stale.FromWatermark = Watermark{TimeNano: 999, BoundaryDigests: []string{}}
	if err := s2.PersistPending(stale); err == nil {
		t.Fatalf("stale fromWatermark must conflict")
	}
	// Non-advancing proposed (equal to from) rejected.
	eq := makePending(s2, "be", "snape", s2.GetWatermark())
	if err := s2.PersistPending(eq); err == nil {
		t.Fatalf("non-advancing proposed must be rejected")
	}
	assertNoTempLeftovers(t, filepath.Dir(p))
	assertNoTempLeftovers(t, filepath.Dir(p2))
}

// ReserveSequence must durably advance the sequence before handing out the
// value, so a restart can never reissue a sequence already transmitted on
// the wire (the server rejects a duplicate with HTTP 500).
func TestReserveSequenceDurableMonotonic(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	first, err := s.ReserveSequence()
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if s.Sequence() != first+1 {
		t.Fatalf("in-memory sequence = %d, want pre-bump value %d advanced to %d", s.Sequence(), first, first+1)
	}
	second, err := s.ReserveSequence()
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if second != first+1 {
		t.Fatalf("second reserve = %d, want %d (strictly increasing)", second, first+1)
	}
	// The advance must be durable, not process-local: a fresh handle on the
	// same file sees it and keeps allocating above every prior value.
	re := mustStore(t, p)
	if re.Sequence() != second+1 {
		t.Fatalf("reloaded sequence = %d, want %d", re.Sequence(), second+1)
	}
	third, err := re.ReserveSequence()
	if err != nil {
		t.Fatalf("post-restart reserve: %v", err)
	}
	if third != second+1 {
		t.Fatalf("post-restart reserve = %d, must exceed pre-restart values (max %d)", third, second)
	}
}

// A reservation touches only the sequence: pending replay bytes and the
// watermark stay unchanged, the advance is durable, and the ack path still
// commits normally afterwards.
func TestReserveSequencePreservesPendingAndWatermark(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	prop := Watermark{TimeNano: 100, BoundaryDigests: []string{}}
	if err := s.PersistPending(makePending(s, "b1", "snap1", prop)); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if s.GetPending() == nil {
		t.Fatal("pending missing")
	}
	before := *s.GetPending()
	reserved, err := s.ReserveSequence()
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if reserved != s.Sequence()-1 {
		t.Fatalf("reserve returned %d, want pre-bump value %d", reserved, s.Sequence()-1)
	}
	after := s.GetPending()
	if after == nil {
		t.Fatal("reserve must not drop pending")
	}
	if after.BatchID != before.BatchID || after.SnapshotID != before.SnapshotID ||
		after.SourceSequence != before.SourceSequence ||
		after.PendingPayloadJSON != before.PendingPayloadJSON ||
		after.PendingPayloadDigest != before.PendingPayloadDigest {
		t.Fatalf("reserve must preserve pending replay bytes\n before=%+v\n after=%+v", before, *after)
	}
	if got := s.GetWatermark(); got.TimeNano != 0 || len(got.BoundaryDigests) != 0 {
		t.Fatalf("reserve must not advance watermark, got %+v", got)
	}
	// Durable before return: reload sees the advanced sequence, the intact
	// pending, and an untouched watermark.
	re := mustStore(t, p)
	if re.Sequence() != s.Sequence() {
		t.Fatalf("reloaded sequence = %d, want %d", re.Sequence(), s.Sequence())
	}
	rp := re.GetPending()
	if rp == nil || rp.PendingPayloadJSON != before.PendingPayloadJSON || rp.SourceSequence != before.SourceSequence {
		t.Fatalf("reloaded pending must keep exact replay bytes, got %+v", rp)
	}
	// Ack path unaffected by the reservation: commit still succeeds.
	if err := re.CommitAcknowledgement("b1", "snap1", re.InstanceID(), prop); err != nil {
		t.Fatalf("commit after reserve: %v", err)
	}
	if re.GetPending() != nil {
		t.Fatal("pending must clear on commit")
	}
	if got := re.GetWatermark().TimeNano; got != 100 {
		t.Fatalf("committed watermark after reload = %d, want 100", got)
	}
	assertNoTempLeftovers(t, filepath.Dir(p))
}

func TestCommitMismatchedAck(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	prop := Watermark{TimeNano: 1000, BoundaryDigests: []string{"aa"}}
	batch := makePending(s, "b1", "s1", prop)
	if err := s.PersistPending(batch); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name        string
		b, sn, inst string
		wm          Watermark
	}{
		{"badBatch", "nope", "s1", s.InstanceID(), prop},
		{"badSnap", "b1", "nope", s.InstanceID(), prop},
		{"badInst", "b1", "s1", "wrong-instance-id-0000000000000", prop},
		{"badWatermark", "b1", "s1", s.InstanceID(), Watermark{TimeNano: 1000, BoundaryDigests: []string{"zz"}}},
		{"backward", "b1", "s1", s.InstanceID(), Watermark{TimeNano: 1, BoundaryDigests: []string{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := s.CommitAcknowledgement(tc.b, tc.sn, tc.inst, tc.wm); err == nil {
				t.Fatalf("expected mismatch error")
			}
			if s.GetPending() == nil {
				t.Fatalf("pending must be preserved on failed ack")
			}
		})
	}
}

func TestCommitMonotonicExact(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	if err := s.PersistPending(makePending(s, "b1", "s1", Watermark{TimeNano: 10, BoundaryDigests: []string{}})); err != nil {
		t.Fatal(err)
	}
	if err := s.CommitAcknowledgement("b1", "s1", s.InstanceID(), Watermark{TimeNano: 10, BoundaryDigests: []string{}}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if s.GetPending() != nil {
		t.Fatalf("pending must be cleared")
	}
	if got := s.GetWatermark(); got.TimeNano != 10 {
		t.Fatalf("watermark = %+v", got)
	}
	// No pending -> commit rejected.
	if err := s.CommitAcknowledgement("b1", "s1", s.InstanceID(), Watermark{TimeNano: 10, BoundaryDigests: []string{}}); err == nil {
		t.Fatalf("commit without pending must fail")
	}
	// Same-timeNano digest advance is forward and committable.
	if err := s.PersistPending(makePending(s, "b2", "s2", Watermark{TimeNano: 10, BoundaryDigests: []string{"q"}})); err != nil {
		t.Fatalf("same-nano digest advance must be allowed: %v", err)
	}
	if err := s.CommitAcknowledgement("b2", "s2", s.InstanceID(), Watermark{TimeNano: 10, BoundaryDigests: []string{"q"}}); err != nil {
		t.Fatalf("commit digest advance: %v", err)
	}
	assertNoTempLeftovers(t, filepath.Dir(p))
}

func TestCrashStages(t *testing.T) {
	// Crash before pending write: reload shows no pending.
	p := testPath(t)
	a := mustStore(t, p)
	id := a.InstanceID()
	b, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	if b.GetPending() != nil || b.InstanceID() != id {
		t.Fatalf("unexpected state after clean reload")
	}
	// Crash after write before request: pending survives reload.
	prop := Watermark{TimeNano: 77, BoundaryDigests: []string{}}
	if err := b.PersistPending(makePending(b, "cb", "cs", prop)); err != nil {
		t.Fatal(err)
	}
	c, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	got := c.GetPending()
	if got == nil || got.BatchID != "cb" {
		t.Fatalf("pending must survive crash, got %+v", got)
	}
	// Crash after commit: pending cleared, watermark durable.
	if err := c.CommitAcknowledgement("cb", "cs", c.InstanceID(), prop); err != nil {
		t.Fatal(err)
	}
	d, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	if d.GetPending() != nil {
		t.Fatalf("pending must be gone after commit")
	}
	if d.GetWatermark().TimeNano != 77 {
		t.Fatalf("watermark not durable")
	}
	// Torn write fails closed.
	if err := os.WriteFile(p, []byte(`{"version":1,"installationKey":"`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(p); err == nil {
		t.Fatalf("torn file must fail closed")
	}
}

func TestAtomicNoTempLeftoversAfterUpdates(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "s.json")
	s := mustStore(t, p)
	for i := 0; i < 5; i++ {
		prop := Watermark{TimeNano: int64(100 + i), BoundaryDigests: []string{}}
		bid := fmt.Sprintf("b%d", i)
		sid := fmt.Sprintf("s%d", i)
		if err := s.PersistPending(makePending(s, bid, sid, prop)); err != nil {
			t.Fatal(err)
		}
		if err := s.CommitAcknowledgement(bid, sid, s.InstanceID(), prop); err != nil {
			t.Fatal(err)
		}
	}
	assertNoTempLeftovers(t, dir)
	// File is valid and sequence advanced by 10.
	r, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	if r.Sequence() != s.Sequence() {
		t.Fatalf("reload sequence mismatch")
	}
	if r.GetWatermark().TimeNano != 104 {
		t.Fatalf("watermark = %+v", r.GetWatermark())
	}
}

func TestGetCopiesAreIndependent(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	w := s.GetWatermark()
	w.TimeNano = 9999
	if s.GetWatermark().TimeNano == 9999 {
		t.Fatalf("GetWatermark must return a copy")
	}
	if err := s.PersistPending(makePending(s, "b", "s", Watermark{TimeNano: 5, BoundaryDigests: []string{"x"}})); err != nil {
		t.Fatal(err)
	}
	gp := s.GetPending()
	gp.BatchID = "mutated"
	if s.GetPending().BatchID == "mutated" {
		t.Fatalf("GetPending must return a copy")
	}
}

func TestPendingPayloadRoundtrip(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	prop := Watermark{TimeNano: 100, BoundaryDigests: []string{}}
	batch := makePending(s, "b1", "snap1", prop)
	if err := s.PersistPending(batch); err != nil {
		t.Fatalf("persist: %v", err)
	}
	got := s.GetPending()
	if got == nil || got.PendingPayloadJSON != batch.PendingPayloadJSON || got.PendingPayloadDigest != batch.PendingPayloadDigest {
		t.Fatalf("pending payload mismatch: %+v", got)
	}
	r, err := LoadOrCreate(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	rg := r.GetPending()
	if rg == nil || rg.PendingPayloadJSON != batch.PendingPayloadJSON || rg.PendingPayloadDigest != batch.PendingPayloadDigest {
		t.Fatalf("reloaded payload mismatch: %+v", rg)
	}
}

func TestPendingPayloadNestedEventsStorageJSON(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	prop := Watermark{TimeNano: 100, BoundaryDigests: []string{}}
	batch := makePending(s, "b1", "snap1", prop)
	nested := `{"batchId":"b1","events":[{"digest":"abc","action":"start"}],"storage":{"writable":{"usedBytes":10}}}`
	sum := sha256.Sum256([]byte(nested))
	batch.PendingPayloadJSON = nested
	batch.PendingPayloadDigest = hex.EncodeToString(sum[:])
	if err := s.PersistPending(batch); err != nil {
		t.Fatalf("nested payload must persist: %v", err)
	}
	if got := s.GetPending(); got.PendingPayloadJSON != nested {
		t.Fatalf("nested payload mismatch")
	}
	r, err := LoadOrCreate(p)
	if err != nil {
		t.Fatalf("reload nested: %v", err)
	}
	if got := r.GetPending(); got.PendingPayloadJSON != nested {
		t.Fatalf("reloaded nested mismatch")
	}
}

func TestPendingPayloadRejects(t *testing.T) {
	cases := map[string]func(batch PendingBatch) PendingBatch{
		"empty": func(b PendingBatch) PendingBatch { b.PendingPayloadJSON = ""; return b },
		"invalid": func(b PendingBatch) PendingBatch {
			b.PendingPayloadJSON = "{not json"
			sum := sha256.Sum256([]byte(b.PendingPayloadJSON))
			b.PendingPayloadDigest = hex.EncodeToString(sum[:])
			return b
		},
		"arrayTopLevel": func(b PendingBatch) PendingBatch {
			b.PendingPayloadJSON = `[1,2,3]`
			sum := sha256.Sum256([]byte(b.PendingPayloadJSON))
			b.PendingPayloadDigest = hex.EncodeToString(sum[:])
			return b
		},
		"trailingJSON": func(b PendingBatch) PendingBatch {
			b.PendingPayloadJSON = `{"a":1} {"b":2}`
			sum := sha256.Sum256([]byte(b.PendingPayloadJSON))
			b.PendingPayloadDigest = hex.EncodeToString(sum[:])
			return b
		},
		"trailingGarbage": func(b PendingBatch) PendingBatch {
			b.PendingPayloadJSON = `{"a":1} trailing`
			sum := sha256.Sum256([]byte(b.PendingPayloadJSON))
			b.PendingPayloadDigest = hex.EncodeToString(sum[:])
			return b
		},
		"digestMismatch": func(b PendingBatch) PendingBatch {
			b.PendingPayloadDigest = strings.Repeat("0", 64)
			return b
		},
		"emptyDigest": func(b PendingBatch) PendingBatch { b.PendingPayloadDigest = ""; return b },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			s := mustStore(t, testPath(t))
			batch := mut(makePending(s, "b1", "s1", Watermark{TimeNano: 10, BoundaryDigests: []string{}}))
			if err := s.PersistPending(batch); err == nil {
				t.Fatalf("expected rejection for %s", name)
			}
			if s.GetPending() != nil {
				t.Fatalf("rejected payload must not persist")
			}
		})
	}
}

func TestPendingPayloadOversize(t *testing.T) {
	s := mustStore(t, testPath(t))
	batch := makePending(s, "b1", "s1", Watermark{TimeNano: 10, BoundaryDigests: []string{}})
	// Build a canonical object just over 128KiB.
	fill := strings.Repeat("x", MaxPendingPayloadBytes)
	payload := `{"pad":` + strconv.Quote(fill) + `}`
	if len(payload) <= MaxPendingPayloadBytes {
		t.Fatalf("test payload not oversize: %d", len(payload))
	}
	sum := sha256.Sum256([]byte(payload))
	batch.PendingPayloadJSON = payload
	batch.PendingPayloadDigest = hex.EncodeToString(sum[:])
	if err := s.PersistPending(batch); err == nil {
		t.Fatalf("oversize payload must be rejected")
	} else if !strings.Contains(err.Error(), "oversize") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPendingPayloadTamperFailClosed(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	batch := makePending(s, "b1", "s1", Watermark{TimeNano: 10, BoundaryDigests: []string{}})
	if err := s.PersistPending(batch); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	pm := m["pending"].(map[string]any)
	orig := pm["v2PayloadJSON"].(string)
	// Flip one byte inside the JSON string while keeping the digest.
	tampered := orig[:len(orig)-2] + "zz" + orig[len(orig)-1:]
	// Ensure still valid JSON shape is irrelevant: digest will mismatch.
	pm["v2PayloadJSON"] = tampered
	bad, _ := json.Marshal(m)
	if err := os.WriteFile(p, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(p); err == nil {
		t.Fatalf("tampered payload must fail closed")
	} else if !strings.Contains(err.Error(), "fail closed") {
		t.Fatalf("unexpected error: %v", err)
	}
	after, _ := os.ReadFile(p)
	if string(after) != string(bad) {
		t.Fatalf("tampered file must never be replaced")
	}
}

func TestPendingPayloadIdempotentEqualAndConflict(t *testing.T) {
	p := testPath(t)
	s := mustStore(t, p)
	prop := Watermark{TimeNano: 100, BoundaryDigests: []string{}}
	batch := makePending(s, "b1", "s1", prop)
	if err := s.PersistPending(batch); err != nil {
		t.Fatal(err)
	}
	seq := s.Sequence()
	if err := s.PersistPending(batch); err != nil {
		t.Fatalf("identical payload retry must be idempotent: %v", err)
	}
	if s.Sequence() != seq {
		t.Fatalf("idempotent retry must not bump sequence")
	}
	other := batch
	alt := `{"batchId":"b1","snapshotId":"s1","alt":true}`
	sum := sha256.Sum256([]byte(alt))
	other.PendingPayloadJSON = alt
	other.PendingPayloadDigest = hex.EncodeToString(sum[:])
	if err := s.PersistPending(other); err == nil {
		t.Fatalf("different payload must conflict")
	}
	if got := s.GetPending(); got.PendingPayloadJSON != batch.PendingPayloadJSON {
		t.Fatalf("pending must be unchanged after conflict")
	}
}

func assertNoTempLeftovers(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp.") {
			t.Fatalf("temp leftover: %s", e.Name())
		}
	}
}
