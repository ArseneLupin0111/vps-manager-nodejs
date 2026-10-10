package logs

import (
	"bytes"
	"encoding/binary"
	"io"
	"strings"
	"testing"
	"unicode/utf8"
)

// frame writes one multiplexed Docker frame.
func frame(stream byte, payload []byte) []byte {
	out := make([]byte, frameHeaderSize+len(payload))
	out[0] = stream
	binary.BigEndian.PutUint32(out[4:8], uint32(len(payload)))
	copy(out[frameHeaderSize:], payload)
	return out
}

// chunkedReader hands out one byte at a time to prove the decoder
// reassembles across read boundaries.
type chunkedReader struct {
	b []byte
	i int
}

func (c *chunkedReader) Read(p []byte) (int, error) {
	if c.i >= len(c.b) {
		return 0, io.EOF
	}
	p[0] = c.b[c.i]
	c.i++
	return 1, nil
}

// collect decodes everything from r and returns all frames as
// (stream, chunk-slice) pairs.
func collect(t *testing.T, r io.Reader, tty bool, bufSize int) []frameChunk {
	t.Helper()
	src := newPayloadReader(r, tty, bufSize)
	var got []frameChunk
	for {
		_, err := src.ReadPayload(func(rid int, chunk []byte) error {
			got = append(got, frameChunk{stream: rid, chunk: append([]byte(nil), chunk...)})
			return nil
		})
		if err == io.EOF {
			return got
		}
		if err != nil {
			t.Fatalf("ReadPayload: %v", err)
		}
	}
}

type frameChunk struct {
	stream int
	chunk  []byte
}

func TestDemuxSplitByteByByte(t *testing.T) {
	// Reassembly is per-frame, not per-read: the 8 KiB buffer slices payloads
	// into bounded chunks, so a payload arrives in several ReadPayload sink
	// calls but must be re-joined by the consumer before the next frame.
	body := bytes.Join([][]byte{
		frame(streamIDStdout, []byte("hello")),
		frame(streamIDStderr, []byte("err")),
		frame(streamIDStdout, []byte(" tail")),
	}, nil)
	got := collect(t, &chunkedReader{b: body}, false, 3)
	var perFrame []string
	var cur []byte
	var streams []int
	closeFrame := func() {
		if cur != nil {
			s := string(cur)
			perFrame = append(perFrame, s)
			cur = nil
			_ = s
		}
	}
	prevStream := -1
	for i, c := range got {
		if i > 0 && c.stream != prevStream {
			streams = append(streams, prevStream)
			closeFrame()
		}
		cur = append(cur, c.chunk...)
		prevStream = c.stream
	}
	closeFrame()
	streams = append(streams, prevStream)
	want := []string{"hello", "err", " tail"}
	if len(perFrame) != len(want) {
		t.Fatalf("frames = %d, want %d (%q)", len(perFrame), len(want), perFrame)
	}
	for i := range want {
		if perFrame[i] != want[i] {
			t.Fatalf("frame %d = %q, want %q", i, perFrame[i], want[i])
		}
	}
	if streams[0] != streamIDStdout || streams[1] != streamIDStderr || streams[2] != streamIDStdout {
		t.Fatalf("stream order wrong: %v", streams)
	}
}

func TestDemuxEmptyFrameAndEOF(t *testing.T) {
	body := frame(streamIDStdout, nil)
	got := collect(t, bytes.NewReader(body), false, 4)
	if len(got) != 0 {
		t.Fatalf("expected no chunks from empty frame, got %q", got)
	}
}

func TestDemuxMalformed(t *testing.T) {
	cases := map[string][]byte{
		"bad stream byte":     {3, 0, 0, 0, 0, 0, 0, 1, 'x'},
		"reserved not zero":   {streamIDStdout, 1, 0, 0, 0, 0, 0, 1, 'x'},
		"reserved not zero 2": {streamIDStdout, 0, 0, 1, 0, 0, 0, 1, 'x'},
		"oversized size":      {streamIDStdout, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF},
		"truncated payload":   {streamIDStdout, 0, 0, 0, 0, 0, 0, 10, 'a', 'b'},
		"truncated header":    {streamIDStdout, 0, 0, 0, 0, 0},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			src := newDemuxReader(bytes.NewReader(body), 8)
			var chunks int
			_, err := src.ReadPayload(func(int, []byte) error {
				chunks++
				return nil
			})
			if err == nil || err == io.EOF {
				t.Fatalf("expected error, got %v (chunks=%d)", err, chunks)
			}
		})
	}
}

