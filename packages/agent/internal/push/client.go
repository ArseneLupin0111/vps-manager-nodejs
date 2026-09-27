package push

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/vps-manager/agent/internal/config"
	"github.com/vps-manager/agent/internal/metrics"
	"github.com/vps-manager/agent/internal/version"
)

// ErrAuth indicates a fatal authentication failure (401/403).
type ErrAuth struct {
	StatusCode int
	Body       string
}

func (e *ErrAuth) Error() string {
	return fmt.Sprintf("authentication failed (HTTP %d)", e.StatusCode)
}

// ErrFatal indicates a non-retryable fatal error (400, 404, etc.).
type ErrFatal struct {
	StatusCode int
	Body       string
}

func (e *ErrFatal) Error() string {
	return fmt.Sprintf("fatal error (HTTP %d)", e.StatusCode)
}

// ErrConflict indicates a 409 CAS/identity conflict. It is non-fatal and
// must not be blindly retried; pending-batch semantics are the Runner's job.
// Body is sanitized and bounded.
type ErrConflict struct {
	StatusCode int
	Body       string
}

func (e *ErrConflict) Error() string {
	return fmt.Sprintf("conflict (HTTP %d)", e.StatusCode)
}

// ErrRetryable indicates a transient failure that may be retried.
type ErrRetryable struct {
	StatusCode int
	Err        error
}

func (e *ErrRetryable) Error() string {
	return fmt.Sprintf("retryable error (HTTP %d): %v", e.StatusCode, e.Err)
}

func (e *ErrRetryable) Unwrap() error { return e.Err }

// ConfigResponse carries runtime configuration returned by the server
// after a successful metrics push. DockerMetricsEnabled is required;
// Docker capability fields are optional and omitted by old servers.
type ConfigResponse struct {
	DockerMetricsEnabled bool  `json:"dockerMetricsEnabled"`
	History              *bool `json:"history,omitempty"`
	ContainerHistory     *bool `json:"containerHistory,omitempty"`
	Events               *bool `json:"events,omitempty"`
	Storage              *bool `json:"storage,omitempty"`
}

// Watermark is the durable event watermark committed by the server.
type Watermark struct {
	TimeNano        string   `json:"timeNano"`
	BoundaryDigests []string `json:"boundaryDigests"`
}

// DockerAck is the typed Docker ingest acknowledgement.
type DockerAck struct {
	IngestStatus       string    `json:"ingestStatus"`
	BatchId            string    `json:"batchId"`
	SnapshotId         string    `json:"snapshotId"`
	AgentInstanceId    string    `json:"agentInstanceId"`
	CommittedWatermark Watermark `json:"committedWatermark"`
}

// PushResult is the typed structured result of a successful push.
// Docker is nil for old servers, stripped retries, and invalid Docker acks
// (fail closed).
type PushResult struct {
	VpsId      string          `json:"vpsId"`
	ReceivedAt string          `json:"receivedAt"`
	Config     *ConfigResponse `json:"config"`
	Docker     *DockerAck      `json:"docker,omitempty"`
}

// Client pushes metrics to the backend.
type Client struct {
	backendURL    string
	token         string
	httpClient    *http.Client
	configHandler func(*ConfigResponse)
	location      func() *metrics.Location
}

// SetConfigHandler registers a callback that receives runtime configuration
// from the server on every successful push response. Missing or malformed
// config (including old server responses) produces a ConfigResponse with
// DockerMetricsEnabled=false (fail closed).
func (c *Client) SetLocationProvider(provider func() *metrics.Location) { c.location = provider }

func (c *Client) SetConfigHandler(handler func(*ConfigResponse)) {
	c.configHandler = handler
}

// NewClient creates a new push client from config.
func NewClient(cfg *config.Config) *Client {
	return &Client{
		backendURL: cfg.BackendUrl,
		token:      cfg.Token,
		httpClient: &http.Client{
			Timeout: time.Duration(cfg.RequestTimeoutSeconds) * time.Second,
		},
	}
}

// payload is the JSON body sent to the backend.
//
// Docker is the canonical Docker metrics payload under the single `docker` wire key.
type payload struct {
	VpsId        string              `json:"vpsId,omitempty"`
	CollectedAt  string              `json:"collectedAt"`
	CPU          float64             `json:"cpu"`
	Memory       float64             `json:"memory"`
	Disk         float64             `json:"disk"`
	LoadAverage  float64             `json:"loadAverage"`
	NetworkRx    float64             `json:"networkRx"`
	NetworkTx    float64             `json:"networkTx"`
	Uptime       float64             `json:"uptime"`
	AgentVersion string              `json:"agentVersion"`
	// BuildId is the immutable release build identity (40-hex git SHA);
	// omitted on dev builds with unknown identity so ingest clears it.
	BuildId   string              `json:"buildId,omitempty"`
	System    *metrics.SystemInfo `json:"system,omitempty"`
	Location  *metrics.Location   `json:"location,omitempty"`
	Docker    any                 `json:"docker,omitempty"`
}

