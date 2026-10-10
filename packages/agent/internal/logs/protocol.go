// Package logs defines the strict mirrored Docker realtime logs wire
// contract with packages/api/src/docker/docker-logs.schemas.ts.
//
// Fail-closed in both directions: neither side may accept a shape the
// other would reject. Every decoder uses DisallowUnknownFields plus a
// trailing-data check; identity fields never truncate or coerce.
//
// Endpoints (implemented in later steps, locked here):
//
//	GET /api/vps/:id/docker/management/logs/stream?agentInstanceId=&containerKey=
//	  Both query params REQUIRED; no tail/cursor/follow option.
//	  tailLines is always 200. Each valid HTTP connection creates one
//	  ephemeral subscription and is its only viewer.
//	SSE docker.logs.state:  {subscriptionId,status:"waiting"|"live"}
//	SSE docker.logs.lines:  {subscriptionId,lines:[{stream,text,truncated}]}
//	SSE docker.logs.closed: {subscriptionId,reason,errorCode?}
//	POST /api/agent/logs/claim {agentInstanceId}
//	POST /api/agent/logs/:subscriptionId/chunks {agentInstanceId,sequence,ready,lines}
//	POST /api/agent/logs/:subscriptionId/result {agentInstanceId,status,errorCode?}
//
// Reconnect is a new viewer: the buffer is cleared and the latest 200
// lines are fetched again; no replay across connections is promised.
package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// TailLines is the fixed viewer tail: last 200 lines, then live.
	TailLines = 200
	// MaxLinesPerBatch caps one docker.logs.lines frame / chunks batch.
	MaxLinesPerBatch = 100
	// MaxLineBytes caps one log line in UTF-8 bytes.
	MaxLineBytes = 4 * 1024
	// MaxFrameBytes caps a serialized lines frame (envelope included).
	MaxFrameBytes = 32 * 1024
	// MaxBodyBytes caps a serialized agent chunks body.
	MaxBodyBytes = 32 * 1024
)

const (
	// SSE event names carried in the SSE `event:` field (not in JSON).
	SSEState  = "docker.logs.state"
	SSELines  = "docker.logs.lines"
	SSEClosed = "docker.logs.closed"
)

const (
	StreamStdout   = "stdout"
	StreamStderr   = "stderr"
	StreamCombined = "combined"
)

const (
	StateWaiting = "waiting"
	StateLive    = "live"
)

const (
	CloseCompleted = "completed"
	CloseFailed    = "failed"
	CloseExpired   = "expired"
)

const (
	ResultCompleted = "completed"
	ResultFailed    = "failed"
)

const (
	ErrContainerNotFound = "container_not_found"
	ErrTargetMismatch    = "target_mismatch"
	ErrDaemonUnreachable = "daemon_unreachable"
	ErrLogsUnavailable   = "logs_unavailable"
	ErrInvalidStream     = "invalid_docker_stream"
	ErrAgentUnavailable  = "agent_unavailable"
	ErrStreamLost        = "stream_lost"
	ErrSlowConsumer      = "slow_consumer"
	ErrSessionExpired    = "session_expired"
)

var (
	logStreamAllowlist = map[string]bool{
		StreamStdout:   true,
		StreamStderr:   true,
		StreamCombined: true,
	}
	logStateAllowlist = map[string]bool{
		StateWaiting: true,
		StateLive:    true,
	}
	logCloseReasonAllowlist = map[string]bool{
		CloseCompleted: true,
		CloseFailed:    true,
		CloseExpired:   true,
	}
	logResultStatusAllowlist = map[string]bool{
		ResultCompleted: true,
		ResultFailed:    true,
	}
	logErrorAllowlist = map[string]bool{
		ErrContainerNotFound: true,
		ErrTargetMismatch:    true,
		ErrDaemonUnreachable: true,
		ErrLogsUnavailable:   true,
		ErrInvalidStream:     true,
		ErrAgentUnavailable:  true,
		ErrStreamLost:        true,
		ErrSlowConsumer:      true,
		ErrSessionExpired:    true,
	}
)