func TestRawReader(t *testing.T) {
	got := collect(t, bytes.NewReader([]byte("abc")), true, 2)
	var joined []string
	for _, c := range got {
		if c.stream != 0 {
			t.Fatalf("raw stream id = %d, want 0", c.stream)
		}
		joined = append(joined, string(c.chunk))
	}
	if len(joined) != 2 || joined[0] != "ab" || joined[1] != "c" {
		t.Fatalf("raw chunks = %q", joined)
	}
}

func TestPayloadBufferReusedNoFrameAllocation(t *testing.T) {
	big := bytes.Repeat([]byte{'x'}, 64*1024)
	src := newDemuxReader(bytes.NewReader(frame(streamIDStdout, big)), 512)
	first := src.payloadBuf
	consumed := 0
	_, err := src.ReadPayload(func(_ int, chunk []byte) error {
		if &chunk[0] != &first[0] {
			t.Fatalf("payload chunk did not alias the reused buffer")
		}
		consumed += len(chunk)
		return nil
	})
	if err != nil {
		t.Fatalf("ReadPayload: %v", err)
	}
	if consumed != len(big) {
		t.Fatalf("consumed %d, want %d", consumed, len(big))
	}
}

// lines decodes a body into LogLines.
func lines(t *testing.T, r io.Reader, tty bool) []LogLine {
	t.Helper()
	src := newPayloadReader(r, tty, 8)
	out := newLineAssembler(StreamStdout)
	errA := newLineAssembler(StreamStderr)
	comb := newLineAssembler(StreamCombined)
	var got []LogLine
	emit := func(l LogLine) error {
		got = append(got, l)
		return nil
	}
	for {
		_, err := src.ReadPayload(func(rid int, chunk []byte) error {
			var a *lineAssembler
			switch {
			case tty:
				a = comb
			case rid == streamIDStderr:
				a = errA
			default:
				a = out
			}
			return a.write(chunk, emit)
		})
		if err == io.EOF {
			for _, a := range []*lineAssembler{out, errA, comb} {
				a.flush(emit)
			}
			return got
		}
		if err != nil {
			t.Fatalf("ReadPayload: %v", err)
		}
	}
}

func TestLineAssemblerBasic(t *testing.T) {
	got := lines(t, bytes.NewReader(frame(streamIDStdout, []byte("a\nbb\n\ncc\n"))), false)
	want := []LogLine{
		{Stream: StreamStdout, Text: "a"},
		{Stream: StreamStdout, Text: "bb"},
		{Stream: StreamStdout, Text: ""},
		{Stream: StreamStdout, Text: "cc"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d lines, want %d: %#v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d = %#v, want %#v", i, got[i], want[i])
		}
	}
}

func TestLineAssemblerSplitUTF8AndNewlineAcrossFrames(t *testing.T) {
	// "hé" + LF, split mid-rune and mid-line over three frames.
	parts := [][]byte{[]byte("h\xc3"), []byte("\xa9\ntail")}
	body := bytes.Join([][]byte{frame(streamIDStdout, parts[0]), frame(streamIDStdout, parts[1])}, nil)
	got := lines(t, bytes.NewReader(body), false)
	if len(got) != 2 || got[0].Text != "hé" || got[1].Text != "tail" {
		t.Fatalf("got %#v", got)
	}
}

func TestLineAssemblerPerStreamInterleaving(t *testing.T) {
	body := bytes.Join([][]byte{
		frame(streamIDStdout, []byte("out1\n")),
		frame(streamIDStderr, []byte("err1\n")),
		frame(streamIDStdout, []byte("out2\n")),
	}, nil)
	got := lines(t, bytes.NewReader(body), false)
	want := []string{"out1", "err1", "out2"}
	if len(got) != len(want) {
		t.Fatalf("got %#v", got)
	}
	for i := range want {
		if got[i].Text != want[i] || got[i].Stream == "" {
			t.Fatalf("line %d = %#v", i, got[i])
		}
	}
	if got[0].Stream != StreamStdout || got[1].Stream != StreamStderr {
		t.Fatalf("streams wrong: %#v", got)
	}
}

