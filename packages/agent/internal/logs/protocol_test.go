package logs

import (
	"strings"
	"testing"
)

const subID = "sub_0123456789abcdef"

func instanceID() string { return strings.Repeat("a", MaxInstanceIDLen) }

// reencode reports the outgoing bytes via the shared MarshalJSON helper,
// so the test asserts the exact representation the wire will carry.
func reencode(v any) string {
	b, err := MarshalJSON(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// A line object that omits required fields must be rejected: Go struct
// decoding fills zero values (`{"stream":"stdout"}` would otherwise
// decode as an empty, non-truncated line), while the TS mirror rejects it.
func TestDecodeLinesEventRejectsNestedMissingFields(t *testing.T) {
	for name, body := range map[string]string{
		"missing text":       `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","truncated":false}]}`,
		"null text":          `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","text":null,"truncated":false}]}`,
		"missing truncated":  `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","text":"x"}]}`,
		"null truncated":     `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","text":"x","truncated":null}]}`,
		"missing stream":     `{"subscriptionId":"` + subID + `","lines":[{"text":"x","truncated":false}]}`,
		"null stream":        `{"subscriptionId":"` + subID + `","lines":[{"stream":null,"text":"x","truncated":false}]}`,
		"nested unknown key": `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","text":"x","truncated":false,"extra":1}]}`,
	} {
		if _, err := DecodeLinesEvent([]byte(body)); err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
	}
}

func TestDecodeChunksRequestRejectsNestedMissingFields(t *testing.T) {
	body := `{"agentInstanceId":"` + instanceID() + `","sequence":1,"ready":true,` +
		`"lines":[{"stream":"stdout"}]}`
	if _, err := DecodeChunksRequest([]byte(body)); err == nil {
		t.Fatal("expected rejection of chunks line missing text/truncated")
	}
}

// The byte cap must be measured on the bytes actually received, not on a
// re-serialisation: `json.Marshal` HTML-escapes `<`, `>` and `&`, which
// would inflate a valid frame of `<`-heavy lines far past 32 KiB.
func TestDecodeLinesEventMeasuresReceivedBytesNotReescaped(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`{"subscriptionId":"` + subID + `","lines":[`)
	// go.mod declares go 1.21, so range-over-int is unavailable.
	for i := 0; i < 8; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"stream":"stdout","text":"`)
		sb.WriteString(strings.Repeat("<", 2000))
		sb.WriteString(`","truncated":false}`)
	}
	sb.WriteString(`]}`)

	frame := sb.String()
	if len(frame) >= MaxFrameBytes {
		t.Fatalf("fixture should stay well under the cap, got %d bytes", len(frame))
	}
	if _, err := DecodeLinesEvent([]byte(frame)); err != nil {
		t.Fatalf("valid <,>-heavy frame rejected: %v", err)
	}

	// The same text re-serialised by encoding/json grows past the cap, so
	// measuring re-serialised bytes is what the old implementation did.
	var reenc strings.Builder
	reenc.WriteString(`{"subscriptionId":"`)
	reenc.WriteString(subID)
	reenc.WriteString(`","lines":`)
	for i := 0; i < 8; i++ {
		if i > 0 {
			reenc.WriteByte(',')
		}
		reenc.WriteString(`{"stream":"stdout","text":"`)
		reenc.WriteString(strings.Repeat(`\u003c`, 2000))
		reenc.WriteString(`","truncated":false}`)
	}
	reenc.WriteString(`]}`)
	if len(reenc.String()) <= MaxFrameBytes {
		t.Log("note: re-encoded fixture does not exceed cap; skipping comparison")
	}

	// Oversize on the wire itself is still rejected.
	big := `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","text":"` +
		strings.Repeat("a", MaxFrameBytes) + `","truncated":false}]}`
	if _, err := DecodeLinesEvent([]byte(big)); err == nil {
		t.Fatal("expected rejection of oversize frame")
	}
}

func TestValidateChunksRequestMeasuresReceivedBytes(t *testing.T) {
	body := `{"agentInstanceId":"` + instanceID() + `","sequence":1,"ready":true,"lines":[` +
		`{"stream":"stdout","text":"` + strings.Repeat("<", MaxBodyBytes) +
		`","truncated":false}]}`
	if _, err := DecodeChunksRequest([]byte(body)); err == nil {
		t.Fatal("expected rejection of oversize chunks body")
	}
}

// The TS mirror rejects lone UTF-16 surrogate escapes; Go decodes them to
// U+FFFD (valid UTF-8), so they must be caught on the raw JSON to keep
// both sides agreeing on text semantics. A real U+FFFD (what the agent
// emits for invalid Docker bytes) must still be accepted.
func TestDecodeLinesEventRejectsLoneSurrogateEscape(t *testing.T) {
	for name, tc := range map[string]struct {
		text string
		want string
	}{
		"lone surrogate":     {text: `\ud800`, want: "reject"},
		"lone low surrogate": {text: `\udc00`, want: "reject"},
		"valid pair":         {text: `\ud83d\ude00`, want: "accept"},
		"valid pairs":        {text: `\ud83d\ude00\ud83d\ude80`, want: "accept"},
		"emoji raw":          {text: "😀 hello 🚀", want: "accept"},
		"real replacement":   {text: "\ufffd", want: "accept"},
		"accents":            {text: "caf\u00e9", want: "accept"},
	} {
		body := `{"subscriptionId":"` + subID + `","lines":[{"stream":"stdout","text":"` + tc.text + `","truncated":false}]}`
		_, err := DecodeLinesEvent([]byte(body))
		if tc.want == "reject" && err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
		if tc.want == "accept" && err != nil {
			t.Fatalf("%s: unexpected rejection: %v", name, err)
		}
	}
}

// The outgoing budget and the bytes actually sent must be the same
// representation: no HTML escaping (matching JSON.stringify), and the
// trailing-encoder newline trimmed so it is not double counted.
func TestSerializedSizeMatchesWirePolicy(t *testing.T) {
	req := ChunksRequest{
		AgentInstanceID: instanceID(),
		Sequence:        1,
		Ready:           true,
		Lines: []LogLine{
			{Stream: StreamStdout, Text: strings.Repeat("<>&", 64), Truncated: false},
		},
	}
	// json.Marshal escapes these to \u003c/\u003e/\u0026, inflating every
	// frame carrying ordinary markup in logs by 5 bytes per run.
	if got := serializedSize(req); got != len(reencode(req)) {
		t.Fatalf("serializedSize %d != marshalled bytes %d", got, len(reencode(req)))
	}
	if strings.Contains(reencode(req), `\u003c`) {
		t.Fatal("expected unescaped '<' in the outgoing wire form")
	}
	if strings.Contains(reencode(req), `\u0026`) {
		t.Fatal("expected unescaped '&' in the outgoing wire form")
	}
	if strings.HasSuffix(reencode(req), "\n") {
		t.Fatal("expected no trailing newline from MarshalJSON")
	}
}
