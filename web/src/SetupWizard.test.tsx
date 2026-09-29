import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";
import { AdminRequestError, getConfigDraft, publishConfig, testProvider, validateConfig } from "./api/admin";

vi.mock("./api/admin", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api/admin")>(),
  getConfigDraft: vi.fn(),
  publishConfig: vi.fn(),
  testProvider: vi.fn(),
  validateConfig: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
const onKey = vi.fn();
const onComplete = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(getConfigDraft).mockResolvedValue({ config: { services: {}, api_key: "" }, database_path: "test.db" });
  vi.mocked(validateConfig).mockResolvedValue({ valid: true, issues: [] });
  vi.mocked(publishConfig).mockResolvedValue({ auth_changed: true, restart_required: false, restart_fields: [], revision: { id: 1, created_at: "", checksum: "", source: "admin", note: "", active: true } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => root.render(<SetupWizard apiKey="" onApiKeyChange={onKey} onComplete={onComplete} />));
}

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

async function input(placeholder: string, value: string) {
  const element = [...container.querySelectorAll("input")].find((item) => item.placeholder === placeholder);
  if (!element) throw new Error(`Missing input: ${placeholder}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function providerStep() {
  await click("随机生成");
  await click("下一步");
  await input("gpt-4o-mini, model-b", "model-a, model-b");
  await input("粘贴服务商提供的 API Key", "test-upstream-key");
}

describe("setup user flow", () => {
  it("requires a loaded draft before permitting setup and offers retry", async () => {
    vi.mocked(getConfigDraft).mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(container.textContent).toContain("offline");
    expect(container.textContent).not.toContain("下一步");
    await click("重新读取配置");
    expect(container.textContent).toContain("保护你的网关");
  });

  it("does not persist an incorrect bootstrap token and can recover", async () => {
    const challenge = new AdminRequestError("bootstrap required", 401, "admin_bootstrap_required");
    vi.mocked(getConfigDraft).mockRejectedValueOnce(challenge).mockRejectedValueOnce(challenge);
    await mount();
    await input("粘贴服务启动日志中的 token", "incorrect-token");
    await click("验证并继续");
    expect(container.textContent).toContain("临时初始化密钥不正确");
    expect(onKey).not.toHaveBeenCalled();
    await input("粘贴服务启动日志中的 token", "current-token");
    await click("验证并继续");
    expect(onKey).toHaveBeenCalledWith("current-token");
    expect(container.textContent).toContain("保护你的网关");
  });

  it("tests the first model without saving, invalidates changed settings, and allows unverified save", async () => {
    vi.mocked(testProvider).mockResolvedValue({ ok: true, code: "ok", message: "模型测试通过", latency_ms: 12 });
    await mount();
    await providerStep();
    await click("测试连接");
    expect(testProvider).toHaveBeenCalledWith("", expect.objectContaining({ model: "model-a", api_key: "test-upstream-key" }), expect.any(AbortSignal));
    expect(publishConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("模型测试通过");
    await input("https://api.example.com/v1", "https://different.example/v1");
    expect(container.textContent).not.toContain("模型测试通过");
    expect(container.textContent).toContain("尚未验证当前连接");
    vi.mocked(testProvider).mockResolvedValue({ ok: false, code: "authentication", message: "上游拒绝访问", latency_ms: 5 });
    await click("测试连接");
    expect(container.textContent).toContain("上游拒绝访问");
    await click("保存配置（未验证）");
    expect(publishConfig).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("连接尚未验证成功");
    await click("进入配置台");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("supports remote HTTP without randomUUID or clipboard and can skip provider setup", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await mount();
    await click("随机生成");
    const generated = container.querySelector<HTMLInputElement>('[aria-label="主密钥"]')!;
    expect(generated.type).toBe("text");
    expect(generated.value).toMatch(/^soa_[a-f0-9]{48}$/);
    await click("复制主密钥");
    expect(container.textContent).toContain("手动复制");
    await click("下一步");
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("保存并完成");
    expect(publishConfig).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("尚未添加模型服务");
  });

  it("keeps the draft editable after a failed save", async () => {
    vi.mocked(publishConfig).mockRejectedValueOnce(new Error("数据库不可写"));
    await mount();
    await providerStep();
    await click("保存配置（未验证）");
    expect(container.textContent).toContain("数据库不可写");
    expect(container.querySelector("fieldset")!.disabled).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    await click("保存配置（未验证）");
    expect(container.textContent).toContain("初始化配置已保存");
  });
});
