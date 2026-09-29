package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"simple-one-api/pkg/config"
	"simple-one-api/pkg/utils"
)

// ProviderProbe is an unsaved setup draft. Probes never publish configuration
// or enter normal routing, key-pool scheduling, or usage statistics.
type ProviderProbe struct {
	Provider  string `json:"provider"`
	Protocol  string `json:"upstream_protocol"`
	ServerURL string `json:"server_url"`
	APIKey    string `json:"api_key"`
	Model     string `json:"model"`
}

type ProviderProbeResult struct {
	OK             bool   `json:"ok"`
	Code           string `json:"code"`
	Message        string `json:"message"`
	UpstreamStatus int    `json:"upstream_status,omitempty"`
	LatencyMS      int64  `json:"latency_ms"`
}

const probeTimeout = 20 * time.Second
const probeResponseLimit = 1 << 20

// ProbeProvider sends one small, non-streaming generation request from the
// server. Only static diagnostic messages leave this function: upstream errors
// and URLs may contain credentials and must not be echoed or logged.
func ProbeProvider(ctx context.Context, draft ProviderProbe) (result ProviderProbeResult) {
	started := time.Now()
	defer func() { result.LatencyMS = time.Since(started).Milliseconds() }()
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, protocol, err := providerProbeRequest(ctx, draft)
	if err != nil {
		return probeFailure("invalid_config", err.Error())
	}
	var transport *http.Transport
	if config.IsProxyEnabled(&config.ModelDetails{}) {
		_, _, transport, err = config.GetConfProxyTransport()
		if err != nil {
			return probeFailure("proxy", "服务器代理配置不可用，请在配置台检查代理设置。")
		}
		defer transport.CloseIdleConnections()
	}
	client := utils.NewHTTPClient(transport, probeTimeout)
	// Never forward a draft key to a redirect target, even on the same host.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return probeNetworkFailure(ctx, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, probeResponseLimit+1))
	if err != nil {
		return probeNetworkFailure(ctx, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result = probeHTTPFailure(resp.StatusCode, body)
		result.UpstreamStatus = resp.StatusCode
		return result
	}
	if len(body) > probeResponseLimit || !validProbeResponse(protocol, body) {
		return probeFailure("invalid_response", "上游未返回有效的模型响应，请检查服务地址和上游协议是否匹配。")
	}
	return ProviderProbeResult{OK: true, Code: "ok", Message: "测试模型已成功响应。此结果只验证当前地址、协议、密钥和第一个模型。", UpstreamStatus: resp.StatusCode}
}

func providerProbeRequest(ctx context.Context, draft ProviderProbe) (*http.Request, string, error) {
	base := strings.TrimSpace(draft.ServerURL)
	parsed, err := url.Parse(base)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, "", errors.New("请填写不含用户名、密码、查询参数或片段的 HTTP(S) 服务地址。")
	}
	model := strings.TrimSpace(draft.Model)
	if model == "" || len(model) > 512 {
		return nil, "", errors.New("请填写有效的测试模型名称。")
	}
	protocol := strings.TrimSpace(draft.Protocol)
	if protocol == "" || protocol == config.UpstreamProtocolAuto {
		switch draft.Provider {
		case "openai", "deepseek", "groq":
			protocol = config.UpstreamProtocolChatCompletions
		case "claude":
			protocol = config.UpstreamProtocolAnthropicMessages
		case "ollama":
			protocol = "ollama"
		default:
			return nil, "", errors.New("此 Provider 的自动协议暂不支持向导测试，请在配置台完成接入。")
		}
	}
	key := strings.TrimSpace(draft.APIKey)
	if strings.ContainsAny(key, "\r\n") {
		return nil, "", errors.New("上游 API Key 不能包含换行符。")
	}
	if key == "" && draft.Provider != "ollama" {
		return nil, "", errors.New("请填写上游 API Key。")
	}
	messages := []map[string]string{{"role": "user", "content": "Reply with OK."}}
	payload := map[string]any{"model": model, "stream": false}
	endpoint := base
	switch protocol {
	case config.UpstreamProtocolChatCompletions:
		formatted, _ := validateAndFormatURL(base)
		endpoint = strings.TrimRight(formatted, "/") + "/chat/completions"
		payload["messages"] = messages
		if strings.HasPrefix(model, "o1") || strings.HasPrefix(model, "o3") || strings.HasPrefix(model, "o4") || strings.HasPrefix(model, "gpt-5") {
			payload["max_completion_tokens"] = 32
		} else {
			payload["max_tokens"] = 32
		}
	case config.UpstreamProtocolResponses:
		endpoint = responsesEndpoint(base)
		payload["input"] = "Reply with OK."
		payload["max_output_tokens"] = 32
		payload["store"] = false
	case config.UpstreamProtocolAnthropicMessages:
		payload["messages"] = messages
		payload["max_tokens"] = 32
	case "ollama":
		payload["messages"] = messages
		payload["options"] = map[string]int{"num_predict": 32}
	default:
		return nil, "", errors.New("上游协议不受支持。")
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", errors.New("无法创建请求，请检查服务地址。")
	}
	req.Header.Set("Content-Type", "application/json")
	if protocol == config.UpstreamProtocolAnthropicMessages {
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return req, protocol, nil
}

func probeFailure(code, message string) ProviderProbeResult {
	return ProviderProbeResult{Code: code, Message: message}
}

func probeNetworkFailure(ctx context.Context, err error) ProviderProbeResult {
	var netErr net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return probeFailure("timeout", "连接测试超时（最长 20 秒），请检查网络、代理或模型是否仍在加载。")
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return probeFailure("cancelled", "连接测试已取消。")
	}
	return probeFailure("network", "服务器无法连接上游，请检查服务地址、DNS、TLS 证书、防火墙和代理。Docker 内的 127.0.0.1 指向容器自身。")
}

