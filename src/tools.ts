import type { PluginConfig, OpenClawPluginAPI } from "./types.js";
import {
  formatCheckToken, formatCheckBundle, formatCheckDeployer,
  formatKolTrades, formatMarketOverview, formatAssessRisk, formatDiscoverTokens,
} from "./format.js";

// ── API Helper ──────────────────────────────────────────────────────

async function apiCall(config: PluginConfig, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${config.apiUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json();
}

// ── Register All Tools ──────────────────────────────────────────────

export function registerTools(api: OpenClawPluginAPI, config: PluginConfig): void {

  // 1. check_token
  api.registerTool({
    name: "check_token",
    description: "Get comprehensive data for a Solana token: price, market cap, volume, deployer score, bundles, KOL trades",
    parameters: {
      mint: { type: "string", description: "Token mint address", required: true },
    },
    async handler({ mint }) {
      const data = await apiCall(config, `/api/v1/token/${mint}`);
      return formatCheckToken(data);
    },
  });

  // 2. check_bundle
  api.registerTool({
    name: "check_bundle",
    description: "Check if a token has coordinated bundle buys (sniping) and track their sell behavior",
    parameters: {
      mint: { type: "string", description: "Token mint address", required: true },
    },
    async handler({ mint }) {
      const data = await apiCall(config, `/api/v1/bundles/${mint}`);
      return formatCheckBundle(data);
    },
  });

  // 3. check_deployer
  api.registerTool({
    name: "check_deployer",
    description: "Check a deployer wallet's reputation: rug history, score, past token performance",
    parameters: {
      wallet: { type: "string", description: "Deployer wallet address", required: true },
    },
    async handler({ wallet }) {
      const data = await apiCall(config, `/api/v1/deployer/${wallet}`);
      return formatCheckDeployer(data);
    },
  });

  // 4. kol_trades
  api.registerTool({
    name: "kol_trades",
    description: "Get KOL (Key Opinion Leader) trading activity: specific wallet trades or leaderboard rankings",
    parameters: {
      wallet: { type: "string", description: "KOL wallet address. If omitted, returns leaderboard." },
      period: { type: "string", description: "Time period: 1h, 6h, 24h, 7d, 30d", default: "24h" },
    },
    async handler({ wallet, period }) {
      if (wallet) {
        const data = await apiCall(config, `/api/v1/kol/${wallet}`);
        return formatKolTrades(data, wallet as string);
      }
      const params: Record<string, string> = {};
      if (period) params.period = String(period);
      const data = await apiCall(config, `/api/v1/kol/leaderboard`, params);
      return formatKolTrades(data, undefined, period as string);
    },
  });

  // 5. market_overview
  api.registerTool({
    name: "market_overview",
    description: "Get current Solana pump.fun market statistics: SOL price, active tokens, volume, market caps",
    parameters: {},
    async handler() {
      const data = await apiCall(config, `/api/v1/market`);
      return formatMarketOverview(data);
    },
  });

  // 6. assess_risk
  api.registerTool({
    name: "assess_risk",
    description: "Get comprehensive risk assessment for a token: dev score, bundle behavior, market health → 0-100 risk score",
    parameters: {
      mint: { type: "string", description: "Token mint address", required: true },
    },
    async handler({ mint }) {
      const data = await apiCall(config, `/api/v1/risk/${mint}`);
      return formatAssessRisk(data);
    },
  });

  // 7. discover_tokens
  api.registerTool({
    name: "discover_tokens",
    description: "Discover and filter active Solana tokens by market cap, volume, KOL presence, bundles, bonding progress",
    parameters: {
      min_mcap: { type: "number", description: "Minimum market cap in USD" },
      max_mcap: { type: "number", description: "Maximum market cap in USD" },
      has_kol: { type: "string", description: "Only tokens with KOL traders (true/false)", enum: ["true", "false"] },
      has_bundle: { type: "string", description: "Only tokens with detected bundles (true/false)", enum: ["true", "false"] },
      sort: { type: "string", description: "Sort by: mcap, volume, age, bonding", default: "mcap" },
      limit: { type: "number", description: "Number of results (default: 20, max: 200)", default: 20 },
    },
    async handler({ min_mcap, max_mcap, has_kol, has_bundle, sort, limit }) {
      const params: Record<string, string> = {};
      if (min_mcap !== undefined) params.min_mcap = String(min_mcap);
      if (max_mcap !== undefined) params.max_mcap = String(max_mcap);
      if (has_kol !== undefined) params.has_kol = String(has_kol);
      if (has_bundle !== undefined) params.has_bundle = String(has_bundle);
      if (sort) params.sort = String(sort);
      params.limit = String(limit ?? 20);
      const data = await apiCall(config, `/api/v1/tokens`, params);
      return formatDiscoverTokens(data);
    },
  });
}
