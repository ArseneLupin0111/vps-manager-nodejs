package updater

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// DownloadResult describes a completed, verified download.
type DownloadResult struct {
	Path   string
	Size   int64
	SHA256 string
}

// DownloadArtifact fetches artifact into destPath with hard bounds:
//   - URL re-validated against the hostname allowlist (https, no userinfo,
//     no unexpected port, exact host match) even though the manifest was
//     already signed — a signature does not relax transport policy;
//   - HTTP timeout from config;
//   - Content-Length (when present) and streamed bytes capped at both the
//     manifest size and MaxArtifactBytes;
//   - final SHA-256 must equal the signed artifact hash.
//
// The write goes to destPath+".part" and is renamed only after the hash
// matches, so a partial or wrong file never sits at the final path.
func DownloadArtifact(ctx context.Context, cfg *Config, client *http.Client, artifact *ManifestArtifact, destPath string) (*DownloadResult, error) {
	if err := validateArtifactURL(artifact.URL, cfg.AllowedHosts); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "vps-updater/1")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: status %d", resp.StatusCode)
	}
	if resp.ContentLength > 0 {
		if resp.ContentLength > artifact.Size || resp.ContentLength > cfg.MaxArtifactBytes {
			return nil, fmt.Errorf("download: content-length %d exceeds bound", resp.ContentLength)
		}
	}

	limit := artifact.Size
	if cfg.MaxArtifactBytes < limit {
		limit = cfg.MaxArtifactBytes
	}

	partPath := destPath + ".part"
	if err := os.MkdirAll(filepath.Dir(destPath), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create part file: %w", err)
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(partPath) // no-op after successful rename
	}()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("stream download: %w", err)
	}
	if n > limit {
		return nil, fmt.Errorf("download exceeded %d bytes bound", limit)
	}
	if n != artifact.Size {
		return nil, fmt.Errorf("download size %d != signed size %d", n, artifact.Size)
	}
	if err := f.Sync(); err != nil {
		return nil, fmt.Errorf("fsync download: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("close download: %w", err)
	}

	got := fmt.Sprintf("%x", h.Sum(nil))
	if got != artifact.SHA256 {
		return nil, fmt.Errorf("download sha256 %s does not match signed %s", got, artifact.SHA256)
	}
	if err := os.Rename(partPath, destPath); err != nil {
		return nil, fmt.Errorf("finalize download: %w", err)
	}
	return &DownloadResult{Path: destPath, Size: n, SHA256: got}, nil
}

// newHTTPClient returns the shared HTTP client for downloads: strict timeout,
// no redirects to unexpected hosts are prevented by re-validating each hop's
// URL — Go follows redirects internally, so we validate the *final* URL and
// cap redirects via CheckRedirect.
func newHTTPClient(cfg *Config) *http.Client {
	return &http.Client{
		Timeout: cfg.HTTPTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			return validateArtifactURL(req.URL.String(), cfg.AllowedHosts)
		},
	}
}
