package updater

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

const fixturesDir = "../../../../scripts/release/fixtures"

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, name))
	if err != nil {
		t.Fatalf("read fixture %s (release fixtures must be present): %v", name, err)
	}
	return raw
}

// TestCanonicalMatchesReleasePipeline locks the canonical serialization to
// the release pipeline's byte output: canonical.txt is the exact message the
// published signature was computed over.
func TestCanonicalMatchesReleasePipeline(t *testing.T) {
	valid := readFixture(t, "manifest.valid.json")
	want := readFixture(t, "manifest.canonical.txt") // no trailing newline, byte-exact

	got, err := CanonicalSignedBytes(valid)
	if err != nil {
		t.Fatalf("CanonicalSignedBytes: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("canonical bytes diverge from release pipeline\n got: %s\nwant: %s", got, want)
	}

	// Also: canonicalizing the canonical form must be idempotent.
	again, err := CanonicalJSON(got)
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	if !bytes.Equal(again, want) {
		t.Fatalf("canonicalization not idempotent")
	}
}

// TestVerifyFixtureSignature verifies the fixture signature over the
// canonical bytes with the fixture's test-only public key.
func TestVerifyFixtureSignature(t *testing.T) {
	pubRaw := bytes.TrimSpace(readFixture(t, "manifest.pubkey.b64"))
	key, err := base64.StdEncoding.DecodeString(string(pubRaw))
	if err != nil || len(key) != ed25519.PublicKeySize {
		t.Fatalf("pubkey fixture invalid: %v", err)
	}
	sig, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(readFixture(t, "manifest.signature.b64"))))
	if err != nil || len(sig) != ed25519.SignatureSize {
		t.Fatalf("signature fixture invalid: %v", err)
	}
	canonical := readFixture(t, "manifest.canonical.txt")
	if !ed25519.Verify(ed25519.PublicKey(key), canonical, sig) {
		t.Fatal("ed25519.Verify failed over canonical fixture bytes")
	}

	// Full path: VerifyManifest over the signed document.
	m, err := VerifyManifest(readFixture(t, "manifest.valid.json"), string(pubRaw))
	if err != nil {
		t.Fatalf("VerifyManifest(valid): %v", err)
	}
	if m.ReleaseID != "abcdefabcdefabcdefabcdefabcdefabcdefabcd" || m.BuildID != m.ReleaseID {
		t.Fatalf("unexpected release/build ids: %q / %q", m.ReleaseID, m.BuildID)
	}
	if m.Version != "1.2.3" || m.Channel != "stable" {
		t.Fatalf("unexpected version/channel: %q/%q", m.Version, m.Channel)
	}

	// Component defaults: amd64 agent selected even though the arm64 entry
	// carries no component field.
	art, err := m.AgentArtifact(nil)
	if err != nil {
		t.Fatalf("AgentArtifact: %v", err)
	}
	if art.OS != "linux" || art.Arch != "amd64" || art.Component != "agent" {
		t.Fatalf("wrong artifact selected: %+v", art)
	}
}

// TestVerifyTamperedManifestFails proves a single altered byte (artifact
// sha256) breaks signature verification — fail closed.
func TestVerifyTamperedManifestFails(t *testing.T) {
	pubRaw := string(bytes.TrimSpace(readFixture(t, "manifest.pubkey.b64")))
	if _, err := VerifyManifest(readFixture(t, "manifest.tampered.json"), pubRaw); err == nil {
		t.Fatal("tampered manifest must fail verification")
	}
	valid := readFixture(t, "manifest.valid.json")
	if _, err := VerifyManifest(valid, ""); err == nil {
		t.Fatal("empty pinned key must fail closed")
	}
	if _, err := VerifyManifest(valid, "dG90YWxseS1ub3QtYS1rZXk="); err == nil {
		t.Fatal("wrong-length pinned key must fail closed")
	}
}
