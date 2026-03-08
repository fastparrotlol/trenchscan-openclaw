import type { PluginConfig, OpenClawPluginAPI } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { registerTools } from "./tools.js";
import { EventForwarder } from "./events.js";

// ── Plugin Entry ────────────────────────────────────────────────────

let forwarder: EventForwarder | null = null;

export function init(api: OpenClawPluginAPI, rawConfig: Record<string, unknown>): void {
  const config = parseConfig(rawConfig);

  api.log("info", `TrenchScan plugin initializing (api: ${config.apiUrl}, channels: ${config.alertChannels.join(",")})`);

  // Register 7 analysis tools
  registerTools(api, config);

  // Start realtime event forwarding
  forwarder = new EventForwarder(config, api);
  forwarder.start();

  api.log("info", "TrenchScan plugin ready");
}

export function unload(): void {
  if (forwarder) {
    forwarder.stop();
    forwarder = null;
  }
}

// ── Config Parsing ──────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): PluginConfig {
  const apiKey = raw.apiKey;
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error("trenchscan: apiKey is required");
  }

  const hookToken = raw.hookToken;
  if (typeof hookToken !== "string" || !hookToken) {
    throw new Error("trenchscan: hookToken is required");
  }

  return {
    apiKey,
    hookToken,
    apiUrl: (typeof raw.apiUrl === "string" ? raw.apiUrl : DEFAULT_CONFIG.apiUrl).replace(/\/$/, ""),
    wsUrl: typeof raw.wsUrl === "string" ? raw.wsUrl : DEFAULT_CONFIG.wsUrl,
    hookBaseUrl: (typeof raw.hookBaseUrl === "string" ? raw.hookBaseUrl : DEFAULT_CONFIG.hookBaseUrl).replace(/\/$/, ""),
    alertChannels: Array.isArray(raw.alertChannels) ? raw.alertChannels.filter((c): c is string => typeof c === "string") : DEFAULT_CONFIG.alertChannels,
    minMcap: typeof raw.minMcap === "number" ? raw.minMcap : DEFAULT_CONFIG.minMcap,
    maxMcap: typeof raw.maxMcap === "number" ? raw.maxMcap : DEFAULT_CONFIG.maxMcap,
    batchWindowSec: typeof raw.batchWindowSec === "number" ? raw.batchWindowSec : DEFAULT_CONFIG.batchWindowSec,
  };
}
