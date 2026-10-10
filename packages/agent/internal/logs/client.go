// Package logs implements step 4 of the Docker realtime logs plan: the
// bounded fail-closed agent transport plus the on-demand Docker log source.
//
// The wire contract lives in protocol.go (mirroring
// packages/api/src/docker/docker-logs.schemas.ts). This file owns the
// outbound HTTP half: bearer auth, bounded reads, fail-closed decoding and
// status mapping for the three agent endpoints:
//
//	POST {backendURL}/api/agent/logs/claim
//	  Body {"agentInstanceId"} -> 200 {"data":{"subscription":null|{...}}}
//	POST {backendURL}/api/agent/logs/:subscriptionId/chunks
//	  Body {"agentInstanceId","sequence","ready","lines"}
//	  -> 200 {"data":{"ok":true,"subscriptionId","sequence"}}
//	POST {backendURL}/api/agent/logs/:subscriptionId/result
//	  Body {"agentInstanceId","status","errorCode?"}
//	  -> 200 {"data":{"ok":true,"subscriptionId","agentInstanceId"}}
//
// No request ever carries Docker log content to a log sink: bodies are
// bounded, tokens are redacted, and daemon error bodies are never echoed.
package logs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/vps-manager/agent/internal/config"
)

const (
	logsBasePath      = "/api/agent/logs"
	logsClaimPath     = logsBasePath + "/claim"
	logsChunksSuffix  = "/chunks"
	logsResultSuffix  = "/result"
	maxLogsRetryBytes = MaxBodyBytes
)

// ErrAuth indicates a fatal 401/403: the credential is rejected. The logs
// worker stops; nothing is retried.
type ErrAuth struct {
	StatusCode int
	Body       string
}

func (e *ErrAuth) Error() string { return fmt.Sprintf("logs auth failed (HTTP %d)", e.StatusCode) }

// ErrGone indicates the subscription (or, for claim, the route) no longer
// exists: 404/410. The caller must cancel its Docker source and stop; it
// must never re-upload a batch, because a re-sent batch could duplicate.
type ErrGone struct {
	StatusCode int
	Body       string
}

func (e *ErrGone) Error() string { return fmt.Sprintf("logs target gone (HTTP %d)", e.StatusCode) }

// ErrFatal indicates a non-retryable 400: the body was rejected. The
// sequence/binding is already broken, so the subscription is abandoned.
type ErrFatal struct {
	StatusCode int
	Body       string
}

func (e *ErrFatal) Error() string { return fmt.Sprintf("logs fatal error (HTTP %d)", e.StatusCode) }

// ErrConflict indicates 409: the sequence is not the next expected one.
// Non-retryable by design — blind retry would duplicate lines.
type ErrConflict struct {
	StatusCode int
	Body       string
}

func (e *ErrConflict) Error() string { return fmt.Sprintf("logs conflict (HTTP %d)", e.StatusCode) }

// ErrRetryable indicates transient 5xx/network failure. The subscription is
// cancelled (fail closed) rather than retried, because the daemon stream is
// already open and a replay would risk duplicates.
type ErrRetryable struct {
	StatusCode int
	Err        error
}

func (e *ErrRetryable) Error() string {
	return fmt.Sprintf("logs retryable error (HTTP %d): %v", e.StatusCode, e.Err)
}

func (e *ErrRetryable) Unwrap() error { return e.Err }

// IsGone reports 404/410 (route or subscription gone).
func IsGone(err error) bool {
	var g *ErrGone
	return errors.As(err, &g)
}

// IsConflict reports 409 (sequence mismatch).
func IsConflict(err error) bool {
	var c *ErrConflict
	return errors.As(err, &c)
}

// IsFatal reports non-retryable 400.
func IsFatal(err error) bool {
	var f *ErrFatal
	return errors.As(err, &f)
}

// IsAuth reports 401/403.
func IsAuth(err error) bool {
	var a *ErrAuth
	return errors.As(err, &a)
}

var tokenPattern = regexp.MustCompile(`vma_[a-zA-Z0-9_-]+`)

func sanitizeBody(body string) string {
	body = tokenPattern.ReplaceAllString(body, "[redacted]")
	if len(body) > 200 {
		return body[:200] + "..."
	}
	return body
}

// Transport is the agent-side surface of the logs broker. *Client is the
// production implementation; tests inject a fake.
type Transport interface {
	Claim(ctx context.Context, agentInstanceID string) (*ClaimedSubscription, error)
	PostChunks(ctx context.Context, subscriptionID string, req ChunksRequest) (ChunksResponse, error)
	PostResult(ctx context.Context, subscriptionID string, req ResultRequest) (ResultResponse, error)
}

