package logs

import (
	"encoding/binary"
	"errors"
	"io"
	"unicode/utf8"
)

// Docker stream framing, decoded incrementally.
//
// When tty is false the daemon multiplexes stdout/stderr: an 8-byte header
// [stream(1) 0 0 0 size(4 BE)] precedes each payload. Frames straddle
// network reads exactly as often as the network decides, so the decoder
// reassembles them with io.ReadFull instead of assuming one frame per read.
//
// When tty is true the body is raw and carries a single "combined" stream.
//
// The one-shot preview decoder in internal/commands is deliberately NOT
// reused: it is bounded, heuristically falls back to raw passthrough when a
// header looks absent, and would leak headers or drop data once frames
// straddle reads. This decoder has no raw fallback: malformed framing is
// invalid_docker_stream and the subscription fails.
const (
	frameHeaderSize = 8
	streamIDStdout  = 1
	streamIDStderr  = 2
)

// ErrInvalidFrame reports malformed/oversized framing. It exists to carry
// the ErrInvalidStream code; a raw fallback is never possible.
var ErrInvalidFrame = errors.New("logs: " + ErrInvalidStream)

// frameSink receives the bounded chunks of one payload, in order. The chunk
// slice aliases the reader's reused buffer and is only valid for the call,
// so a consumer that retains it must copy first.
type frameSink func(stream int, chunk []byte) error

// payloadReader yields successive Docker payloads with their stream type.
type payloadReader interface {
	// ReadPayload feeds the chunks of the next payload to sink and returns
	// its stream id, or io.EOF at a clean end of stream. A sink error aborts
	// the read immediately.
	ReadPayload(sink frameSink) (stream int, err error)
}

// demuxReader decodes the multiplexed (tty=false) form incrementally.
type demuxReader struct {
	r          io.Reader
	payloadBuf []byte
}

func newDemuxReader(r io.Reader, bufSize int) *demuxReader {
	if bufSize <= 0 {
		bufSize = dockerPayloadBufferSize
	}
	return &demuxReader{r: r, payloadBuf: make([]byte, bufSize)}
}

func (d *demuxReader) ReadPayload(sink frameSink) (int, error) {
	var hdr [frameHeaderSize]byte
	if _, err := io.ReadFull(d.r, hdr[:]); err != nil {
		if err == io.EOF {
			// Clean EOF exactly at a frame boundary.
			return 0, io.EOF
		}
		if err == io.ErrUnexpectedEOF {
			// Truncated header: malformed, fail closed.
			return 0, ErrInvalidFrame
		}
		return 0, err
	}
	stream := int(hdr[0])
	if stream != streamIDStdout && stream != streamIDStderr {
		return 0, ErrInvalidFrame
	}
	if hdr[1] != 0 || hdr[2] != 0 || hdr[3] != 0 {
		return 0, ErrInvalidFrame
	}
	size := int64(binary.BigEndian.Uint32(hdr[4:8]))
	if size < 0 || size > int64(dockerMaxFrameBytes) {
		return 0, ErrInvalidFrame
	}
	if size == 0 {
		return stream, nil
	}
	// The payload is consumed in bounded chunks through the reused buffer:
	// allocation tracks the configured buffer, never the daemon-declared
	// frame length (which could be up to 16 MiB).
	for remaining := size; remaining > 0; {
		chunk := int64(len(d.payloadBuf))
		if remaining < chunk {
			chunk = remaining
		}
		n, err := io.ReadFull(d.r, d.payloadBuf[:chunk])
		if n > 0 {
			if serr := sink(stream, d.payloadBuf[:n]); serr != nil {
				return stream, serr
			}
		}
		if err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				// Truncated payload: malformed, fail closed.
				return stream, ErrInvalidFrame
			}
			return stream, err
		}
		remaining -= int64(n)
	}
	return stream, nil
}

// rawReader passes the (tty=true) body through as one "combined" stream,
// bounded by the same reused read buffer.
type rawReader struct {
	r   io.Reader
	buf []byte
}

