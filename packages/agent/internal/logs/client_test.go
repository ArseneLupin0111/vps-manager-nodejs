package logs

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/config"
)

func testClient(srv *httptest.Server) *Client {
	return NewClientWithHTTPAndToken(srv.URL, "test-token", srv.Client(), srv.Client())
}

func testSubID() string {
	return "1111111111111111111111111111111111111111111111111111111111112222"
}

func TestClient_ClaimSuccess(t *testing.T) {
	instID := "testinst000000000000000000000001"
	subID := testSubID()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != logsClaimPath {
			t.Errorf("path = %q, want %q", r.URL.Path, logsClaimPath)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", got)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), instID) {
			t.Errorf("body missing instance ID: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":{"subscription":{"subscriptionId":%q,"vpsId":"vps-1","agentInstanceId":%q,"containerKey":"ckey1","tailLines":200,"expiresAt":"2026-10-10T12:00:00Z"}}}`, subID, instID)
	}))
	defer srv.Close()

	c := testClient(srv)
	sub, err := c.Claim(context.Background(), instID)
	if err != nil {
		t.Fatalf("Claim failed: %v", err)
	}
	if sub == nil {
		t.Fatal("expected claimed subscription, got nil")
	}
	if sub.SubscriptionID != subID || sub.AgentInstanceID != instID {
		t.Fatalf("unexpected sub: %#v", sub)
	}
}

func TestClient_ClaimNull(t *testing.T) {
	instID := "testinst000000000000000000000001"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":{"subscription":null}}`)
	}))
	defer srv.Close()

	c := testClient(srv)
	sub, err := c.Claim(context.Background(), instID)
	if err != nil {
		t.Fatalf("Claim failed: %v", err)
	}
	if sub != nil {
		t.Fatalf("expected nil subscription, got %#v", sub)
	}
}

func TestClient_ClaimInstanceMismatchFails(t *testing.T) {
	instID := "testinst000000000000000000000001"
	otherInst := "otherinst00000000000000000000002"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":{"subscription":{"subscriptionId":%q,"vpsId":"vps-1","agentInstanceId":%q,"containerKey":"ckey1","tailLines":200,"expiresAt":"2026-10-10T12:00:00Z"}}}`, testSubID(), otherInst)
	}))
	defer srv.Close()

	c := testClient(srv)
	_, err := c.Claim(context.Background(), instID)
	if err == nil || !strings.Contains(err.Error(), "instance mismatch") {
		t.Fatalf("expected instance mismatch error, got %v", err)
	}
}

func TestClient_StatusMapping(t *testing.T) {
	cases := []struct {
		status int
		body   string
		check  func(error) bool
		name   string
	}{
		{401, `{"error":"unauthorized"}`, IsAuth, "auth-401"},
		{403, `{"error":"forbidden"}`, IsAuth, "auth-403"},
		{404, `{"error":"not found"}`, IsGone, "gone-404"},
		{410, `{"error":"gone"}`, IsGone, "gone-410"},
		{409, `{"error":"conflict"}`, IsConflict, "conflict-409"},
		{400, `{"error":"bad request"}`, IsFatal, "fatal-400"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			c := testClient(srv)
			_, err := c.PostChunks(context.Background(), testSubID(), ChunksRequest{
				AgentInstanceID: "testinst000000000000000000000001",
				Sequence:        1,
				Ready:           true,
				Lines:           []LogLine{},
			})
			if err == nil || !tc.check(err) {
				t.Fatalf("status %d returned error %v, expected matcher true", tc.status, err)
			}
		})
	}
}

func TestClient_PostChunksSuccessAndEchoCheck(t *testing.T) {
	instID := "testinst000000000000000000000001"
	subID := testSubID()
	var capturedBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantPath := logsBasePath + "/" + subID + logsChunksSuffix
		if r.URL.Path != wantPath {
			t.Errorf("path = %q, want %q", r.URL.Path, wantPath)
		}
		var err error
		capturedBody, err = io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":{"ok":true,"subscriptionId":%q,"sequence":42}}`, subID)
	}))
	defer srv.Close()

	c := testClient(srv)
	resp, err := c.PostChunks(context.Background(), subID, ChunksRequest{
		AgentInstanceID: instID,
		Sequence:        42,
		Ready:           true,
		Lines:           []LogLine{{Stream: StreamStdout, Text: "hello <world> & all", Truncated: false}},
	})
	if err != nil {
		t.Fatalf("PostChunks failed: %v", err)
	}
	if !resp.Data.OK || resp.Data.Sequence != 42 || resp.Data.SubscriptionID != subID {
		t.Fatalf("unexpected chunks resp: %#v", resp)
	}

	// Verify literal '<', '>', '&' survive without HTML escaping in captured request body
	if !strings.Contains(string(capturedBody), "<world>") {
		t.Fatalf("expected literal <world> without HTML escaping in wire body: %s", string(capturedBody))
	}
}