func TestLineAssemblerTTYCombined(t *testing.T) {
	got := lines(t, bytes.NewReader([]byte("raw a\nraw b\n")), true)
	if len(got) != 2 {
		t.Fatalf("got %#v", got)
	}
	if got[0].Text != "raw a" || got[0].Stream != StreamCombined {
		t.Fatalf("tty line = %#v", got[0])
	}
}

func TestLineAssemblerInvalidUTF8Replacement(t *testing.T) {
	got := lines(t, bytes.NewReader(frame(streamIDStdout, []byte("ok\xff\xfebad\n"))), false)
	if len(got) != 1 {
		t.Fatalf("got %#v", got)
	}
	if !strings.Contains(got[0].Text, "\uFFFD") {
		t.Fatalf("expected U+FFFD replacement, got %q", got[0].Text)
	}
}

func TestLineAssemblerLongLineTruncatedOnce(t *testing.T) {
	line := strings.Repeat("a", MaxLineBytes+500)
	got := lines(t, bytes.NewReader(frame(streamIDStdout, []byte(line+"\nshort\n"))), false)
	if len(got) != 2 {
		t.Fatalf("got %d lines: %#v", len(got), got)
	}
	if !got[0].Truncated || len(got[0].Text) != MaxLineBytes {
		t.Fatalf("first line truncated=%v len=%d, want true/%d", got[0].Truncated, len(got[0].Text), MaxLineBytes)
	}
	if got[1].Truncated || got[1].Text != "short" {
		t.Fatalf("second line = %#v", got[1])
	}
}

func TestLineAssemblerTruncationUTF8Boundary(t *testing.T) {
	// 3-byte runes straddling the 4 KiB cut.
	line := strings.Repeat("世", MaxLineBytes)
	got := lines(t, bytes.NewReader(frame(streamIDStdout, []byte(line+"\nnext\n"))), false)
	if len(got) != 2 || !got[0].Truncated {
		t.Fatalf("got %#v", got)
	}
	if len(got[0].Text) > MaxLineBytes {
		t.Fatalf("truncated text len %d should be <= %d", len(got[0].Text), MaxLineBytes)
	}
	if !utf8ValidStr(got[0].Text) {
		t.Fatalf("truncated text is not valid UTF-8: %q", got[0].Text[:20])
	}
	if got[1].Text != "next" {
		t.Fatalf("drain failed: %#v", got[1])
	}
}

func TestLineAssemblerEOFFlushesPartial(t *testing.T) {
	got := lines(t, bytes.NewReader(frame(streamIDStdout, []byte("done\npartial"))), false)
	if len(got) != 2 || got[0].Text != "done" || got[1].Text != "partial" {
		t.Fatalf("got %#v", got)
	}
}

func TestLineAssemblerNoTrailingNewlineNoEmptyExtra(t *testing.T) {
	got := lines(t, bytes.NewReader(frame(streamIDStdout, []byte("one\n"))), false)
	if len(got) != 1 || got[0].Text != "one" {
		t.Fatalf("got %#v", got)
	}
}

func TestUtf8Boundary(t *testing.T) {
	b := []byte("ab世")
	if n := utf8Boundary(b); n != 3 {
		t.Fatalf("boundary = %d, want 3", n)
	}
	if n := utf8Boundary(b[:4]); n != 3 {
		t.Fatalf("split boundary = %d, want 3", n)
	}
	if n := utf8Boundary([]byte("abc")); n != 3 {
		t.Fatalf("ascii boundary = %d, want 3", n)
	}
	// 0xC3 is a LEAD byte (start of a 2-byte rune), so it is kept whole; a
	// truncated lead is repaired by toValidUTF8 as U+FFFD.
	if n := utf8Boundary([]byte("a\xc3")); n != 2 {
		t.Fatalf("lead byte boundary = %d, want 2", n)
	}
	if n := utf8Boundary([]byte("a\x80")); n != 1 {
		t.Fatalf("true continuation boundary = %d, want 1", n)
	}
	if n := utf8Boundary(nil); n != 0 {
		t.Fatalf("empty boundary = %d, want 0", n)
	}
}

