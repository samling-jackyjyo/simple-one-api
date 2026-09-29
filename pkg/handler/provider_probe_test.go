package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"simple-one-api/pkg/config"
)

func TestProbeProviderProtocols(t *testing.T) {
	previous := *config.CurrentConfiguration()
	t.Cleanup(func() { _ = config.ApplyConfiguration(previous, "test.json") })
	if err := config.ApplyConfiguration(config.Configuration{}, "test.json"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, provider, protocol, path, response, tokenField string }{
		{"chat", "openai", "auto", "/v1/chat/completions", `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`, "max_tokens"},
		{"responses", "openai", "responses", "/v1/responses", `{"object":"response","status":"completed","output":[]}`, "max_output_tokens"},
		{"claude", "claude", "auto", "/v1/messages", `{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}`, "max_tokens"},
		{"ollama", "ollama", "auto", "/api/chat", `{"done":true,"message":{"role":"assistant","content":"OK"}}`, "options"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != tc.path || r.Method != http.MethodPost {
					t.Errorf("unexpected target: %s %s", r.Method, r.URL.Path)
				}
				if tc.provider == "claude" {
					if r.Header.Get("x-api-key") != "probe-key" || r.Header.Get("anthropic-version") != "2023-06-01" {
						t.Error("missing Claude authentication")
					}
				} else if r.Header.Get("Authorization") != "Bearer probe-key" {
					t.Error("missing upstream authentication")
				}
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if payload["model"] != "test-model" || payload["stream"] != false || payload[tc.tokenField] == nil {
					t.Errorf("unexpected probe: %#v", payload)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tc.response)
			}))
			defer upstream.Close()
			endpoint := upstream.URL + "/v1"
			if tc.provider == "claude" || tc.provider == "ollama" {
				endpoint = upstream.URL + tc.path
			}
			before := config.CurrentConfiguration()
			result := ProbeProvider(context.Background(), ProviderProbe{Provider: tc.provider, Protocol: tc.protocol, ServerURL: endpoint, Model: "test-model", APIKey: "probe-key"})
			if !result.OK || result.Code != "ok" || calls != 1 {
				t.Fatalf("probe failed: %+v, calls %d", result, calls)
			}
			if !reflect.DeepEqual(config.CurrentConfiguration(), before) {
				t.Fatal("probe published configuration")
			}
		})
	}
}

func TestProbeFailuresDoNotExposeUpstreamSecrets(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, code string
	}{
		{401, `{"error":"secret-probe-key"}`, "authentication"},
		{403, `secret-probe-key`, "authentication"},
		{404, `{"error":{"code":"model_not_found","message":"secret-probe-key"}}`, "model"},
		{404, `secret-probe-key`, "not_found"},
		{429, `secret-probe-key`, "rate_limit"},
		{500, `secret-probe-key`, "upstream"},
		{400, `secret-probe-key`, "request"},
		{200, `<html>secret-probe-key</html>`, "invalid_response"},
		{200, `{"error":"secret-probe-key","choices":[{}]}`, "invalid_response"},
		{200, `{}`, "invalid_response"},
		{200, strings.Repeat("x", probeResponseLimit+1), "invalid_response"},
	} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = io.WriteString(w, tc.body)
		}))
		result := ProbeProvider(context.Background(), ProviderProbe{Provider: "openai", ServerURL: upstream.URL, Model: "test", APIKey: "secret-probe-key"})
		upstream.Close()
		if result.OK || result.Code != tc.code {
			t.Fatalf("status %d: %+v, want %s", tc.status, result, tc.code)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "secret-probe-key") {
			t.Fatal("probe leaked upstream content")
		}
	}
}

func TestProbeRejectsRedirectsAndRespectsCancellation(t *testing.T) {
	forwarded := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	draft := ProviderProbe{Provider: "openai", ServerURL: redirect.URL, Model: "test", APIKey: "probe-key"}
	result := ProbeProvider(context.Background(), draft)
	if result.Code != "redirect" || forwarded {
		t.Fatalf("redirect followed: %+v", result)
	}

	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer slow.Close()
	defer close(release)
	draft.ServerURL = slow.URL
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if result := ProbeProvider(ctx, draft); result.Code != "timeout" {
		t.Fatalf("timeout not classified: %+v", result)
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	if result := ProbeProvider(ctx, draft); result.Code != "cancelled" {
		t.Fatalf("cancellation not classified: %+v", result)
	}
}

func TestProbeInvalidDraftMakesNoRequest(t *testing.T) {
	for _, endpoint := range []string{"file:///tmp/config", "http://user:secret@example.com", "https://example.com?api_key=secret", "https://example.com#fragment", ""} {
		result := ProbeProvider(context.Background(), ProviderProbe{Provider: "openai", ServerURL: endpoint, Model: "test", APIKey: "probe-key"})
		if result.Code != "invalid_config" {
			t.Fatalf("invalid URL accepted: %+v", result)
		}
	}
}
