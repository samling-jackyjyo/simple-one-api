import { describe, expect, it } from "vitest";
import { buildSetupConfiguration } from "./setup";

describe("buildSetupConfiguration", () => {
  it("preserves defaults and adds the first provider", () => {
    const result = buildSetupConfiguration({ server_port: ":9090", services: {} }, {
      gatewayKey: "  gateway-secret  ",
      configureProvider: true,
      provider: "openai",
      providerName: "Primary",
      serverURL: " https://api.example.com/v1 ",
      upstreamProtocol: "responses",
      models: "model-a, model-b\nmodel-a",
      upstreamKey: " upstream-secret ",
    }, "provider-1");

    expect(result.api_key).toBe("gateway-secret");
    expect(result.server_port).toBe(":9090");
    expect(result.enable_web).toBe(true);
    expect(result.load_balancing).toBe("round_robin");
    expect(result.services?.openai?.[0]).toMatchObject({
      id: "provider-1",
      name: "Primary",
      models: ["model-a", "model-b"],
      server_url: "https://api.example.com/v1",
      credentials: { api_key: "upstream-secret" },
    });
  });

  it("can finish security setup without a provider", () => {
    const result = buildSetupConfiguration({ services: { existing: [] } }, {
      gatewayKey: "gateway-secret",
      configureProvider: false,
      provider: "openai",
      providerName: "",
      serverURL: "",
      upstreamProtocol: "auto",
      models: "",
      upstreamKey: "",
    }, "unused");

    expect(result.services).toEqual({ existing: [] });
    expect(result.api_key).toBe("gateway-secret");
  });
});