func TestSinkErrorAbortsDecode(t *testing.T) {
	src := newDemuxReader(bytes.NewReader(frame(streamIDStdout, []byte("abcdef"))), 4)
	boom := io.ErrUnexpectedEOF
	calls := 0
	_, err := src.ReadPayload(func(int, []byte) error {
		calls++
		return boom
	})
	if err != boom {
		t.Fatalf("sink error not propagated: %v", err)
	}
	if calls != 1 {
		t.Fatalf("sink called %d times, want 1 (abort)", calls)
	}
}

func TestLineAssemblerRepairedInvalidBytesCappedAfterRepair(t *testing.T) {
	// 2000 invalid bytes repair to 6000 bytes of U+FFFD: the raw line fits
	// 4 KiB but the repaired form does not. The cap must apply AFTER
	// repair, so the line is reported truncated and bounded.
	flood := bytes.Repeat([]byte{0xFF}, 2000)
	payload := append(append([]byte(nil), flood...), '\n')
	payload = append(payload, []byte("next\n")...)
	got := lines(t, bytes.NewReader(frame(streamIDStdout, payload)), false)
	if len(got) != 2 {
		t.Fatalf("got %d lines: %#v", len(got), got)
	}
	first := got[0]
	if !first.Truncated {
		t.Fatalf("repaired over-cap line truncated=false, want true: %q", first.Text[:20])
	}
	if len(first.Text) > MaxLineBytes {
		t.Fatalf("repaired text len %d exceeds %d", len(first.Text), MaxLineBytes)
	}
	if !utf8.ValidString(first.Text) {
		t.Fatalf("repaired text is not valid UTF-8")
	}
	if got[1].Text != "next" || got[1].Truncated {
		t.Fatalf("next line not intact: %#v", got[1])
	}
}

func TestLineAssemblerLongInvalidLineTruncatedOnce(t *testing.T) {
	// Raw over-cap invalid flood: the cut is emitted exactly once, the
	// remainder is drained, and the next line survives intact.
	flood := bytes.Repeat([]byte{0xFF}, MaxLineBytes+500)
	payload := append(append([]byte(nil), flood...), '\n')
	payload = append(payload, []byte("short\n")...)
	got := lines(t, bytes.NewReader(frame(streamIDStdout, payload)), false)
	if len(got) != 2 {
		t.Fatalf("got %d lines: %#v", len(got), got)
	}
	if !got[0].Truncated || len(got[0].Text) > MaxLineBytes {
		t.Fatalf("first line truncated=%v len=%d, want true/<=%d", got[0].Truncated, len(got[0].Text), MaxLineBytes)
	}
	if !utf8.ValidString(got[0].Text) {
		t.Fatalf("truncated repaired text is not valid UTF-8")
	}
	if got[1].Truncated || got[1].Text != "short" {
		t.Fatalf("second line = %#v, want short", got[1])
	}
}

func TestLineAssemblerRepairedFlushCappedAtEOF(t *testing.T) {
	// Unterminated repaired over-cap tail at EOF is also bounded.
	flood := bytes.Repeat([]byte{0xFF}, 2000)
	got := lines(t, bytes.NewReader(frame(streamIDStdout, flood)), false)
	if len(got) != 1 {
		t.Fatalf("got %#v", got)
	}
	if !got[0].Truncated || len(got[0].Text) > MaxLineBytes {
		t.Fatalf("flush truncated=%v len=%d, want true/<=%d", got[0].Truncated, len(got[0].Text), MaxLineBytes)
	}
	if !utf8.ValidString(got[0].Text) {
		t.Fatalf("flush repaired text is not valid UTF-8")
	}
}

func utf8ValidStr(s string) bool {
	for _, r := range s {
		if r == '\uFFFD' {
			return false
		}
	}
	return true
}
