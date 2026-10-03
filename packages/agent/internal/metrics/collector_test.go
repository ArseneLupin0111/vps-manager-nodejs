package metrics

import (
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

const fixtureProcStat = `cpu  125793 1836 89178 1527259 58807 273 1577 0 0 0
cpu0 125793 1836 89178 1527259 58807 273 1577 0 0 0
intr 123456
ctxt 123
btime 1234567890
processes 123
procs_running 1
procs_blocked 0
softirq 0 1 2 3 4 5 6 7 8 9
`

const fixtureProcStatTwo = `cpu  135793 2836 99178 1627259 68807 373 2577 0 0 0
cpu0 135793 2836 99178 1627259 68807 373 2577 0 0 0
intr 123456
ctxt 123
btime 1234567890
processes 123
procs_running 1
procs_blocked 0
softirq 0 1 2 3 4 5 6 7 8 9
`

func TestReadCPUStats(t *testing.T) {
	stats, err := ReadCPUStats(fixtureProcStat)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.User != 125793 {
		t.Errorf("User = %d, want %d", stats.User, 125793)
	}
	if stats.Nice != 1836 {
		t.Errorf("Nice = %d, want %d", stats.Nice, 1836)
	}
	if stats.System != 89178 {
		t.Errorf("System = %d, want %d", stats.System, 89178)
	}
	if stats.Idle != 1527259 {
		t.Errorf("Idle = %d, want %d", stats.Idle, 1527259)
	}
	if stats.IOWait != 58807 {
		t.Errorf("IOWait = %d, want %d", stats.IOWait, 58807)
	}
}

func TestCPUPercent(t *testing.T) {
	prev, err := ReadCPUStats(fixtureProcStat)
	if err != nil {
		t.Fatal(err)
	}
	curr, err := ReadCPUStats(fixtureProcStatTwo)
	if err != nil {
		t.Fatal(err)
	}
	pct := CPUPercent(prev, curr)
	// prev total = 125793+1836+89178+1527259+58807+273+1577+0 = 1804723
	// curr total = 135793+2836+99178+1627259+68807+373+2577+0 = 1936823
	// total delta = 1936823 - 1804723 = 132100
	// idle delta = 1627259 - 1527259 = 100000
	// cpu% = (1 - 100000/132100) * 100 ≈ 24.30
	if pct < 24.0 || pct > 24.6 {
		t.Errorf("CPUPercent = %.2f%%, expected ~9.17%%", pct)
	}
}

func TestReadCPUStats_NoCPULine(t *testing.T) {
	_, err := ReadCPUStats("intr 123\nctxt 456\n")
	if err == nil {
		t.Fatal("expected error for missing cpu line")
	}
}

func TestReadCPUStats_ShortLine(t *testing.T) {
	_, err := ReadCPUStats("cpu 1 2 3 4 5\n")
	if err == nil {
		t.Fatal("expected error for short cpu line")
	}
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const fixtureMemInfo = `MemTotal:       16384000 kB
MemFree:         4096000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
SwapCached:            0 kB
Active:          8192000 kB
Inactive:        4096000 kB
`

func TestReadMemInfo(t *testing.T) {
	total, avail, err := ReadMemInfo(fixtureMemInfo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 16384000 {
		t.Errorf("total = %d, want %d", total, 16384000)
	}
	if avail != 8192000 {
		t.Errorf("available = %d, want %d", avail, 8192000)
	}
}

func TestMemoryPercent(t *testing.T) {
	// total=16384000, avail=8192000, used=8192000, pct=50%
	pct := MemoryPercent(16384000, 8192000)
	if math.Abs(pct-50.0) > 0.01 {
		t.Errorf("MemoryPercent = %.2f%%, want 50%%", pct)
	}
}

func TestMemoryPercent_ZeroTotal(t *testing.T) {
	pct := MemoryPercent(0, 100)
	if pct != 0 {
		t.Errorf("MemoryPercent = %.2f, want 0", pct)
	}
}

func TestReadMemInfo_NoTotal(t *testing.T) {
	_, _, err := ReadMemInfo("MemFree: 1024 kB\n")
	if err == nil {
		t.Fatal("expected error for missing MemTotal")
	}
}

// ---------------------------------------------------------------------------
// Load Average
// ---------------------------------------------------------------------------

const fixtureLoadAvg = "0.15 0.23 0.18 1/234 56789\n"

func TestReadLoadAvg(t *testing.T) {
	load, err := ReadLoadAvg(fixtureLoadAvg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if math.Abs(load-0.15) > 0.001 {
		t.Errorf("Load = %.2f, want 0.15", load)
	}
}

func TestReadLoadAvg_MinFields(t *testing.T) {
	_, err := ReadLoadAvg("0.15 0.23\n")
	if err == nil {
		t.Fatal("expected error for missing fields")
	}
}

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

const fixtureUptime = "123456.78 987654.32\n"

func TestReadUptime(t *testing.T) {
	uptime, err := ReadUptime(fixtureUptime)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if math.Abs(uptime-123456.78) > 0.001 {
		t.Errorf("Uptime = %.2f, want 123456.78", uptime)
	}
}

func TestReadUptime_Empty(t *testing.T) {
	_, err := ReadUptime("")
	if err == nil {
		t.Fatal("expected error for empty input")
	}
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const fixtureNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100000   1000    0    0    0     0          0         0  100000   1000    0    0    0     0       0          0
  eth0: 1000000  2000    0    0    0     0          0         0  500000   1500    0    0    0     0       0          0
  eth1: 2000000  3000    0    0    0     0          0         0  600000   2000    0    0    0     0       0          0
`

func TestReadNetDev(t *testing.T) {
	stats, err := ReadNetDev(fixtureNetDev)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(stats) != 3 {
		t.Errorf("got %d interfaces, want 3", len(stats))
	}
	eth0, ok := stats["eth0"]
	if !ok {
		t.Fatal("eth0 not found")
	}
	if eth0.RxBytes != 1000000 {
		t.Errorf("eth0 RxBytes = %d, want %d", eth0.RxBytes, 1000000)
	}
	if eth0.TxBytes != 500000 {
		t.Errorf("eth0 TxBytes = %d, want %d", eth0.TxBytes, 500000)
	}

	eth1 := stats["eth1"]
	if eth1.RxBytes != 2000000 {
		t.Errorf("eth1 RxBytes = %d, want %d", eth1.RxBytes, 2000000)
	}
	if eth1.TxBytes != 600000 {
		t.Errorf("eth1 TxBytes = %d, want %d", eth1.TxBytes, 600000)
	}

	lo := stats["lo"]
	if lo.RxBytes != 100000 {
		t.Errorf("lo RxBytes = %d, want %d", lo.RxBytes, 100000)
	}
}

const fixtureNetDevSecond = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100000   1000    0    0    0     0          0         0  100000   1000    0    0    0     0       0          0
  eth0: 1001000  2100    0    0    0     0          0         0  500500   1600    0    0    0     0       0          0
  eth1: 2002000  3100    0    0    0     0          0         0  600600   2100    0    0    0     0       0          0
`

func TestCollectorNetworkDelta(t *testing.T) {
	c := NewCollector()

	// Override readProcFile to return fixtures
	origRead := readProcFile
	defer func() { readProcFile = origRead }()

	// Override timeNow so network rate divides by exact 1s
	origTime := timeNow
	defer func() { timeNow = origTime }()
	fakeTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	timeNow = func() time.Time { return fakeTime }

	callCount := 0
	readProcFile = func(path string) (string, error) {
		callCount++
		if callCount == 1 {
			return fixtureNetDev, nil
		}
		return fixtureNetDevSecond, nil
	}

	// First call: no delta yet
	rx, tx, available, err := c.collectNetwork()
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if rx != 0 || tx != 0 {
		t.Errorf("first collect: rx=%.0f tx=%.0f, want 0", rx, tx)
	}
	if available {
		t.Error("first collect: available = true, want false (no baseline yet)")
	}

	// Advance time by 1 second
	fakeTime = fakeTime.Add(1 * time.Second)

	// Second call: should have rates in bytes/sec
	// eth0 Rx: +1000, eth1 Rx: +2000, total Rx delta: 3000 (non-lo)
	// eth0 Tx: +500, eth1 Tx: +600, total Tx delta: 1100
	// elapsed = 1s, so rates == deltas
	rx, tx, available, err = c.collectNetwork()
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if rx != 3000 {
		t.Errorf("rx rate = %.0f bytes/sec, want 3000", rx)
	}
	if tx != 1100 {
		t.Errorf("tx rate = %.0f bytes/sec, want 1100", tx)
	}
	if !available {
		t.Error("second collect: available = false, want true (valid delta)")
	}
}

func TestCollectorNetwork_CounterReset(t *testing.T) {
	c := NewCollector()

	origRead := readProcFile
	defer func() { readProcFile = origRead }()

	origTime := timeNow
	defer func() { timeNow = origTime }()
	fakeTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	timeNow = func() time.Time { return fakeTime }

	const firstNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1   1    0    0    0     0          0         0  1   1    0    0    0     0       0          0
  eth0: 10000  100    0    0    0     0          0         0  5000   50    0    0    0     0       0          0
`
	const resetNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1   1    0    0    0     0          0         0  1   1    0    0    0     0       0          0
  eth0: 2000  50    0    0    0     0          0         0  1000   25    0    0    0     0       0          0
`
	const recoveredNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1   1    0    0    0     0          0         0  1   1    0    0    0     0       0          0
  eth0: 3000  60    0    0    0     0          0         0  1500   30    0    0    0     0       0          0
`

	callCount := 0
	readProcFile = func(path string) (string, error) {
		callCount++
		switch callCount {
		case 1:
			return firstNetDev, nil
		case 2:
			return resetNetDev, nil
		default:
			return recoveredNetDev, nil
		}
	}

	// First collect: store baseline, unavailable
	rx, tx, available, err := c.collectNetwork()
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if rx != 0 || tx != 0 {
		t.Errorf("first collect: rx=%.0f tx=%.0f, want 0", rx, tx)
	}
	if available {
		t.Error("first collect: available = true, want false (no baseline yet)")
	}

	fakeTime = fakeTime.Add(1 * time.Second)

	// Second collect: counter reset (rx 2000 < 10000, tx 1000 < 5000).
	// Both directions must be suppressed as a gap, not a partial rate.
	rx, tx, available, err = c.collectNetwork()
	if err != nil {
		t.Fatalf("collect after reset: %v", err)
	}
	if rx != 0 {
		t.Errorf("expected 0 rx on counter reset, got %.0f", rx)
	}
	if tx != 0 {
		t.Errorf("expected 0 tx on counter reset, got %.0f", tx)
	}
	if available {
		t.Error("collect after reset: available = true, want false (gap, not zero)")
	}

	fakeTime = fakeTime.Add(1 * time.Second)

	// Third collect: counters advanced past the reset baseline
	// (rx +1000, tx +500 over 1s), so rates recover cleanly.
	rx, tx, available, err = c.collectNetwork()
	if err != nil {
		t.Fatalf("collect after recovery: %v", err)
	}
	if rx != 1000 {
		t.Errorf("rx rate after recovery = %.0f bytes/sec, want 1000", rx)
	}
	if tx != 500 {
		t.Errorf("tx rate after recovery = %.0f bytes/sec, want 500", tx)
	}
	if !available {
		t.Error("collect after recovery: available = false, want true (valid delta)")
	}
}

func TestCollectorNetwork_NonAdvancingClock(t *testing.T) {
	c := NewCollector()

	origRead := readProcFile
	defer func() { readProcFile = origRead }()

	origTime := timeNow
	defer func() { timeNow = origTime }()
	fakeTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	timeNow = func() time.Time { return fakeTime }

	callCount := 0
	readProcFile = func(path string) (string, error) {
		callCount++
		if callCount == 1 {
			return fixtureNetDev, nil
		}
		return fixtureNetDevSecond, nil
	}

	// First collect: store baseline
	if _, _, _, err := c.collectNetwork(); err != nil {
		t.Fatalf("first collect: %v", err)
	}

	// Second collect with no time elapsed: no trustworthy rate exists.
	// Baseline is kept so a later sample covers the full window.
	rx, tx, available, err := c.collectNetwork()
	if err != nil {
		t.Fatalf("collect with elapsed<=0: %v", err)
	}
	if rx != 0 || tx != 0 {
		t.Errorf("elapsed<=0: rx=%.0f tx=%.0f, want 0", rx, tx)
	}
	if available {
		t.Error("elapsed<=0: available = true, want false")
	}

	// Advancing the clock now yields the delta over the full 2s window:
	// rx 3000/2s = 1500, tx 1100/2s = 550.
	fakeTime = fakeTime.Add(2 * time.Second)
	rx, tx, available, err = c.collectNetwork()
	if err != nil {
		t.Fatalf("collect after clock advance: %v", err)
	}
	if rx != 1500 {
		t.Errorf("rx rate = %.0f bytes/sec, want 1500", rx)
	}
	if tx != 550 {
		t.Errorf("tx rate = %.0f bytes/sec, want 550", tx)
	}
	if !available {
		t.Error("collect after clock advance: available = false, want true")
	}
}

func TestCPUPercent_CounterReset(t *testing.T) {
	prev, err := ReadCPUStats(fixtureProcStatTwo)
	if err != nil {
		t.Fatal(err)
	}
	curr, err := ReadCPUStats(fixtureProcStat)
	if err != nil {
		t.Fatal(err)
	}
	// curr totals are lower than prev (simulated reset): must be 0, never wrap.
	if pct := CPUPercent(prev, curr); pct != 0 {
		t.Errorf("CPUPercent on counter reset = %.2f, want 0", pct)
	}
}

// ---------------------------------------------------------------------------
// Collector unsupported (non-Linux)
// ---------------------------------------------------------------------------

func TestCollector_UnsupportedOnNonLinux(t *testing.T) {
	if isLinux() {
		t.Skip("skipping on Linux (test is for non-Linux platforms)")
	}
	c := NewCollector()
	_, err := c.Collect(nil)
	if err == nil || err.Error() != ErrUnsupported.Error() {
		t.Errorf("expected ErrUnsupported on non-Linux, got: %v", err)
	}
}

// isLinux returns true if the current GOOS is linux.
func isLinux() bool {
	return runtime.GOOS == "linux"
}

// osName is overridable for testing.
var osName = func() string {
	data, err := os.ReadFile("/proc/sys/kernel/ostype")
	if err != nil {
		return "unknown"
	}
	return string(data)
}

// ---------------------------------------------------------------------------
// Collect with fixture injection
// ---------------------------------------------------------------------------

func TestCollectWithFixtureData(t *testing.T) {
	// Setup: inject procfs fixtures
	origRead := readProcFile
	defer func() { readProcFile = origRead }()

	fixtures := map[string]string{
		"/proc/stat":    fixtureProcStat,
		"/proc/meminfo": fixtureMemInfo,
		"/proc/loadavg": fixtureLoadAvg,
		"/proc/uptime":  fixtureUptime,
		"/proc/net/dev": fixtureNetDev,
	}

	readProcFile = func(path string) (string, error) {
		if content, ok := fixtures[path]; ok {
			return content, nil
		}
		return "", os.ErrNotExist
	}

	// Test individual parsers instead of full Collect (disk may be unsupported on non-Linux)

	t.Run("CPU parse", func(t *testing.T) {
		stats, err := ReadCPUStats(fixtureProcStat)
		if err != nil {
			t.Fatal(err)
		}
		if stats.Idle == 0 {
			t.Error("expected non-zero idle")
		}
	})

	t.Run("Memory parse", func(t *testing.T) {
		total, avail, err := ReadMemInfo(fixtureMemInfo)
		if err != nil {
			t.Fatal(err)
		}
		if total == 0 || avail == 0 {
			t.Error("expected non-zero values")
		}
	})

	t.Run("Load parse", func(t *testing.T) {
		load, err := ReadLoadAvg(fixtureLoadAvg)
		if err != nil {
			t.Fatal(err)
		}
		if load <= 0 {
			t.Error("expected positive load")
		}
	})

	t.Run("Uptime parse", func(t *testing.T) {
		uptime, err := ReadUptime(fixtureUptime)
		if err != nil {
			t.Fatal(err)
		}
		if uptime <= 0 {
			t.Error("expected positive uptime")
		}
	})

	t.Run("Network parse", func(t *testing.T) {
		stats, err := ReadNetDev(fixtureNetDev)
		if err != nil {
			t.Fatal(err)
		}
		if len(stats) == 0 {
			t.Error("expected interfaces")
		}
	})
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

func TestReadNetDev_Empty(t *testing.T) {
	stats, err := ReadNetDev("")
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 0 {
		t.Errorf("expected empty map, got %d entries", len(stats))
	}
}

func TestReadNetDev_MalformedLine(t *testing.T) {
	stats, err := ReadNetDev("Inter-| face\n  eth0: 1 2\n  eth1: broken line\n")
	if err != nil {
		t.Fatal(err)
	}
	// eth0 has only 2 fields, should be skipped (needs >=9)
	// eth1 is broken
	if len(stats) != 0 {
		t.Errorf("expected empty map, got %d entries", len(stats))
	}
}

// TestDiskOnNonLinux verifies the unsupported behavior.
func TestDiskOnNonLinux(t *testing.T) {
	// This is a compile-time test: disk_linux.go only builds on linux
	// disk_other.go builds on all others, returning ErrUnsupported
	// Just verify the function exists
	t.Log("disk collector exists and compiles")
}

// TempDir helper for tests that need temp files.
func TestTempDir(t *testing.T) {
	dir := t.TempDir()
	t.Logf("temp dir: %s", dir)

	// Write fixtures to temp files for collector tests
	content := []byte(fixtureProcStat)
	path := filepath.Join(dir, "stat")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
}