func TestClient_PostChunksEchoMismatchFails(t *testing.T) {
	subID := testSubID()
	// Sequence mismatch from broker
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":{"ok":true,"subscriptionId":%q,"sequence":99}}`, subID)
	}))
	defer srv.Close()

	c := testClient(srv)
	_, err := c.PostChunks(context.Background(), subID, ChunksRequest{
		AgentInstanceID: "testinst000000000000000000000001",
		Sequence:        1,
		Ready:           true,
		Lines:           []LogLine{},
	})
	if err == nil || !strings.Contains(err.Error(), "sequence echo mismatch") {
		t.Fatalf("expected sequence echo mismatch, got %v", err)
	}
}

func TestClient_PostResultSuccessAndEchoCheck(t *testing.T) {
	instID := "testinst000000000000000000000001"
	subID := testSubID()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantPath := logsBasePath + "/" + subID + logsResultSuffix
		if r.URL.Path != wantPath {
			t.Errorf("path = %q, want %q", r.URL.Path, wantPath)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":{"ok":true,"subscriptionId":%q,"agentInstanceId":%q}}`, subID, instID)
	}))
	defer srv.Close()

	c := testClient(srv)
	resp, err := c.PostResult(context.Background(), subID, ResultRequest{
		AgentInstanceID: instID,
		Status:          ResultCompleted,
	})
	if err != nil {
		t.Fatalf("PostResult failed: %v", err)
	}
	if !resp.Data.OK || resp.Data.SubscriptionID != subID || resp.Data.AgentInstanceID != instID {
		t.Fatalf("unexpected result resp: %#v", resp)
	}
}

func TestClient_PostResultEchoMismatchFails(t *testing.T) {
	instID := "testinst000000000000000000000001"
	subID := testSubID()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":{"ok":true,"subscriptionId":%q,"agentInstanceId":"wronginst00000000000000000001"}}`, subID)
	}))
	defer srv.Close()

	c := testClient(srv)
	_, err := c.PostResult(context.Background(), subID, ResultRequest{
		AgentInstanceID: instID,
		Status:          ResultCompleted,
	})
	if err == nil || !strings.Contains(err.Error(), "instance echo mismatch") {
		t.Fatalf("expected instance echo mismatch error, got %v", err)
	}
}

func TestClient_OversizeResponseRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Send oversize response > 32 KiB
		w.Write([]byte(`{"data":{"subscription":null},"padding":"` + strings.Repeat("x", MaxBodyBytes+100) + `"}`))
	}))
	defer srv.Close()

	c := testClient(srv)
	_, err := c.Claim(context.Background(), "testinst000000000000000000000001")
	if err == nil || !strings.Contains(err.Error(), "oversize") {
		t.Fatalf("expected oversize rejection error, got %v", err)
	}
}

func TestClient_TrailingJSONRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"subscription":null}} trailing junk`))
	}))
	defer srv.Close()

	c := testClient(srv)
	_, err := c.Claim(context.Background(), "testinst000000000000000000000001")
	if err == nil {
		t.Fatal("expected trailing junk to be rejected fail-closed")
	}
}

func TestClient_SanitizeBody(t *testing.T) {
	input := "failed with token vma_secret1234567890abcdef and more info"
	got := sanitizeBody(input)
	if strings.Contains(got, "vma_secret") {
		t.Fatalf("token was not redacted: %q", got)
	}
	if !strings.Contains(got, "[redacted]") {
		t.Fatalf("missing [redacted]: %q", got)
	}

	long := strings.Repeat("a", 300)
	gotLong := sanitizeBody(long)
	if len(gotLong) > 203 {
		t.Fatalf("long body was not capped: len=%d", len(gotLong))
	}
	if !strings.HasSuffix(gotLong, "...") {
		t.Fatalf("long body should end in ...: %q", gotLong)
	}
}

func TestClient_UploadTimeoutCapped(t *testing.T) {
	cfg := &config.Config{
		BackendUrl:            "http://localhost:3000",
		Token:                 "test-token",
		RequestTimeoutSeconds: 60, // large timeout
	}
	c := NewClient(cfg)
	if c.uploadHTTP.Timeout != MaxUploadTimeout {
		t.Fatalf("upload timeout = %v, want capped %v", c.uploadHTTP.Timeout, MaxUploadTimeout)
	}
	if c.claimHTTP.Timeout != 60*time.Second {
		t.Fatalf("claim timeout = %v, want 60s", c.claimHTTP.Timeout)
	}
}
