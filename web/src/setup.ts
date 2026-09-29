import type { AppConfiguration, UpstreamProtocol } from "./configuration";
import { stringList } from "./configuration";

export interface SetupValues {
  gatewayKey: string;
  configureProvider: boolean;
  provider: string;
  providerName: string;
  serverURL: string;
  upstreamProtocol: UpstreamProtocol;
  models: string;
  upstreamKey: string;
}

export function buildSetupConfiguration(
  base: AppConfiguration,
  values: SetupValues,
  providerID: string,
): AppConfiguration {
  const next: AppConfiguration = {
    ...base,
    api_key: values.gatewayKey.trim(),
    enable_web: true,
    load_balancing: base.load_balancing || "round_robin",
  };
  if (!values.configureProvider) return next;

  const provider = values.provider.trim() || "openai";
  const credential = values.upstreamKey.trim();
  const service = {
    id: providerID,
    name: values.providerName.trim() || `${provider} Provider`,
    provider,
    upstream_protocol: values.upstreamProtocol,
    enabled: true,
    models: stringList(values.models),
    server_url: values.serverURL.trim(),
    credentials: credential ? { api_key: credential } : {},
    limit: {},
    timeout: 120,
  };
  next.services = {
    ...(base.services ?? {}),
    [provider]: [...(base.services?.[provider] ?? []), service],
  };
  return next;
}

export function generateGatewayKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `soa_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