func newRawReader(r io.Reader, bufSize int) *rawReader {
	if bufSize <= 0 {
		bufSize = dockerPayloadBufferSize
	}
	return &rawReader{r: r, buf: make([]byte, bufSize)}
}

func (d *rawReader) ReadPayload(sink frameSink) (int, error) {
	n, err := d.r.Read(d.buf)
	if n > 0 {
		if serr := sink(0, d.buf[:n]); serr != nil {
			return 0, serr
		}
	}
	if err != nil {
		return 0, err
	}
	// (0, nil) is legal for a stream; report it as an empty payload so the
	// caller's loop never spins on a busy read.
	return 0, nil
}

// newPayloadReader selects the framing for this container.
func newPayloadReader(r io.Reader, tty bool, bufSize int) payloadReader {
	if tty {
		return newRawReader(r, bufSize)
	}
	return newDemuxReader(r, bufSize)
}

// lineAssembler turns payload bytes into lines, preserving UTF-8 across
// read and frame boundaries, empty lines, and per-stream interleaving.
//
// Each stream gets its own assembler (a TTY container has exactly one), so
// a partial stdout line can never be stitched onto a stderr fragment. A
// line is emitted only when its LF arrives, or at EOF for the final
// unterminated line — never once per frame or per network read.
type lineAssembler struct {
	stream string
	// pending holds the current (unterminated) line, capped at MaxLineBytes.
	pending []byte
	// draining is true after a line hit the 4 KiB cut: further bytes are
	// discarded until the LF so the cut is reported exactly once.
	draining bool
}

func newLineAssembler(stream string) *lineAssembler {
	return &lineAssembler{stream: stream}
}

// write appends payload bytes, emitting every line they complete through
// emit. No complete line means no callback. A callback error aborts the
// walk immediately and is returned.
func (a *lineAssembler) write(p []byte, emit func(LogLine) error) error {
	for _, b := range p {
		// Once a line was cut at the cap, everything up to the newline is
		// drained: the bytes are discarded, the line is not re-reported.
		if a.draining {
			if b == '\n' {
				a.draining = false
				a.pending = a.pending[:0]
			}
			continue
		}
		if b == '\n' {
			if err := a.terminate(emit); err != nil {
				return err
			}
			continue
		}
		// A line may never be emitted longer than MaxLineBytes *including*
		// a partial rune, so stop appending before the byte would split a
		// multi-byte rune that started inside the limit.
		if len(a.pending) >= maxPendingBytes(a.pending) {
			if err := a.emitTruncated(emit); err != nil {
				return err
			}
			continue
		}
		a.pending = append(a.pending, b)
	}
	return nil
}

// terminate completes the current line. An empty pending buffer is a real
// (empty) line and is preserved. The 4 KiB cap is enforced AFTER invalid
// bytes are repaired to U+FFFD: a line whose repaired form exceeds the cap
// is reported truncated (the LF already arrived, so no drain follows).
func (a *lineAssembler) terminate(emit func(LogLine) error) error {
	if a.draining {
		// The cut line was already reported when it hit 4 KiB.
		a.draining = false
		a.pending = a.pending[:0]
		return nil
	}
	text := toValidUTF8(a.pending)
	truncated := false
	if len(text) > MaxLineBytes {
		text = truncateToCap(text)
		truncated = true
	}
	err := emit(LogLine{Stream: a.stream, Text: text, Truncated: truncated})
	a.pending = a.pending[:0]
	return err
}

// emitTruncated cuts the accumulated line at a UTF-8 boundary and reports
// it with truncated=true exactly once; subsequent bytes are drained. The
// reported text is always <= MaxLineBytes and never ends mid-rune. The cap
// is enforced AFTER invalid bytes are repaired to U+FFFD.
func (a *lineAssembler) emitTruncated(emit func(LogLine) error) error {
	// Hard invariant: the reported text never exceeds MaxLineBytes, even
	// after invalid bytes are repaired to U+FFFD (which is itself 3 bytes).
	// A lone trailing rune lead is therefore dropped from the cut instead
	// of being replaced, because replacing it would grow the line.
	limit := len(a.pending)
	if limit > MaxLineBytes {
		limit = MaxLineBytes
	}
	cut := utf8Boundary(a.pending[:limit])
	// The byte at the cut may open a rune whose continuation bytes were
	// never seen; repairing them would add up to 3 bytes and break the cap.
	if cut > 0 {
		lead := a.pending[cut-1]
		if lead&0x80 != 0 && lead&0xC0 != 0x80 {
			size := utf8.RuneLen(rune(lead))
			if size > 1 && !utf8.Valid(a.pending[cut-1:]) {
				cut--
			}
		}
	}
	text := toValidUTF8(a.pending[:cut])
	if len(text) > MaxLineBytes {
		text = truncateToCap(text)
	}
	err := emit(LogLine{Stream: a.stream, Text: text, Truncated: true})
	a.pending = a.pending[:0]
	a.draining = true
	return err
}