const (
	MaxInstanceIDLen     = 32
	MaxContainerKeyLen   = 32
	MaxSubscriptionIDLen = 64
	MaxVpsIDLen          = 64
	// MaxSequence mirrors JS Number.MAX_SAFE_INTEGER (TS number bounds).
	MaxSequence = int64(9007199254740991)
)

var safeIDPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

// LogLine is one SSE/chunks line. Text is a single line without trailing
// LF; empty lines are preserved. Combined is TTY-only.
type LogLine struct {
	Stream    string `json:"stream"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// StateEvent is the SSE docker.logs.state payload.
type StateEvent struct {
	SubscriptionID string `json:"subscriptionId"`
	Status         string `json:"status"`
}

// LinesEvent is the SSE docker.logs.lines payload.
type LinesEvent struct {
	SubscriptionID string    `json:"subscriptionId"`
	Lines          []LogLine `json:"lines"`
}

// ClosedEvent is the terminal SSE docker.logs.closed payload.
type ClosedEvent struct {
	SubscriptionID string  `json:"subscriptionId"`
	Reason         string  `json:"reason"`
	ErrorCode      *string `json:"errorCode,omitempty"`
}

// ClaimRequest is POST /api/agent/logs/claim body.
type ClaimRequest struct {
	AgentInstanceID string `json:"agentInstanceId"`
}

// ClaimedSubscription is the claimed viewer subscription. TailLines is
// always 200; ExpiresAt is RFC3339 with offset.
type ClaimedSubscription struct {
	SubscriptionID  string `json:"subscriptionId"`
	VpsID           string `json:"vpsId"`
	AgentInstanceID string `json:"agentInstanceId"`
	ContainerKey    string `json:"containerKey"`
	TailLines       int    `json:"tailLines"`
	ExpiresAt       string `json:"expiresAt"`
}

// ClaimResponseData carries the claim answer payload.
type ClaimResponseData struct {
	Subscription *ClaimedSubscription `json:"subscription"`
}

// ClaimResponse is POST /api/agent/logs/claim answer. Subscription is
// nil for JSON null (no viewer waiting); the key itself must be present.
type ClaimResponse struct {
	Data ClaimResponseData `json:"data"`
}

// ChunksRequest is POST /api/agent/logs/:subscriptionId/chunks body.
// Sequence starts at 1 and increments by one per batch/heartbeat.
// Ready is true from the first request after the Docker log HTTP returns
// 2xx and stays true. Empty Lines is a heartbeat.
type ChunksRequest struct {
	AgentInstanceID string    `json:"agentInstanceId"`
	Sequence        int64     `json:"sequence"`
	Ready           bool      `json:"ready"`
	Lines           []LogLine `json:"lines"`
}

// ChunksResponseData is the chunks acknowledgement payload.
type ChunksResponseData struct {
	OK             bool   `json:"ok"`
	SubscriptionID string `json:"subscriptionId"`
	Sequence       int64  `json:"sequence"`
}

// ChunksResponse is the chunks acknowledgement echo.
type ChunksResponse struct {
	Data ChunksResponseData `json:"data"`
}

// ResultRequest is POST /api/agent/logs/:subscriptionId/result body.
// Completed only on clean Docker EOF; Failed carries a safe code, never a
// daemon error body.
type ResultRequest struct {
	AgentInstanceID string  `json:"agentInstanceId"`
	Status          string  `json:"status"`
	ErrorCode       *string `json:"errorCode,omitempty"`
}

// ResultResponseData is the result acknowledgement payload.
type ResultResponseData struct {
	OK              bool   `json:"ok"`
	SubscriptionID  string `json:"subscriptionId"`
	AgentInstanceID string `json:"agentInstanceId"`
}

// ResultResponse is the result acknowledgement echo.
type ResultResponse struct {
	Data ResultResponseData `json:"data"`
}

func validOpaqueID(s string, max int) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	return safeIDPattern.MatchString(s)
}

// ValidateStreamQuery validates GET stream query params. Both are REQUIRED;
// there is no tail/cursor/follow option.
func ValidateStreamQuery(agentInstanceID, containerKey string) error {
	if !validOpaqueID(agentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if !validOpaqueID(containerKey, MaxContainerKeyLen) {
		return fmt.Errorf("bad containerKey")
	}
	return nil
}

func validateLogLine(l LogLine) error {
	if !logStreamAllowlist[l.Stream] {
		return fmt.Errorf("unapproved log stream")
	}
	if len(l.Text) > MaxLineBytes {
		return fmt.Errorf("log line oversize")
	}
	if !utf8.ValidString(l.Text) {
		return fmt.Errorf("log line not valid UTF-8")
	}
	// U+FFFD is NOT rejected here: the agent legitimately substitutes it
	// for invalid Docker bytes. Lone UTF-16 surrogates are caught on the
	// raw JSON in validateRawLogLine, which is the only place they are
	// still distinguishable after decoding.
	if strings.Contains(l.Text, "\n") {
		return fmt.Errorf("log line must not contain LF")
	}
	return nil
}

// parseHexQuad decodes four hex digits, or returns -1.
func parseHexQuad(b []byte) int {
	n := 0
	for _, c := range b {
		n <<= 4
		switch {
		case c >= '0' && c <= '9':
			n |= int(c - '0')
		case c >= 'a' && c <= 'f':
			n |= int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			n |= int(c-'A') + 10
		default:
			return -1
		}
	}
	return n
}

// hasLoneSurrogateEscape reports whether raw JSON carries a `\uXXXX`
// escape in the UTF-16 surrogate range that is not part of a valid
// high+low pair. `encoding/json` collapses a valid pair into one code
// point and decodes a lone escape to U+FFFD, so the raw escapes are the
// only way to tell the case the TS mirror rejects from the replacement
// character the agent legitimately emits for invalid Docker bytes.
func hasLoneSurrogateEscape(raw []byte) bool {
	for i := 0; i+6 <= len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		// Skil an escaped backslash so `"\\ud800"` stays literal text.
		if raw[i+1] == '\\' {
			i++
			continue
		}
		if raw[i+1] != 'u' {
			continue
		}
		cp := parseHexQuad(raw[i+2 : i+6])
		if cp < 0xD800 || cp > 0xDFFF {
			continue
		}
		if cp <= 0xDBFF {
			// High surrogate: must be followed by a low surrogate escape.
			if i+12 > len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
				return true
			}
			if lo := parseHexQuad(raw[i+8 : i+12]); lo < 0xDC00 || lo > 0xDFFF {
				return true
			}
			i += 11
			continue
		}
		// Low surrogate: must be preceded by a high surrogate escape.
		if i < 12 || raw[i-6] != '\\' || raw[i-5] != 'u' {
			return true
		}
		if hi := parseHexQuad(raw[i-4 : i]); hi < 0xD800 || hi > 0xDBFF {
			return true
		}
	}
	return false
}

// validateRawLogLine enforces the nested per-line shape that Go's struct
// decode cannot: `json.Decoder` fills zero values for a missing field and
// accepts JSON null for string/bool fields, so `{"stream":"stdout"}` would
// otherwise pass as an empty, non-truncated line. `raw` is the line's raw
// JSON object, which pins the same rule TS enforces with `.strict()`.
func validateRawLogLine(raw json.RawMessage) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("log line malformed: %w", err)
	}
	text, ok := m["text"]
	if !ok {
		return fmt.Errorf("log line missing required field \"text\"")
	}
	if string(text) == "null" {
		return fmt.Errorf("log line text must not be null")
	}
	truncated, ok := m["truncated"]
	if !ok {
		return fmt.Errorf("log line missing required field \"truncated\"")
	}
	if string(truncated) == "null" {
		return fmt.Errorf("log line truncated must not be null")
	}
	stream, ok := m["stream"]
	if !ok {
		return fmt.Errorf("log line missing required field \"stream\"")
	}
	if string(stream) == "null" {
		return fmt.Errorf("log line stream must not be null")
	}
	// Lone UTF-16 surrogate escapes are only detectable in the raw JSON:
	// encoding/json decodes them to U+FFFD, which is valid UTF-8 here.
	if hasLoneSurrogateEscape(raw) {
		return fmt.Errorf("log line contains lone UTF-16 surrogate")
	}
	// Strict, like the TS mirror's `.strict()` on each line object: an
	// unknown key is a contract break, not something to ignore.
	for k := range m {
		if k != "stream" && k != "text" && k != "truncated" {
			return fmt.Errorf("log line has unknown field %q", k)
		}
	}
	return nil
}

// validateRawLogLines walks the raw JSON lines array of a lines event or
// chunks request, enforcing nested required fields, the 100-line cap and
// strict (no unknown key) decoding per line.
func validateRawLogLines(rawLines json.RawMessage) error {
	if string(rawLines) == "null" {
		return fmt.Errorf("lines must be an array, not null")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(rawLines, &items); err != nil {
		return fmt.Errorf("lines malformed: %w", err)
	}
	if len(items) > MaxLinesPerBatch {
		return fmt.Errorf("log line batch overflow")
	}
	for _, item := range items {
		if err := validateRawLogLine(item); err != nil {
			return err
		}
	}
	return nil
}

func validateLogLines(lines []LogLine) error {
	if lines == nil {
		return fmt.Errorf("lines branch must be an array, not null")
	}
	if len(lines) > MaxLinesPerBatch {
		return fmt.Errorf("log line batch overflow")
	}
	for _, l := range lines {
		if err := validateLogLine(l); err != nil {
			return err
		}
	}
	return nil
}

// MarshalJSON is the single OUTGOING representation for every logs
// payload. HTML escaping is disabled to match the TS mirror's
// JSON.stringify, so ordinary `<`, `>` and `&` in log text survive
// unescaped instead of becoming `\u003c`.
//
// Size budgeting and the bytes actually sent MUST both go through this
// helper: that is what keeps them identical. `json.Marshal` cannot disable
// HTML escaping, so an Encoder is used and its trailing newline trimmed —
// the returned bytes are exactly what goes on the wire, with no newline.
//
// Never apply it to incoming frames: those are validated on their raw
// length, because re-serialising would re-escape `<`, `>` and `&` and
// inflate a frame that had already arrived.
func MarshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	b := buf.Bytes()
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
	}
	return b, nil
}

// SerializedOutgoingBytes measures the exact bytes the outgoing body will
// occupy, using the same helper that produces those bytes.
func SerializedOutgoingBytes(v any) int {
	b, err := MarshalJSON(v)
	if err != nil {
		return MaxFrameBytes + 1
	}
	return len(b)
}

// serializedSize is kept for existing call sites in this package.
func serializedSize(v any) int { return SerializedOutgoingBytes(v) }

// ValidateStateEvent enforces strict state shape.
func ValidateStateEvent(e StateEvent) error {
	if !validOpaqueID(e.SubscriptionID, MaxSubscriptionIDLen) {
		return fmt.Errorf("bad subscriptionId")
	}
	if !logStateAllowlist[e.Status] {
		return fmt.Errorf("unapproved log state")
	}
	return nil
}

// ValidateLinesEvent enforces strict lines shape plus the 32 KiB cap on
// the bytes actually received (not a re-serialisation, which would
// HTML-escape `<`, `>` and `&` and inflate a valid frame).
func ValidateLinesEvent(e LinesEvent, receivedBytes int) error {
	if !validOpaqueID(e.SubscriptionID, MaxSubscriptionIDLen) {
		return fmt.Errorf("bad subscriptionId")
	}
	if err := validateLogLines(e.Lines); err != nil {
		return err
	}
	if receivedBytes < 0 || receivedBytes > MaxFrameBytes {
		return fmt.Errorf("log lines frame oversize")
	}
	return nil
}

// ValidateClosedEvent enforces strict closed shape.
func ValidateClosedEvent(e ClosedEvent) error {
	if !validOpaqueID(e.SubscriptionID, MaxSubscriptionIDLen) {
		return fmt.Errorf("bad subscriptionId")
	}
	if !logCloseReasonAllowlist[e.Reason] {
		return fmt.Errorf("unapproved close reason")
	}
	if e.ErrorCode != nil && !logErrorAllowlist[*e.ErrorCode] {
		return fmt.Errorf("unapproved log error code")
	}
	return nil
}

// ValidateClaimRequest enforces strict claim shape.
func ValidateClaimRequest(r ClaimRequest) error {
	if !validOpaqueID(r.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	return nil
}

// ValidateClaimedSubscription enforces the claimed subscription shape.
func ValidateClaimedSubscription(s ClaimedSubscription) error {
	if !validOpaqueID(s.SubscriptionID, MaxSubscriptionIDLen) {
		return fmt.Errorf("bad subscriptionId")
	}
	if !validOpaqueID(s.VpsID, MaxVpsIDLen) {
		return fmt.Errorf("bad vpsId")
	}
	if !validOpaqueID(s.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if !validOpaqueID(s.ContainerKey, MaxContainerKeyLen) {
		return fmt.Errorf("bad containerKey")
	}
	if s.TailLines != TailLines {
		return fmt.Errorf("tailLines must be %d", TailLines)
	}
	if _, err := time.Parse(time.RFC3339, s.ExpiresAt); err != nil {
		return fmt.Errorf("bad expiresAt: %w", err)
	}
	return nil
}

// ValidateClaimResponse enforces the claim answer shape.
func ValidateClaimResponse(r ClaimResponse) error {
	if r.Data.Subscription != nil {
		return ValidateClaimedSubscription(*r.Data.Subscription)
	}
	return nil
}

// ValidateChunksRequest enforces strict chunks shape plus the 32 KiB cap on
// the bytes actually received (not a re-serialisation, which would
// HTML-escape `<`, `>` and `&` and inflate a valid batch). Only the next
// sequence is accepted (service 409); sequence continuity itself is
// enforced by the broker, not here.
func ValidateChunksRequest(r ChunksRequest, receivedBytes int) error {
	if !validOpaqueID(r.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if r.Sequence < 1 || r.Sequence > MaxSequence {
		return fmt.Errorf("sequence out of range")
	}
	if err := validateLogLines(r.Lines); err != nil {
		return err
	}
	if receivedBytes < 0 || receivedBytes > MaxBodyBytes {
		return fmt.Errorf("log chunks body oversize")
	}
	return nil
}

// ValidateChunksResponse enforces the chunks acknowledgement echo.
func ValidateChunksResponse(r ChunksResponse) error {
	if !r.Data.OK {
		return fmt.Errorf("chunks not acknowledged")
	}
	if !validOpaqueID(r.Data.SubscriptionID, MaxSubscriptionIDLen) {
		return fmt.Errorf("bad subscriptionId")
	}
	if r.Data.Sequence < 1 || r.Data.Sequence > MaxSequence {
		return fmt.Errorf("sequence out of range")
	}
	return nil
}

// ValidateResultRequest enforces strict result shape.
func ValidateResultRequest(r ResultRequest) error {
	if !validOpaqueID(r.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	if !logResultStatusAllowlist[r.Status] {
		return fmt.Errorf("unapproved result status")
	}
	if r.ErrorCode != nil && !logErrorAllowlist[*r.ErrorCode] {
		return fmt.Errorf("unapproved log error code")
	}
	return nil
}

// ValidateResultResponse enforces the result acknowledgement echo.
func ValidateResultResponse(r ResultResponse) error {
	if !r.Data.OK {
		return fmt.Errorf("result not acknowledged")
	}
	if !validOpaqueID(r.Data.SubscriptionID, MaxSubscriptionIDLen) {
		return fmt.Errorf("bad subscriptionId")
	}
	if !validOpaqueID(r.Data.AgentInstanceID, MaxInstanceIDLen) {
		return fmt.Errorf("bad agentInstanceId")
	}
	return nil
}

func decodeStrict(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return fmt.Errorf("logs: trailing data: fail closed")
	}
	return nil
}

func requireKeys(b []byte, keys ...string) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	for _, k := range keys {
		raw, ok := m[k]
		if !ok {
			return fmt.Errorf("logs: missing required field %q", k)
		}
		_ = raw
	}
	return nil
}

// DecodeStateEvent strictly decodes one state frame.
func DecodeStateEvent(b []byte) (StateEvent, error) {
	var e StateEvent
	if err := requireKeys(b, "subscriptionId", "status"); err != nil {
		return e, err
	}
	if err := decodeStrict(b, &e); err != nil {
		return e, fmt.Errorf("logs: state malformed: %w", err)
	}
	if err := ValidateStateEvent(e); err != nil {
		return e, err
	}
	return e, nil
}

// DecodeLinesEvent strictly decodes one lines frame.
func DecodeLinesEvent(b []byte) (LinesEvent, error) {
	var e LinesEvent
	if err := requireKeys(b, "subscriptionId", "lines"); err != nil {
		return e, err
	}
	if err := decodeStrict(b, &e); err != nil {
		return e, fmt.Errorf("logs: lines malformed: %w", err)
	}
	// Nested required/non-null checks need the raw array: struct decoding
	// would otherwise fill zero values for missing or null line fields.
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(b, &outer); err != nil {
		return e, fmt.Errorf("logs: lines malformed: %w", err)
	}
	if err := validateRawLogLines(outer["lines"]); err != nil {
		return e, err
	}
	if err := ValidateLinesEvent(e, len(b)); err != nil {
		return e, err
	}
	return e, nil
}

// DecodeClosedEvent strictly decodes the terminal closed frame.
func DecodeClosedEvent(b []byte) (ClosedEvent, error) {
	var e ClosedEvent
	if err := requireKeys(b, "subscriptionId", "reason"); err != nil {
		return e, err
	}
	if err := decodeStrict(b, &e); err != nil {
		return e, fmt.Errorf("logs: closed malformed: %w", err)
	}
	if e.ErrorCode != nil && *e.ErrorCode == "" {
		return e, fmt.Errorf("empty log error code")
	}
	if err := ValidateClosedEvent(e); err != nil {
		return e, err
	}
	return e, nil
}

// DecodeClaimRequest strictly decodes a claim body.
func DecodeClaimRequest(b []byte) (ClaimRequest, error) {
	var r ClaimRequest
	if err := requireKeys(b, "agentInstanceId"); err != nil {
		return r, err
	}
	if err := decodeStrict(b, &r); err != nil {
		return r, fmt.Errorf("logs: claim malformed: %w", err)
	}
	if err := ValidateClaimRequest(r); err != nil {
		return r, err
	}
	return r, nil
}

// DecodeClaimResponse strictly decodes a claim answer, requiring the
// data.subscription key (null allowed, missing rejected).
func DecodeClaimResponse(b []byte) (ClaimResponse, error) {
	var r ClaimResponse
	if err := requireKeys(b, "data"); err != nil {
		return r, err
	}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(b, &outer); err != nil {
		return r, fmt.Errorf("logs: claim response malformed: %w", err)
	}
	var inner map[string]json.RawMessage
	if err := json.Unmarshal(outer["data"], &inner); err != nil {
		return r, fmt.Errorf("logs: claim response malformed: %w", err)
	}
	if _, ok := inner["subscription"]; !ok {
		return r, fmt.Errorf("logs: missing required field \"subscription\"")
	}
	if err := decodeStrict(b, &r); err != nil {
		return r, fmt.Errorf("logs: claim response malformed: %w", err)
	}
	if err := ValidateClaimResponse(r); err != nil {
		return r, err
	}
	return r, nil
}

// DecodeChunksRequest strictly decodes one chunks batch/heartbeat.
func DecodeChunksRequest(b []byte) (ChunksRequest, error) {
	var r ChunksRequest
	if err := requireKeys(b, "agentInstanceId", "sequence", "ready", "lines"); err != nil {
		return r, err
	}
	if err := decodeStrict(b, &r); err != nil {
		return r, fmt.Errorf("logs: chunks malformed: %w", err)
	}
	// Nested required/non-null checks need the raw array: struct decoding
	// would otherwise fill zero values for missing or null line fields.
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(b, &outer); err != nil {
		return r, fmt.Errorf("logs: chunks malformed: %w", err)
	}
	if err := validateRawLogLines(outer["lines"]); err != nil {
		return r, err
	}
	if err := ValidateChunksRequest(r, len(b)); err != nil {
		return r, err
	}
	return r, nil
}

// DecodeChunksResponse strictly decodes a chunks acknowledgement.
func DecodeChunksResponse(b []byte) (ChunksResponse, error) {
	var r ChunksResponse
	if err := requireKeys(b, "data"); err != nil {
		return r, err
	}
	if err := decodeStrict(b, &r); err != nil {
		return r, fmt.Errorf("logs: chunks response malformed: %w", err)
	}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(b, &outer); err != nil {
		return r, fmt.Errorf("logs: chunks response malformed: %w", err)
	}
	var inner map[string]json.RawMessage
	if err := json.Unmarshal(outer["data"], &inner); err != nil {
		return r, fmt.Errorf("logs: chunks response malformed: %w", err)
	}
	for _, k := range []string{"ok", "subscriptionId", "sequence"} {
		if _, ok := inner[k]; !ok {
			return r, fmt.Errorf("logs: missing required field %q", k)
		}
	}
	if err := ValidateChunksResponse(r); err != nil {
		return r, err
	}
	return r, nil
}

// DecodeResultRequest strictly decodes one terminal result.
func DecodeResultRequest(b []byte) (ResultRequest, error) {
	var r ResultRequest
	if err := requireKeys(b, "agentInstanceId", "status"); err != nil {
		return r, err
	}
	if err := decodeStrict(b, &r); err != nil {
		return r, fmt.Errorf("logs: result malformed: %w", err)
	}
	if r.ErrorCode != nil && *r.ErrorCode == "" {
		return r, fmt.Errorf("empty log error code")
	}
	if err := ValidateResultRequest(r); err != nil {
		return r, err
	}
	return r, nil
}

// DecodeResultResponse strictly decodes a result acknowledgement.
func DecodeResultResponse(b []byte) (ResultResponse, error) {
	var r ResultResponse
	if err := requireKeys(b, "data"); err != nil {
		return r, err
	}
	if err := decodeStrict(b, &r); err != nil {
		return r, fmt.Errorf("logs: result response malformed: %w", err)
	}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(b, &outer); err != nil {
		return r, fmt.Errorf("logs: result response malformed: %w", err)
	}
	var inner map[string]json.RawMessage
	if err := json.Unmarshal(outer["data"], &inner); err != nil {
		return r, fmt.Errorf("logs: result response malformed: %w", err)
	}
	for _, k := range []string{"ok", "subscriptionId", "agentInstanceId"} {
		if _, ok := inner[k]; !ok {
			return r, fmt.Errorf("logs: missing required field %q", k)
		}
	}
	if err := ValidateResultResponse(r); err != nil {
		return r, err
	}
	return r, nil
}
