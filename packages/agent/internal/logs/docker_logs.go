package logs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Docker log source allowlist: exactly two GET builders and nothing else.
// No generic request helper may accept a path from API input. Paths are
// hardcoded; the only variable is the full 64-char lowercase hex daemon ID
// resolved locally by commands.NewDockerTargetResolver (never a key or
// name). The follow query is built with url.Values from constants, so the
// daemon path can never be steered by the broker.
const (
	dockerContainersPrefix  = "/containers/"
	dockerJSONSuffix        = "/json"
	dockerLogsSuffix        = "/logs"
	dockerMaxRawIDLen       = 64
	maxInspectBytes         = 256 * 1024
	maxHeaderWait           = 30 * time.Second
	dockerMaxFrameBytes     = 16 * 1024 * 1024
	dockerPayloadBufferSize = 8 * 1024
)

// SourceError carries a safe, allowlisted code. Daemon error bodies are
// never transported, so only the classification reaches the broker.
type SourceError struct {
	Code string
}

func (e *SourceError) Error() string { return "logs: docker source " + e.Code }

func sourceErr(code string) *SourceError { return &SourceError{Code: code} }

// errCode reports the safe classification of a source error; unexpected
// values fail closed to logs_unavailable.
func errCode(err error) string {
	var se *SourceError
	if errors.As(err, &se) && logErrorAllowlist[se.Code] {
		return se.Code
	}
	return ErrLogsUnavailable
}

// isRawContainerID reports whether id is a full 64-char lowercase hex ID.
// Truncated display IDs, names, and container keys never reach the daemon.
func isRawContainerID(id string) bool {
	if len(id) != dockerMaxRawIDLen {
		return false
	}
	for _, c := range []byte(id) {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func dockerLogsBase(baseURL string) (string, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid docker base url")
	}
	if u.Scheme != "http" {
		return "", fmt.Errorf("invalid docker base url scheme")
	}
	if u.Host == "" || u.User != nil {
		return "", fmt.Errorf("invalid docker base url host")
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("invalid docker base url")
	}
	return "http://" + u.Host, nil
}

// DockerSource opens Docker Engine reads for realtime log streaming.
// Production uses the Unix-socket client from docker_logs_socket_linux.go
// via NewDockerLogSource; tests inject an httptest client + base URL.
type DockerSource struct {
	client  *http.Client
	baseURL string
	// timeout bounds dial, response headers, and inspect (connect + headers
	// + body). The follow body itself lives on the subscription context and
	// is never bound to this timeout.
	timeout time.Duration
}

// NewDockerSource builds a source with an explicit client/base. Base must
// be a bare http://host sentinel; the transport decides where it dials.
// Timeout is unset here (effective default maxHeaderWait); production
// NewDockerLogSource overrides it with the configured bound.
func NewDockerSource(client *http.Client, baseURL string) (*DockerSource, error) {
	if client == nil {
		return nil, fmt.Errorf("nil docker client")
	}
	base, err := dockerLogsBase(baseURL)
	if err != nil {
		return nil, err
	}
	return &DockerSource{client: client, baseURL: base}, nil
}

// NewDockerSourceWithTimeout builds a source with an explicit configured
// bound for inspect (connect+headers+body) and follow headers
// (connect+headers via transport; body stays on the subscription context).
func NewDockerSourceWithTimeout(client *http.Client, baseURL string, timeout time.Duration) (*DockerSource, error) {
	s, err := NewDockerSource(client, baseURL)
	if err != nil {
		return nil, err
	}
	if timeout > 0 {
		s.timeout = timeout
	}
	return s, nil
}

// effectiveTimeout reports the configured bound, falling back to the broker
// ready window when no timeout was configured (injected test clients).
func (s *DockerSource) effectiveTimeout() time.Duration {
	if s.timeout > 0 {
		return s.timeout
	}
	return maxHeaderWait
}

func (s *DockerSource) inspectRequest(ctx context.Context, id string) (*http.Request, error) {
	if !isRawContainerID(id) {
		return nil, sourceErr(ErrTargetMismatch)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.baseURL+dockerContainersPrefix+id+dockerJSONSuffix, nil)
	if err != nil {
		return nil, err
	}
	return req, nil
}

// followRequest builds the single allowlisted follow read: one request for
// history and live. tail=200&follow=1 from constants — never a snapshot
// plus a second follow (that would gap or duplicate).
func (s *DockerSource) followRequest(ctx context.Context, id string) (*http.Request, error) {
	if !isRawContainerID(id) {
		return nil, sourceErr(ErrTargetMismatch)
	}
	q := url.Values{}
	q.Set("stdout", "1")
	q.Set("stderr", "1")
	q.Set("tail", fmt.Sprintf("%d", TailLines))
	q.Set("timestamps", "1")
	q.Set("follow", "1")
	target := s.baseURL + dockerContainersPrefix + id + dockerLogsSuffix + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	return req, nil
}

// InspectTTY reads Config.Tty with a bounded decode. TTY is never guessed
// from bytes: when tty is false the daemon multiplexes stdout/stderr with
// an 8-byte header, when true the body is raw. The whole inspect (connect,
// headers, and body) is bounded by the configured timeout, never by the
// 2h subscription context.
func (s *DockerSource) InspectTTY(ctx context.Context, fullID string) (bool, error) {
	inspectCtx, cancel := context.WithTimeout(ctx, s.effectiveTimeout())
	defer cancel()
	req, err := s.inspectRequest(inspectCtx, fullID)
	if err != nil {
		return false, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			// Subscription cancelled while inspecting.
			return false, sourceErr(ErrStreamLost)
		}
		// Includes the configured header/body bound firing.
		return false, sourceErr(ErrDaemonUnreachable)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, sourceErr(ErrContainerNotFound)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, sourceErr(ErrLogsUnavailable)
	}
	var inspect struct {
		Config struct {
			Tty bool `json:"Tty"`
		} `json:"Config"`
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxInspectBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			// Subscription cancelled while reading inspect.
			return false, sourceErr(ErrStreamLost)
		}
		// Includes the configured inspect bound firing mid-body.
		return false, sourceErr(ErrDaemonUnreachable)
	}
	if len(body) > maxInspectBytes {
		return false, sourceErr(ErrLogsUnavailable)
	}
	if err := json.Unmarshal(body, &inspect); err != nil {
		return false, sourceErr(ErrLogsUnavailable)
	}
	return inspect.Config.Tty, nil
}