// flush emits the final unterminated line at EOF. A line that was already
// truncated emits nothing more. The cap is enforced AFTER repair, so an
// over-cap repaired tail is reported truncated.
func (a *lineAssembler) flush(emit func(LogLine) error) error {
	if a.draining {
		a.draining = false
		a.pending = a.pending[:0]
		return nil
	}
	if len(a.pending) == 0 {
		return nil
	}
	text := toValidUTF8(a.pending)
	truncated := false
	if len(text) > MaxLineBytes {
		text = truncateToCap(text)
		truncated = true
	}
	err := emit(LogLine{Stream: a.stream, Text: text, Truncated: truncated})
	a.pending = a.pending[:0]
	return err
}

// truncateToCap cuts valid UTF-8 text to <= MaxLineBytes without splitting
// a rune. toValidUTF8 output is always valid, so backing off at most
// utf8.UTFMax bytes suffices; the result stays valid and bounded.
func truncateToCap(s string) string {
	if len(s) <= MaxLineBytes {
		return s
	}
	cut := MaxLineBytes
	for cut > 0 && !utf8.ValidString(s[:cut]) {
		cut--
	}
	return s[:cut]
}

// maxPendingBytes is the effective cap for the current line: MaxLineBytes,
// reduced so that appending the next byte of an in-progress multi-byte rune
// cannot push the line past the limit mid-rune. A single-byte or already
// complete rune at the limit keeps the full limit.
func maxPendingBytes(pending []byte) int {
	limit := MaxLineBytes
	if len(pending) < limit {
		// The byte being appended always fits; the cap cannot bind yet.
		return limit
	}
	// pending is exactly at the limit: the byte we are about to append must
	// not split the rune that would start at index limit. Look at the byte
	// at limit-1: if it opens a multi-byte rune, its continuation bytes
	// would exceed the cap, so the line must be cut first.
	last := pending[limit-1]
	if last&0x80 == 0 {
		return limit
	}
	if last&0xC0 == 0x80 {
		// A continuation byte: find this rune's start.
		start := limit - 1
		for start > 0 && pending[start]&0xC0 == 0x80 {
			start--
		}
		if start >= limit-utf8.UTFMax {
			r := rune(pending[start])
			if size := utf8.RuneLen(r); start+size <= limit {
				return limit
			}
		}
		return start
	}
	// Multi-byte rune start at limit-1: it cannot fit within the limit.
	return limit - 1
}

// utf8Boundary returns the largest length <= len(p) that does not split a
// multi-byte rune.
func utf8Boundary(p []byte) int {
	n := len(p)
	if n == 0 {
		return 0
	}
	// Walk back over continuation bytes to the byte that opened the last
	// rune; that byte stays in the cut, its continuations do not.
	for n > 0 && p[n-1]&0xC0 == 0x80 {
		n--
	}
	if n == 0 {
		// The whole buffer was continuation bytes: nothing is cuttable.
		return 0
	}
	return n
}

// toValidUTF8 decodes bytes as UTF-8, replacing invalid sequences with
// U+FFFD so split runes never reach the viewer as mojibake.
func toValidUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	out := make([]byte, 0, len(b)+utf8.UTFMax)
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size <= 1 {
			out = append(out, "\uFFFD"...)
			i++
			continue
		}
		out = append(out, b[i:i+size]...)
		i += size
	}
	return string(out)
}
