package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Config holds agent configuration loaded from a JSON file.
type Config struct {
	BackendUrl            string `json:"backendUrl"`
	VpsId                 string `json:"vpsId"`
	Token                 string `json:"token"`
	IntervalSeconds       int    `json:"intervalSeconds"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	StatePath             string `json:"statePath,omitempty"`
}

// Load reads and validates a config file from the given path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// Validate checks all config fields for correctness.
func (c *Config) Validate() error {
	if c.BackendUrl == "" {
		return fmt.Errorf("backendUrl is required")
	}
	u, err := url.Parse(c.BackendUrl)
	if err != nil || !u.IsAbs() {
		return fmt.Errorf("backendUrl must be a valid absolute URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("backendUrl scheme must be http or https, got %q", u.Scheme)
	}
	if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return fmt.Errorf("backendUrl must use https (http is only allowed for loopback, got %q)", u.Host)
	}

	if c.VpsId == "" {
		return fmt.Errorf("vpsId is required")
	}
	if c.Token == "" {
		return fmt.Errorf("token is required")
	}
	if c.IntervalSeconds < 1 {
		return fmt.Errorf("intervalSeconds must be >= 1")
	}
	if c.RequestTimeoutSeconds <= 0 {
		return fmt.Errorf("requestTimeoutSeconds must be > 0")
	}

	// Normalize: strip trailing slash so path joining is clean
	c.BackendUrl = strings.TrimRight(c.BackendUrl, "/")

	return nil
}

// isLoopbackHost reports whether host is a loopback name or literal; only
// these may use a plain http backendUrl (local development / same-host
// deployments). Everything else must be https.
func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// String returns a sanitized representation that never includes the token.
func (c *Config) String() string {
	return fmt.Sprintf(
		"Config{BackendUrl: %s, VpsId: %s, Token: [redacted], IntervalSeconds: %d, RequestTimeoutSeconds: %d}",
		c.BackendUrl, c.VpsId, c.IntervalSeconds, c.RequestTimeoutSeconds,
	)
}