// selectDockerBranch returns the `docker` wire branch for this push: the
// canonical Docker batch when present, otherwise nil (branch omitted).
func (c *Client) selectDockerBranch(m *metrics.SystemMetrics) any {
	if m == nil {
		return nil
	}
	if m.Docker != nil {
		return m.Docker
	}
	return nil
}

// maxResponseBytes bounds 2xx response parsing (256 digests fit in 32KiB).
const maxResponseBytes = 32 * 1024

var (
	opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)
	nanoPattern     = regexp.MustCompile(`^(0|[1-9][0-9]{0,31})$`)
)

func validOpaqueID(s string, max int) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	return opaqueIDPattern.MatchString(s)
}

func validNano(s string) bool {
	if len(s) == 0 || len(s) > 32 {
		return false
	}
	return nanoPattern.MatchString(s)
}

func validDigest(s string) bool { return validOpaqueID(s, 64) }

func validIngestStatus(s string) bool {
	switch s {
	case "committed", "already_committed", "replay_ignored":
		return true
	default:
		return false
	}
}

func validateDockerAck(a *DockerAck) bool {
	if a == nil {
		return false
	}
	if !validIngestStatus(a.IngestStatus) {
		return false
	}
	if !validOpaqueID(a.BatchId, 64) {
		return false
	}
	if !validOpaqueID(a.SnapshotId, 64) {
		return false
	}
	if !validOpaqueID(a.AgentInstanceId, 32) {
		return false
	}
	if !validNano(a.CommittedWatermark.TimeNano) {
		return false
	}
	if len(a.CommittedWatermark.BoundaryDigests) > 256 {
		return false
	}
	for _, d := range a.CommittedWatermark.BoundaryDigests {
		if !validDigest(d) {
			return false
		}
	}
	return true
}

func sanitizeConfig(cfg *ConfigResponse) *ConfigResponse {
	if cfg == nil {
		return &ConfigResponse{DockerMetricsEnabled: false}
	}
	out := &ConfigResponse{
		DockerMetricsEnabled: cfg.DockerMetricsEnabled,
		History:              cfg.History,
		ContainerHistory:     cfg.ContainerHistory,
		Events:               cfg.Events,
		Storage:              cfg.Storage,
	}
	return out
}

