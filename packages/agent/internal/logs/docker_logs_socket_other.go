//go:build !linux

package logs

import (
	"fmt"
	"net/http"
	"time"
)

// newDockerLogHTTPClient is unsupported off Linux: there is no Docker Engine
// Unix socket to dial, and no TCP daemon target is configurable. Failures are
// explicit rather than silently misdirected.
func newDockerLogHTTPClient(_ string, _ time.Duration) *http.Client {
	return &http.Client{Transport: failingTransport{}}
}

type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("logs: docker transport unsupported on this platform")
}

// NewDockerLogSource reports an explicit unsupported-platform error.
func NewDockerLogSource(_ string, _ time.Duration) (*DockerSource, error) {
	return nil, fmt.Errorf("logs: docker transport unsupported on this platform")
}