// OpenFollow starts the single continuous Docker log read for a
// subscription. The returned response body stays open for the lifetime of
// the stream; the caller closes it on cancel/EOF. The body lives on the
// subscription context: connect and response headers are bounded by the
// configured timeout, never by a client-wide timeout and never by the 2h
// subscription deadline.
func (s *DockerSource) OpenFollow(ctx context.Context, fullID string) (*http.Response, error) {
	// reqCtx lives for the whole body: it is a child of the subscription
	// context, so cancelling the subscription unblocks the read. The header
	// timer cancels it only while waiting for headers; once headers arrive
	// the timer is stopped and the body is never bound to a header timeout.
	reqCtx, cancel := context.WithCancel(ctx)
	req, err := s.followRequest(reqCtx, fullID)
	if err != nil {
		cancel()
		return nil, err
	}
	headerTimer := time.AfterFunc(s.effectiveTimeout(), cancel)
	resp, err := s.client.Do(req)
	if !headerTimer.Stop() {
		// Headers did not arrive within the configured bound (timer already
		// fired and cancelled the request). Drop a late success, if any.
		if err == nil {
			resp.Body.Close()
		}
		cancel()
		if ctx.Err() != nil {
			// Subscription cancelled/deadline reached while connecting.
			return nil, sourceErr(ErrStreamLost)
		}
		return nil, sourceErr(ErrDaemonUnreachable)
	}
	if err != nil {
		cancel()
		if ctx.Err() != nil {
			// Subscription cancelled/deadline reached while connecting.
			return nil, sourceErr(ErrStreamLost)
		}
		return nil, sourceErr(ErrDaemonUnreachable)
	}
	// Headers arrived in time: the timer is stopped, so the body stays open
	// on the subscription context until the caller closes it or the
	// subscription ends. Wrap Close so the child context is released even
	// when the parent lives on (2h) after an early EOF/close.
	resp.Body = &followBody{ReadCloser: resp.Body, cancel: cancel}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, sourceErr(ErrContainerNotFound)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		// Includes log drivers that cannot be read back.
		return nil, sourceErr(ErrLogsUnavailable)
	}
	return resp, nil
}

// followBody releases the follow request context when the caller is done.
// Reads themselves remain on the subscription context via parent
// propagation; Close only releases the child resources early.
type followBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *followBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

// OpenFollowPort adapts OpenFollow to the worker's port interface, which
// keeps the worker package-internal and free of an http.Response in its
// dependency surface.
func (s *DockerSource) OpenFollowPort(ctx context.Context, fullID string) (FollowResponse, error) {
	resp, err := s.OpenFollow(ctx, fullID)
	if err != nil {
		return nil, err
	}
	return httpFollowResponse{body: resp.Body}, nil
}

// dockerSourcePort adapts a *DockerSource to the worker's port interface,
// keeping http.Response out of the worker's dependency surface.
type dockerSourcePort struct{ s *DockerSource }

// NewDockerSourcePort adapts a *DockerSource for NewClaimWorker/Worker.
func NewDockerSourcePort(s *DockerSource) DockerSourcePort { return dockerSourcePort{s: s} }

// InspectTTY resolves whether the daemon container runs with a TTY.
func (p dockerSourcePort) InspectTTY(ctx context.Context, fullID string) (bool, error) {
	return p.s.InspectTTY(ctx, fullID)
}

// OpenFollow opens the follow source and wraps its body for the worker.
func (p dockerSourcePort) OpenFollow(ctx context.Context, fullID string) (FollowResponse, error) {
	return p.s.OpenFollowPort(ctx, fullID)
}
