import type { PluginConfig, WithdrawConfig, AlertFilter, OpenClawPluginAPI } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { registerTools } from "./tools.js";
import { registerTradingTools } from "./trading-tools.js";
import { EventForwarder } from "./events.js";
import { WalletManager } from "./wallet.js";
import { TradingEngine } from "./trading.js";
import { StrategyManager } from "./strategy.js";
import { PositionManager } from "./positions.js";

// ── Plugin Entry ────────────────────────────────────────────────────

let forwarder: EventForwarder | null = null;

export default function register(api: OpenClawPluginAPI): void {
  const config = parseConfig(api.config);

  api.logger.info(`TrenchScan plugin initializing (api: ${config.apiUrl}, channels: ${config.alertChannels.join(",")})`);

  // Register 8 analysis tools
  registerTools(api, config);

  // Initialize trading modules
  const walletManager = new WalletManager(config.dataDir, config.rpcUrl, api);
  const tradingEngine = new TradingEngine(config.rpcUrl, api, {
    feeWallet: config.feeWallet,
    feeBps: config.feeBps,
    jitoTipLamports: config.jitoTipLamports,
  });
  const strategyManager = new StrategyManager(config.dataDir, api);
  const positionManager = new PositionManager(config.dataDir, api);

  strategyManager.setPositionManager(positionManager);

  // Start realtime event forwarding
  forwarder = new EventForwarder(config, api);
  forwarder.setTrading(strategyManager, tradingEngine, walletManager, positionManager);

  // Register 14 trading tools
  registerTradingTools(api, config, walletManager, tradingEngine, strategyManager, positionManager, forwarder);

  if (config.tradingEnabled) {
    api.logger.info("Trading module enabled");
  }

  forwarder.start();

  api.logger.info("TrenchScan plugin ready (22 tools)");
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

  // Parse withdrawConfig
  let withdrawConfig: WithdrawConfig | undefined;
  if (raw.withdrawConfig && typeof raw.withdrawConfig === "object") {
    const wc = raw.withdrawConfig as Record<string, unknown>;
    withdrawConfig = {
      enabled: wc.enabled === true,
      destination: typeof wc.destination === "string" ? wc.destination : "",
      mode: wc.mode === "percent" ? "percent" : "all_profit",
      percent: typeof wc.percent === "number" ? wc.percent : undefined,
      afterEveryTrade: wc.afterEveryTrade === true,
    };
  }

  // Parse alertFilters
  let alertFilters: AlertFilter | undefined;
  if (raw.alertFilters && typeof raw.alertFilters === "object") {
    const af = raw.alertFilters as Record<string, unknown>;
    alertFilters = {
      mints: Array.isArray(af.mints) ? af.mints.filter((m): m is string => typeof m === "string") : undefined,
      symbols: Array.isArray(af.symbols) ? af.symbols.filter((s): s is string => typeof s === "string") : undefined,
      excludeMints: Array.isArray(af.excludeMints) ? af.excludeMints.filter((m): m is string => typeof m === "string") : undefined,
    };
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
    rpcUrl: typeof raw.rpcUrl === "string" ? raw.rpcUrl : DEFAULT_CONFIG.rpcUrl,
    dataDir: typeof raw.dataDir === "string" ? raw.dataDir : DEFAULT_CONFIG.dataDir,
    tradingEnabled: typeof raw.tradingEnabled === "boolean" ? raw.tradingEnabled : DEFAULT_CONFIG.tradingEnabled,
    feeWallet: typeof raw.feeWallet === "string" ? raw.feeWallet : undefined,
    feeBps: typeof raw.feeBps === "number" ? raw.feeBps : undefined,
    jitoTipLamports: typeof raw.jitoTipLamports === "number" ? raw.jitoTipLamports : undefined,
    withdrawConfig,
    alertFilters,
    rateLimitRpm: typeof raw.rateLimitRpm === "number" ? raw.rateLimitRpm : undefined,
  };
}