// Client performs the authenticated claim/chunks/result transport. It never
// logs tokens or log content; error bodies are sanitized and bounded.
//
// Two HTTP clients are held on purpose: claim runs on the configured request
// timeout, uploads are capped at maxUploadTimeout so a wedged API can never
// pin the daemon stream open (plan: min(cfg.RequestTimeoutSeconds, 5s)).
type Client struct {
	backendURL string
	token      string
	claimHTTP  *http.Client
	uploadHTTP *http.Client
}

// MaxUploadTimeout caps one chunks/result upload.
const MaxUploadTimeout = 5 * time.Second

// NewClient builds the logs transport from agent config.
func NewClient(cfg *config.Config) *Client {
	return NewClientWithHTTP(cfg, nil, nil)
}

// NewClientWithHTTP injects transports for tests. Nil clients fall back to
// config-derived defaults (claim = RequestTimeoutSeconds, upload = capped).
func NewClientWithHTTP(cfg *config.Config, claimHC, uploadHC *http.Client) *Client {
	cfgTimeout := time.Duration(cfg.RequestTimeoutSeconds) * time.Second
	uploadTimeout := cfgTimeout
	if uploadTimeout > MaxUploadTimeout {
		uploadTimeout = MaxUploadTimeout
	}
	return &Client{
		backendURL: cfg.BackendUrl,
		token:      cfg.Token,
		claimHTTP:  orDefaultHTTP(claimHC, cfgTimeout),
		uploadHTTP: orDefaultHTTP(uploadHC, uploadTimeout),
	}
}

func orDefaultHTTP(hc *http.Client, timeout time.Duration) *http.Client {
	if hc != nil {
		return hc
	}
	return &http.Client{Timeout: timeout}
}

// NewClientWithHTTPAndToken builds a client with an explicit token (tests
// that do not carry a full config).
func NewClientWithHTTPAndToken(backendURL, token string, claimHC, uploadHC *http.Client) *Client {
	return &Client{
		backendURL: backendURL,
		token:      token,
		claimHTTP:  orDefaultHTTP(claimHC, MaxUploadTimeout),
		uploadHTTP: orDefaultHTTP(uploadHC, MaxUploadTimeout),
	}
}

func (c *Client) endpoint(path string) (string, error) {
	return url.JoinPath(c.backendURL, path)
}

// postJSON sends body as JSON and returns status + bounded raw response.
// The wire bytes are produced by the same helper the size budget measures,
// so a batch accepted by the budget is exactly what crosses the wire.
func (c *Client) postJSON(ctx context.Context, hc *http.Client, path string, body any) (int, []byte, error) {
	raw, err := MarshalJSON(body)
	if err != nil {
		return 0, nil, fmt.Errorf("marshal logs payload: %w", err)
	}
	if len(raw) > MaxBodyBytes {
		return 0, nil, fmt.Errorf("logs payload oversize: %d", len(raw))
	}
	target, err := c.endpoint(path)
	if err != nil {
		return 0, nil, fmt.Errorf("invalid backend URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, fmt.Errorf("create logs request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return 0, nil, &ErrRetryable{StatusCode: 0, Err: fmt.Errorf("request failed: %w", err)}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes+1))
	return resp.StatusCode, respBody, nil
}

func (c *Client) chunksPath(subscriptionID string) (string, error) {
	if !validOpaqueID(subscriptionID, MaxSubscriptionIDLen) {
		return "", fmt.Errorf("bad subscriptionId")
	}
	return logsBasePath + "/" + subscriptionID + logsChunksSuffix, nil
}

func (c *Client) resultPath(subscriptionID string) (string, error) {
	if !validOpaqueID(subscriptionID, MaxSubscriptionIDLen) {
		return "", fmt.Errorf("bad subscriptionId")
	}
	return logsBasePath + "/" + subscriptionID + logsResultSuffix, nil
}

// claimStatus maps claim answers. A claim 404 means this API predates the
// logs route: the worker stops until the agent restarts (no error spam).
func claimStatus(status int, body []byte) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == 401 || status == 403:
		return &ErrAuth{StatusCode: status, Body: sanitizeBody(string(body))}
	case status == 404 || status == 410:
		return &ErrGone{StatusCode: status, Body: sanitizeBody(string(body))}
	case status == 400:
		return &ErrFatal{StatusCode: status, Body: sanitizeBody(string(body))}
	default:
		return &ErrRetryable{StatusCode: status, Err: fmt.Errorf("unexpected status: %s", sanitizeBody(string(body)))}
	}
}

