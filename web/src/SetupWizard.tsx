import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AdminRequestError,
  getConfigDraft,
  publishConfig,
  testProvider,
  validateConfig,
  type ProviderTestResult,
  type ValidationIssue,
} from "./api/admin";
import { asConfiguration, stringList, upstreamProtocols, type AppConfiguration, type UpstreamProtocol } from "./configuration";
import { buildSetupConfiguration, generateGatewayKey, type SetupValues } from "./setup";
import { randomID } from "./randomID";

interface SetupWizardProps {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  onComplete: () => void;
}

const providerPresets: Array<{ value: string; label: string; url: string; protocol: UpstreamProtocol }> = [
  { value: "openai", label: "OpenAI / OpenAI 兼容", url: "https://api.openai.com/v1", protocol: "auto" },
  { value: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1", protocol: "auto" },
  { value: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", protocol: "auto" },
  { value: "claude", label: "Anthropic Claude", url: "https://api.anthropic.com/v1/messages", protocol: "anthropic_messages" },
  { value: "ollama", label: "Ollama（本机）", url: "http://127.0.0.1:11434/api/chat", protocol: "auto" },
];

const initialValues: SetupValues = {
  gatewayKey: "",
  configureProvider: true,
  provider: "openai",
  providerName: "",
  serverURL: providerPresets[0].url,
  upstreamProtocol: providerPresets[0].protocol,
  models: "",
  upstreamKey: "",
};

export function SetupWizard({ apiKey, onApiKeyChange, onComplete }: SetupWizardProps) {
  const [base, setBase] = useState<AppConfiguration>({});
  const [values, setValues] = useState<SetupValues>(initialValues);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [adminCredential, setAdminCredential] = useState(apiKey);
  const [confirmKey, setConfirmKey] = useState("");
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyNotice, setKeyNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ signature: string; result: ProviderTestResult } | null>(null);
  const probeController = useRef<AbortController | null>(null);
  const probeDraft = {
    provider: values.provider,
    upstream_protocol: values.upstreamProtocol,
    server_url: values.serverURL.trim(),
    api_key: values.upstreamKey.trim(),
    model: stringList(values.models)[0] ?? "",
  };
  const probeSignature = JSON.stringify(probeDraft);
  const currentTest = testResult?.signature === probeSignature ? testResult.result : null;

  useEffect(() => {
    void loadDraft(apiKey);
    // The credential is intentionally captured only on first load. During
    // setup it changes from the bootstrap token to the permanent gateway key.
    return () => probeController.current?.abort();
  }, []);

  async function loadDraft(credential: string) {
    setLoading(true);
    setDraftReady(false);
    setError("");
    try {
      const draft = await getConfigDraft(credential);
      const configuration = asConfiguration(draft.config);
      if (configuration.api_key?.trim()) {
        // Another tab may have completed setup since the public status check.
        onComplete();
        return false;
      }
      setBase(configuration);
      setValues((current) => ({
        ...current,
        gatewayKey: typeof configuration.api_key === "string" && !configuration.api_key.startsWith("__SIMPLE_ONE_REDACTED__")
          ? configuration.api_key
          : "",
      }));
      setBootstrapRequired(false);
      setAdminCredential(credential);
      setDraftReady(true);
      return true;
    } catch (reason) {
      if (reason instanceof AdminRequestError && reason.code === "admin_bootstrap_required") {
        setBootstrapRequired(true);
        if (credential.trim()) setError("临时初始化密钥不正确，请从当前服务启动日志重新复制。");
      } else {
        setError(reason instanceof Error ? reason.message : "无法读取初始化配置");
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function unlock() {
    const token = bootstrapToken.trim();
    if (!token) {
      setError("请输入服务启动日志中的临时初始化密钥。");
      return;
    }
    if (await loadDraft(token)) {
      onApiKeyChange(token);
      setBootstrapToken("");
    }
  }

  function generateKey() {
    const key = generateGatewayKey();
    setValues((current) => ({ ...current, gatewayKey: key }));
    setConfirmKey(key);
    setShowKey(true);
    setKeyNotice("已生成随机主密钥，请复制并妥善保存。");
  }

  async function copyKey() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(values.gatewayKey);
      setKeyNotice("主密钥已复制。");
    } catch {
      setShowKey(true);
      setKeyNotice("浏览器无法自动复制，请选中主密钥手动复制。");
    }
  }

  function continueToProvider() {
    const gatewayKey = values.gatewayKey.trim();
    if (gatewayKey.length < 16) {
      setError("网关主密钥至少需要 16 个字符，建议使用随机生成的密钥。");
      return;
    }
    if (gatewayKey !== confirmKey.trim()) {
      setError("两次输入的网关主密钥不一致。");
      return;
    }
    setError("");
    setStep(2);
  }

  function selectProvider(provider: string) {
    const preset = providerPresets.find((item) => item.value === provider) ?? providerPresets[0];
    setValues((current) => ({
      ...current,
      provider,
      serverURL: preset.url,
      upstreamProtocol: preset.protocol,
    }));
  }

  function providerError(): string {
    if (!values.configureProvider) return "";
    if (!values.serverURL.trim()) return "请填写上游服务地址。";
    try {
      const parsed = new URL(values.serverURL.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) return "上游服务地址必须使用 HTTP 或 HTTPS。";
    } catch {
      return "上游服务地址格式不正确。";
    }
    if (!stringList(values.models).length) return "请至少填写一个聊天模型。";
    if (values.provider !== "ollama" && !values.upstreamKey.trim()) return "请填写上游 API Key。";
    return "";
  }

  async function checkProvider() {
    const localError = providerError();
    if (localError) { setError(localError); return; }
    setError("");
    setTestResult(null);
    setTesting(true);
    const controller = new AbortController();
    probeController.current = controller;
    try {
      const result = await testProvider(adminCredential, probeDraft, controller.signal);
      if (!controller.signal.aborted) setTestResult({ signature: probeSignature, result });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法完成连接测试");
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  }

  async function finishSetup() {
    if (!draftReady || testing || saving) return;
    const localError = providerError();
    if (localError) {
      setError(localError);
      return;
    }
    setSaving(true);
    setError("");
    setIssues([]);
    try {
      const next = buildSetupConfiguration(base, values, randomID());
      const validation = await validateConfig(adminCredential, next);
      setIssues(validation.issues ?? []);
      if (!validation.valid) {
        setError("配置校验未通过，请检查下面的提示。");
        return;
      }
      await publishConfig(adminCredential, next, "首次初始化向导");
      onApiKeyChange(values.gatewayKey.trim());
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "初始化配置保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="setup-shell"><div className="setup-loading">正在读取初始化状态…</div></div>;
  }

  if (bootstrapRequired) {
    return (
      <div className="setup-shell">
        <section className="setup-unlock-card">
          <div className="setup-hero-mark"><LockKeyhole size={28} /></div>
          <div>
            <span className="setup-eyebrow">首次部署安全校验</span>
            <h1>输入临时初始化密钥</h1>
            <p>远程服务器需要先验证启动日志中的 bootstrap token。验证后即可设置永久主密钥，临时密钥会随之失效。</p>
          </div>
          {error && <div className="setup-alert error" role="alert">{error}</div>}
          <label className="setup-field">
            <span>临时初始化密钥</span>
            <input type="password" autoComplete="off" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void unlock(); }} placeholder="粘贴服务启动日志中的 token" autoFocus />
          </label>
          <button className="primary-button setup-wide-button" onClick={() => void unlock()}><LockKeyhole size={16} />验证并继续</button>
          <code className="setup-log-hint">Admin temporary bootstrap token: …</code>
        </section>
      </div>
    );
  }

  if (!draftReady) {
    return <div className="setup-shell"><section className="setup-unlock-card">
      <h1>暂时无法读取初始化配置</h1>
      <div className="setup-alert error" role="alert">{error || "请检查服务器连接后重试。"}</div>
      <button className="primary-button" onClick={() => void loadDraft(adminCredential)}>重新读取配置</button>
      <button className="secondary-button" onClick={() => window.location.reload()}>刷新初始化状态</button>
    </section></div>;
  }

  return (
    <div className="setup-shell">
      <header className="setup-brand"><span className="brand-mark">S</span><span className="brand-name">Simple One <small>API</small></span></header>
      <main className="setup-card">
        <div className="setup-intro">
          <span className="setup-eyebrow">服务器首次初始化</span>
          <h1>{step === 1 ? "保护你的网关" : step === 2 ? "连接第一个模型服务" : "初始化完成"}</h1>
          <p>{step === 1 ? "创建用于管理后台和 API 调用的永久主密钥。" : step === 2 ? "填写最少的信息即可开始使用，更多 Provider 和限流可以稍后配置。" : "配置已保存并立即生效，可以进入管理台继续调整。"}</p>
        </div>

        <ol className="setup-steps" aria-label="初始化进度">
          {([[1, "安全"], [2, "Provider"], [3, "完成"]] as const).map(([number, label]) => (
            <li key={number} className={step === number ? "active" : step > number ? "complete" : ""}>
              <span>{step > number ? <Check size={14} /> : number}</span><strong>{label}</strong>
            </li>
          ))}
        </ol>

        {error && <div className="setup-alert error" role="alert">{error}</div>}
        {issues.length > 0 && <div className="setup-issues">{issues.map((issue) => <div key={`${issue.path}-${issue.message}`}><code>{issue.path}</code><span>{issue.message}</span></div>)}</div>}

        {step === 1 && (
          <section className="setup-form-section">
            <div className="setup-section-heading"><ShieldCheck size={21} /><div><h2>网关主密钥</h2><p>浏览器只会在当前会话保存它，请妥善保管。</p></div></div>
            <label className="setup-field">
              <span>主密钥</span>
              <div className="setup-input-action">
                <input aria-label="主密钥" type={showKey ? "text" : "password"} autoComplete="new-password" value={values.gatewayKey} onChange={(event) => { setValues({ ...values, gatewayKey: event.target.value }); setKeyNotice(""); }} placeholder="至少 16 个字符" autoFocus />
                <button type="button" onClick={generateKey}><KeyRound size={15} />随机生成</button>
              </div>
            </label>
            <label className="setup-field"><span>确认主密钥</span><input type="password" autoComplete="new-password" value={confirmKey} onChange={(event) => setConfirmKey(event.target.value)} placeholder="再次输入主密钥" /></label>
            <div className="setup-key-actions">
              <button type="button" className="secondary-button" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}{showKey ? "隐藏主密钥" : "显示主密钥"}</button>
              <button type="button" className="secondary-button" disabled={!values.gatewayKey} onClick={() => void copyKey()}><Copy size={15} />复制主密钥</button>
            </div>
            <div className="setup-tip" role="status">{keyNotice || "随机生成会填写确认框；复制并保存主密钥后继续。"}</div>
            <div className="setup-actions"><button className="primary-button" onClick={continueToProvider}>下一步<ChevronRight size={16} /></button></div>
          </section>
        )}

        {step === 2 && (
          <fieldset className="setup-form-section setup-fieldset" disabled={saving || testing}>
            <label className="setup-skip-toggle"><input type="checkbox" checked={values.configureProvider} onChange={(event) => setValues({ ...values, configureProvider: event.target.checked })} /><span><strong>现在配置第一个 Provider</strong><small>取消勾选可仅完成安全初始化，稍后在配置台添加。</small></span></label>
            {values.configureProvider && <>
              <div className="setup-section-heading"><Server size={21} /><div><h2>上游服务</h2><p>兼容服务选择 OpenAI 并修改地址；其他 Provider 可跳过后在配置台添加。</p></div></div>
              <div className="setup-grid">
                <label className="setup-field"><span>服务类型</span><select value={values.provider} onChange={(event) => selectProvider(event.target.value)}>{providerPresets.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                <label className="setup-field"><span>显示名称（可选）</span><input value={values.providerName} onChange={(event) => setValues({ ...values, providerName: event.target.value })} placeholder="例如：生产环境" /></label>
                <label className="setup-field setup-span-two"><span>上游服务地址</span><input value={values.serverURL} onChange={(event) => setValues({ ...values, serverURL: event.target.value })} placeholder="https://api.example.com/v1" /></label>
                <label className="setup-field"><span>上游协议</span><select value={values.upstreamProtocol} onChange={(event) => setValues({ ...values, upstreamProtocol: event.target.value as UpstreamProtocol })}>{upstreamProtocols.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                <label className="setup-field"><span>聊天模型</span><input value={values.models} onChange={(event) => setValues({ ...values, models: event.target.value })} placeholder="gpt-4o-mini, model-b" /></label>
                <label className="setup-field setup-span-two"><span>上游 API Key{values.provider === "ollama" ? "（可选）" : ""}</span><input type="password" autoComplete="off" value={values.upstreamKey} onChange={(event) => setValues({ ...values, upstreamKey: event.target.value })} placeholder={values.provider === "ollama" ? "本机 Ollama 通常无需填写" : "粘贴服务商提供的 API Key"} /></label>
              </div>
              {values.provider === "ollama" && <p className="setup-tip">地址从服务器访问。Docker 中的 127.0.0.1 指向容器；宿主机 Ollama 请使用容器可达的宿主机地址。</p>}
              <div className="setup-probe">
                <button type="button" className="secondary-button" onClick={() => void checkProvider()}>{testing ? "正在测试…" : "测试连接"}</button>
                <p>服务器会向第一个模型发送一次简短请求，最多等待 20 秒，可能产生少量上游费用。测试不会保存配置。</p>
              </div>
              {currentTest && <div className={`setup-alert ${currentTest.ok ? "success" : "error"}`} role="status">{currentTest.message}{currentTest.upstream_status ? `（HTTP ${currentTest.upstream_status}，${currentTest.latency_ms} ms）` : ""}</div>}
              {!currentTest?.ok && <p className="setup-tip">{currentTest ? "连接未验证成功，可修改后重试，也可以先保存配置。" : "尚未验证当前连接，可以测试后保存，也可以先保存配置。"}</p>}
            </>}
            <div className="setup-actions split"><button className="secondary-button" onClick={() => { setError(""); setStep(1); }}> <ChevronLeft size={16} />上一步</button><button className="primary-button" onClick={() => void finishSetup()}>{saving ? "正在保存…" : values.configureProvider && !currentTest?.ok ? "保存配置（未验证）" : "保存并完成"}<Check size={16} /></button></div>
          </fieldset>
        )}

        {step === 3 && (
          <section className="setup-complete">
            <div className="setup-success-icon"><CheckCircle2 size={34} /></div>
            <h2>初始化配置已保存</h2>
            <p>永久主密钥已启用，临时 bootstrap token 已失效。</p>
            <p>{!values.configureProvider ? "尚未添加模型服务，请进入配置台添加 Provider。" : currentTest?.ok ? "第一个模型已通过连接测试，可进入 Chat 试用。" : "连接尚未验证成功，请在 Chat 中试用，必要时到配置台调整 Provider。"}</p>
            <div className="setup-endpoints"><div><span>管理台</span><code>{window.location.origin}/</code></div><div><span>API Base URL</span><code>{window.location.origin}/v1</code></div></div>
            <button className="primary-button setup-wide-button" onClick={onComplete}>进入配置台<ChevronRight size={16} /></button>
          </section>
        )}
      </main>
      <footer className="setup-footer">配置保存在服务器，保存后可在配置台继续调整。</footer>
    </div>
  );
}
