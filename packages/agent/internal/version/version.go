package version

// Value is injected at build time with -ldflags (-X ...version.Value=<semver>).
// Development builds fall back to "dev".
var Value = "dev"

// Build is the immutable build identity injected at build time with
// -ldflags (-X ...version.Build=<full 40-hex git SHA of the release commit>).
// Development builds leave it empty; an empty Build means the build identity
// is unknown and must never be advertised as a current release.
var Build = ""

// String returns the effective agent version.
func String() string {
	if Value == "" {
		return "dev"
	}
	return Value
}

// BuildID returns the immutable build identity, empty when unknown.
func BuildID() string {
	return Build
}

// Identity returns the single-line identity printed by `-version`:
// "<version>+<buildId>" when the build identity is known, otherwise the
// version alone. It stays within the API upgrader's VERSION_RE
// ([A-Za-z0-9][A-Za-z0-9._+-]{0,63}) and lets verifiers split version and
// build ID at the last '+' ('+' is legal inside semver build metadata, and
// Build is always a 40-hex suffix when present).
func Identity() string {
	v := String()
	if Build == "" {
		return v
	}
	return v + "+" + Build
}