// uploadStatus maps chunks/result answers. Any non-2xx abandons the
// subscription: the stream is already open and must never be replayed.
func uploadStatus(status int, body []byte) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == 401 || status == 403:
		return &ErrAuth{StatusCode: status, Body: sanitizeBody(string(body))}
	case status == 404 || status == 410:
		return &ErrGone{StatusCode: status, Body: sanitizeBody(string(body))}
	case status == 409:
		return &ErrConflict{StatusCode: status, Body: sanitizeBody(string(body))}
	case status == 400:
		return &ErrFatal{StatusCode: status, Body: sanitizeBody(string(body))}
	default:
		return &ErrRetryable{StatusCode: status, Err: fmt.Errorf("unexpected status: %s", sanitizeBody(string(body)))}
	}
}

// boundedBody rejects empty/oversize bodies before decoding.
func boundedBody(b []byte) error {
	if len(b) == 0 {
		return fmt.Errorf("logs: empty response body")
	}
	if len(b) > MaxBodyBytes {
		return fmt.Errorf("logs: response oversize: fail closed")
	}
	return nil
}

// Claim asks for one waiting viewer subscription. It returns (nil, nil)
// when none is queued. A claimed subscription is validated fail-closed;
// invalid shape, unknown instance, or trailing JSON is an error.
func (c *Client) Claim(ctx context.Context, agentInstanceID string) (*ClaimedSubscription, error) {
	if !validOpaqueID(agentInstanceID, MaxInstanceIDLen) {
		return nil, fmt.Errorf("bad agentInstanceId")
	}
	status, body, err := c.postJSON(ctx, c.claimHTTP, logsClaimPath, ClaimRequest{AgentInstanceID: agentInstanceID})
	if err != nil {
		return nil, err
	}
	if err := claimStatus(status, body); err != nil {
		return nil, err
	}
	if err := boundedBody(body); err != nil {
		return nil, err
	}
	resp, err := DecodeClaimResponse(body)
	if err != nil {
		return nil, err
	}
	sub := resp.Data.Subscription
	if sub == nil {
		return nil, nil
	}
	if sub.AgentInstanceID != agentInstanceID {
		return nil, fmt.Errorf("logs: claim instance mismatch: fail closed")
	}
	return sub, nil
}

// PostChunks uploads one batch or heartbeat. Only the next sequence is
// accepted by the broker; a mismatch (409) is never blindly retried.
func (c *Client) PostChunks(ctx context.Context, subscriptionID string, req ChunksRequest) (ChunksResponse, error) {
	path, err := c.chunksPath(subscriptionID)
	if err != nil {
		return ChunksResponse{}, err
	}
	wire := SerializedOutgoingBytes(req)
	if err := ValidateChunksRequest(req, wire); err != nil {
		return ChunksResponse{}, fmt.Errorf("logs: chunks invalid: %w", err)
	}
	status, body, err := c.postJSON(ctx, c.uploadHTTP, path, req)
	if err != nil {
		return ChunksResponse{}, err
	}
	if err := uploadStatus(status, body); err != nil {
		return ChunksResponse{}, err
	}
	if err := boundedBody(body); err != nil {
		return ChunksResponse{}, err
	}
	resp, err := DecodeChunksResponse(body)
	if err != nil {
		return ChunksResponse{}, err
	}
	if resp.Data.SubscriptionID != subscriptionID {
		return ChunksResponse{}, fmt.Errorf("logs: chunks echo mismatch: fail closed")
	}
	if resp.Data.Sequence != req.Sequence {
		return ChunksResponse{}, fmt.Errorf("logs: chunks sequence echo mismatch: fail closed")
	}
	return resp, nil
}

// PostResult reports the terminal outcome. Completed only on clean Docker
// EOF; failed carries a safe code, never a daemon error body.
func (c *Client) PostResult(ctx context.Context, subscriptionID string, req ResultRequest) (ResultResponse, error) {
	path, err := c.resultPath(subscriptionID)
	if err != nil {
		return ResultResponse{}, err
	}
	if err := ValidateResultRequest(req); err != nil {
		return ResultResponse{}, fmt.Errorf("logs: result invalid: %w", err)
	}
	status, body, err := c.postJSON(ctx, c.uploadHTTP, path, req)
	if err != nil {
		return ResultResponse{}, err
	}
	if err := uploadStatus(status, body); err != nil {
		return ResultResponse{}, err
	}
	if err := boundedBody(body); err != nil {
		return ResultResponse{}, err
	}
	resp, err := DecodeResultResponse(body)
	if err != nil {
		return ResultResponse{}, err
	}
	if resp.Data.SubscriptionID != subscriptionID {
		return ResultResponse{}, fmt.Errorf("logs: result echo mismatch: fail closed")
	}
	if resp.Data.AgentInstanceID != req.AgentInstanceID {
		return ResultResponse{}, fmt.Errorf("logs: result instance echo mismatch: fail closed")
	}
	return resp, nil
}

// compile-time guard: the client satisfies the worker transport surface.
var _ Transport = (*Client)(nil)
