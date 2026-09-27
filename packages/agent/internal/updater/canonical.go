// Package updater implements the local, pull-only safe-upgrade engine for the
// vps-manager agent. It claims jobs from the API with a scoped credential,
// downloads and verifies signed release artifacts over HTTPS, and performs the
// privileged swap through a fixed-argv root helper — never through an API
// controlled shell, path, or socket.
package updater

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// jsonQuote renders s as a JSON string literal without HTML escaping, so the
// output matches standard canonicalizers (e.g. JS JSON.stringify) byte-for-byte.
func jsonQuote(s string) (string, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return "", err
	}
	out := buf.String()
	return strings.TrimSuffix(out, "\n"), nil
}

// CanonicalJSON re-serializes a JSON document deterministically: object keys
// sorted recursively, no insignificant whitespace, strings/numbers preserved
// with their original lexical spelling. The byte output is what release
// signatures are computed over, so it must match the release pipeline's
// canonicalizer byte-for-byte.
func CanonicalJSON(raw []byte) ([]byte, error) {
	v, err := decodeCanonicalValue(raw)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := writeCanonicalValue(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// canonicalValue is a parsed JSON document that remembers how scalars were
// spelled so re-serialization is lossless (json.Number semantics without
// silently reformatting numbers).
type canonicalValue struct {
	kind   byte // 'o' object, 'a' array, 's' string, 'l' literal
	keys   []string
	vals   []*canonicalValue
	items  []*canonicalValue
	scalar string // raw spelling: quoted string, number, true/false/null
}

func decodeCanonicalValue(raw []byte) (*canonicalValue, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var top any
	if err := dec.Decode(&top); err != nil {
		return nil, fmt.Errorf("canonical: invalid JSON: %w", err)
	}
	if dec.More() {
		return nil, fmt.Errorf("canonical: trailing data after JSON document")
	}
	return convertCanonical(top)
}

func convertCanonical(v any) (*canonicalValue, error) {
	switch t := v.(type) {
	case map[string]any:
		cv := &canonicalValue{kind: 'o'}
		for k, raw := range t {
			nested, err := convertCanonical(raw)
			if err != nil {
				return nil, err
			}
			cv.keys = append(cv.keys, k)
			cv.vals = append(cv.vals, nested)
		}
		// Sort keys (and their paired values) by raw byte order.
		order := make([]int, len(cv.keys))
		for i := range order {
			order[i] = i
		}
		sort.Slice(order, func(a, b int) bool { return cv.keys[order[a]] < cv.keys[order[b]] })
		sortedKeys := make([]string, len(cv.keys))
		sortedVals := make([]*canonicalValue, len(cv.vals))
		for i, oi := range order {
			sortedKeys[i] = cv.keys[oi]
			sortedVals[i] = cv.vals[oi]
		}
		cv.keys, cv.vals = sortedKeys, sortedVals
		return cv, nil
	case []any:
		cv := &canonicalValue{kind: 'a'}
		for _, item := range t {
			nested, err := convertCanonical(item)
			if err != nil {
				return nil, err
			}
			cv.items = append(cv.items, nested)
		}
		return cv, nil
	case string:
		enc, err := jsonQuote(t)
		if err != nil {
			return nil, err
		}
		return &canonicalValue{kind: 's', scalar: enc}, nil
	case json.Number:
		return &canonicalValue{kind: 'l', scalar: t.String()}, nil
	case bool:
		if t {
			return &canonicalValue{kind: 'l', scalar: "true"}, nil
		}
		return &canonicalValue{kind: 'l', scalar: "false"}, nil
	case nil:
		return &canonicalValue{kind: 'l', scalar: "null"}, nil
	default:
		return nil, fmt.Errorf("canonical: unsupported JSON type %T", v)
	}
}

func writeCanonicalValue(buf *bytes.Buffer, v *canonicalValue) error {
	switch v.kind {
	case 'o':
		buf.WriteByte('{')
		for i, k := range v.keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			enc, err := jsonQuote(k)
			if err != nil {
				return err
			}
			buf.WriteString(enc)
			buf.WriteByte(':')
			if err := writeCanonicalValue(buf, v.vals[i]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case 'a':
		buf.WriteByte('[')
		for i, item := range v.items {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonicalValue(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		buf.WriteString(v.scalar)
	}
	return nil
}