// buildSuccessResult parses a 2xx body of the form
// {data:{ok,vpsId,receivedAt,config,docker?}}. Old responses without docker
// remain valid with nil ack. Invalid Docker acks fail closed to nil ack.
// Never logs response bodies.
func buildSuccessResult(body []byte) *PushResult {
	failClosed := &PushResult{Config: &ConfigResponse{DockerMetricsEnabled: false}}
	if len(body) == 0 || len(body) > maxResponseBytes {
		return failClosed
	}
	var outer struct {
		Data *struct {
			VpsId      string          `json:"vpsId"`
			ReceivedAt string          `json:"receivedAt"`
			Config     *ConfigResponse `json:"config"`
			Docker     json.RawMessage `json:"docker"`
		} `json:"data"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&outer); err != nil || outer.Data == nil {
		return failClosed
	}
	// A successful response is exactly one JSON value. Do not accept a valid
	// envelope followed by attacker-controlled JSON data.
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return failClosed
	}
	cfg := &ConfigResponse{DockerMetricsEnabled: false}
	if outer.Data.Config != nil {
		cfg = sanitizeConfig(outer.Data.Config)
	}
	res := &PushResult{
		VpsId:      outer.Data.VpsId,
		ReceivedAt: outer.Data.ReceivedAt,
		Config:     cfg,
		Docker:     nil,
	}
	if len(outer.Data.Docker) == 0 || string(bytes.TrimSpace(outer.Data.Docker)) == "null" {
		return res
	}
	var ack DockerAck
	if err := json.Unmarshal(outer.Data.Docker, &ack); err != nil {
		return res
	}
	if !validateDockerAck(&ack) {
		return res
	}
	// Deep copy digests to detach from raw buffer.
	digests := make([]string, len(ack.CommittedWatermark.BoundaryDigests))
	copy(digests, ack.CommittedWatermark.BoundaryDigests)
	ack.CommittedWatermark.BoundaryDigests = digests
	res.Docker = &ack
	return res
}

// Push sends metrics to the backend and distinguishes fatal, conflict, and retryable errors.
// On success it returns a typed PushResult and applies returned configuration.
func (c *Client) Push(ctx context.Context, m *metrics.SystemMetrics) (*PushResult, error) {
	location := m.Location
	if location == nil && c.location != nil {
		location = c.location()
	}
	p := payload{
		VpsId:        "", // backend derives from token
		CollectedAt:  time.Now().UTC().Format(time.RFC3339),
		CPU:          m.CPU,
		Memory:       m.Memory,
		Disk:         m.Disk,
		LoadAverage:  m.LoadAverage,
		NetworkRx:    m.NetworkRx,
		NetworkTx:    m.NetworkTx,
		Uptime:       m.Uptime,
		AgentVersion: version.String(),
		BuildId:      version.BuildID(),
		System:       m.System,
		Docker:       c.selectDockerBranch(m),
		Location:     location,
	}

	body, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	endpoint, err := url.JoinPath(c.backendURL, "/api/agent/metrics")
	if err != nil {
		return nil, fmt.Errorf("invalid backend URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &ErrRetryable{StatusCode: 0, Err: fmt.Errorf("request failed: %w", err)}
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	sanitizedBody := sanitizeBody(string(respBody))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		res := buildSuccessResult(respBody)
		if res == nil {
			res = &PushResult{Config: &ConfigResponse{DockerMetricsEnabled: false}}
		}
		if res.Config == nil {
			res.Config = &ConfigResponse{DockerMetricsEnabled: false}
		}
		if c.configHandler != nil {
			c.configHandler(res.Config)
		}
		return res, nil
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return nil, &ErrAuth{StatusCode: resp.StatusCode, Body: sanitizedBody}
	case resp.StatusCode == 409:
		return nil, &ErrConflict{StatusCode: resp.StatusCode, Body: sanitizedBody}
	case resp.StatusCode == 400 && (m.Docker != nil):
		// Fail closed for downgraded servers or schema mismatches: disable
		// Docker collection and the Docker gate, then retry once without the
		// Docker branch so core host metrics keep flowing.
		c.disableDockerConfig()
		stripped := *m
		stripped.Docker = nil
		res, err := c.Push(ctx, &stripped)
		if err != nil {
			return nil, err
		}
		// Stripped retry never carries a Docker ack.
		if res != nil {
			res.Docker = nil
		} else {
			res = &PushResult{Config: &ConfigResponse{DockerMetricsEnabled: false}}
		}
		return res, nil
	case resp.StatusCode == 400 || resp.StatusCode == 404:
		return nil, &ErrFatal{StatusCode: resp.StatusCode, Body: sanitizedBody}
	default:
		return nil, &ErrRetryable{StatusCode: resp.StatusCode, Err: fmt.Errorf("unexpected status: %s", sanitizedBody)}
	}
}

func (c *Client) disableDockerConfig() {
	if c.configHandler != nil {
		c.configHandler(&ConfigResponse{DockerMetricsEnabled: false})
	}
}

// MaxRetries is the maximum number of retry attempts for retryable errors.
const MaxRetries = 5

// retryPush attempts to push with exponential backoff and jitter.
func (c *Client) retryPush(ctx context.Context, m *metrics.SystemMetrics) (*PushResult, error) {
	var lastErr error
	for attempt := 0; attempt <= MaxRetries; attempt++ {
		if attempt > 0 {
			backoff := backoffDuration(attempt)
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}

		res, err := c.Push(ctx, m)
		if err == nil {
			return res, nil
		}

		// Auth and fatal errors are not retried
		if IsFatal(err) {
			return nil, err
		}

		// Conflicts are non-fatal and not blindly retried; Runner owns pending.
		if isConflictErr(err) {
			return nil, err
		}

		lastErr = err

		// For retryable errors, continue loop
		if isRetryableErr(err) {
			continue
		}

		// Unexpected error type, treat as fatal
		return nil, err
	}
	return nil, fmt.Errorf("push failed after %d retries: %w", MaxRetries, lastErr)
}

// IsFatal returns true if the error is a non-retryable fatal error
// (auth failure or bad request / not found). ErrConflict is non-fatal.
func IsFatal(err error) bool {
	var authErr *ErrAuth
	if isErrType(err, &authErr) {
		return true
	}
	var fatalErr *ErrFatal
	return isErrType(err, &fatalErr)
}

func isAuthErr(err error) bool {
	var authErr *ErrAuth
	return isErrType(err, &authErr)
}

func isConflictErr(err error) bool {
	var conflictErr *ErrConflict
	return isErrType(err, &conflictErr)
}

func isRetryableErr(err error) bool {
	var retryErr *ErrRetryable
	return isErrType(err, &retryErr)
}

func isErrType[T error](err error, target *T) bool {
	return errors.As(err, target)
}

func backoffDuration(attempt int) time.Duration {
	if attempt <= 0 {
		attempt = 1
	}
	base := time.Duration(math.Pow(2, float64(attempt))) * time.Second
	if base > 30*time.Second {
		base = 30 * time.Second
	}
	// Add jitter: up to 50% of base
	jitter := time.Duration(rand.Int63n(int64(base / 2)))
	return base + jitter
}

// PushWithRetry is the public method that retries on retryable errors.
func (c *Client) PushWithRetry(ctx context.Context, m *metrics.SystemMetrics) (*PushResult, error) {
	return c.retryPush(ctx, m)
}

// tokenPattern matches vma_ prefixed agent tokens in error body text.
var tokenPattern = regexp.MustCompile(`vma_[a-zA-Z0-9_-]+`)

// sanitizeBody redacts token-like strings and limits length.
func sanitizeBody(body string) string {
	body = tokenPattern.ReplaceAllString(body, "[redacted]")
	if len(body) > 200 {
		return body[:200] + "..."
	}
	return body
}
