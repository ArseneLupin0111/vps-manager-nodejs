//go:build linux

package logs

import (
	"context"
	"net"
	"net/http"
	"time"
)

// dockerLogSocketPath is the only Docker socket this package may open. The
// API and web never dial it; the source reaches the daemon only through the
// two allowlisted GET builders in docker_logs.go. Mirrors the commands and
// metrics packages' convention.
const dockerLogSocketPath = "/var/run/docker.sock"

// newDockerLogHTTPClient builds a log HTTP client with its own timeout and
// transport: the control/metrics clients keep their own budgets and must
// not be shared with a long-lived follow stream.
//
// Timeout bounds dial and response headers only (ResponseHeaderTimeout):
// the follow body itself lives on the subscription context via OpenFollow
// and is never bound to a client-wide timeout.
func newDockerLogHTTPClient(socketPath string, timeout time.Duration) *http.Client {
	if socketPath == "" {
		socketPath = dockerLogSocketPath
	}
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: timeout}).DialContext(ctx, "unix", socketPath)
			},
			// Bounds follow connect/headers at the transport too; the
			// follow body itself is never bound here (only headers), it
			// lives on the subscription context via OpenFollow.
			ResponseHeaderTimeout: timeout,
		},
	}
}

// NewDockerLogSource builds the production log source over the Unix socket.
func NewDockerLogSource(socketPath string, timeout time.Duration) (*DockerSource, error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	s, err := NewDockerSource(newDockerLogHTTPClient(socketPath, timeout), "http://localhost")
	if err != nil {
		return nil, err
	}
	s.timeout = timeout
	return s, nil
}