func probeHTTPFailure(status int, body []byte) ProviderProbeResult {
	switch {
	case status == 401 || status == 403:
		return probeFailure("authentication", "上游拒绝访问，请检查上游 API Key、账户权限及模型授权。")
	case status == 429:
		return probeFailure("rate_limit", "上游限流或配额不足，请检查供应商额度并稍后重试。")
	case status >= 300 && status < 400:
		return probeFailure("redirect", "上游返回重定向，请直接填写最终 API 地址后重试。")
	case status >= 500:
		return probeFailure("upstream", "上游服务暂时异常，请稍后重试。")
	}
	// Use the error only to classify it, never expose arbitrary upstream text.
	lower := strings.ToLower(string(body))
	if strings.Contains(lower, "model") && (strings.Contains(lower, "not_found") || strings.Contains(lower, "not found") || strings.Contains(lower, "does not exist")) {
		return probeFailure("model", "上游未找到测试模型，请核对模型名称、下载状态和账户权限。")
	}
	if status == 404 {
		return probeFailure("not_found", "上游地址或模型不存在，请检查 API 路径和模型名称。")
	}
	return probeFailure("request", "上游拒绝测试请求，请检查协议、模型名称及该模型支持的参数。")
}

func validProbeResponse(protocol string, body []byte) bool {
	var result struct {
		Error   json.RawMessage `json:"error"`
		Choices []struct {
			Message *struct {
				Role string `json:"role"`
			} `json:"message"`
		} `json:"choices"`
		Object  string            `json:"object"`
		Status  string            `json:"status"`
		Output  []json.RawMessage `json:"output"`
		Type    string            `json:"type"`
		Role    string            `json:"role"`
		Content []json.RawMessage `json:"content"`
		Done    bool              `json:"done"`
		Message *struct {
			Role string `json:"role"`
		} `json:"message"`
	}
	if json.Unmarshal(body, &result) != nil || (len(result.Error) > 0 && string(result.Error) != "null") {
		return false
	}
	switch protocol {
	case config.UpstreamProtocolChatCompletions:
		return len(result.Choices) > 0 && result.Choices[0].Message != nil && result.Choices[0].Message.Role == "assistant"
	case config.UpstreamProtocolResponses:
		return result.Object == "response" && (result.Status == "completed" || result.Status == "incomplete") && result.Output != nil
	case config.UpstreamProtocolAnthropicMessages:
		return result.Type == "message" && result.Role == "assistant" && result.Content != nil
	case "ollama":
		return result.Done && result.Message != nil && result.Message.Role == "assistant"
	}
	return false
}
