import type { PluginConfig, OpenClawPluginAPI, ToolResult } from "./types.js";
import {
  formatCheckToken, formatCheckBundle, formatCheckDeployer,
  formatKolTrades, formatMarketOverview, formatAssessRisk, formatDiscoverTokens,
} from "./format.js";

// ── Helpers ──────────────────────────────────────────────────────────

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

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
      type: "object",
      properties: {
        mint: { type: "string", description: "Token mint address" },
      },
      required: ["mint"],
    },
    async execute(_id, params) {
      const data = await apiCall(config, `/api/v1/token/${params.mint}`);
      return textResult(formatCheckToken(data));
    },
  });

  // 2. check_bundle
  api.registerTool({
    name: "check_bundle",
    description: "Check if a token has coordinated bundle buys (sniping) and track their sell behavior",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string", description: "Token mint address" },
      },
      required: ["mint"],
    },
    async execute(_id, params) {
      const data = await apiCall(config, `/api/v1/bundles/${params.mint}`);
      return textResult(formatCheckBundle(data));
    },
  });

  // 3. check_deployer
  api.registerTool({
    name: "check_deployer",
    description: "Check a deployer wallet's reputation: rug history, score, past token performance",
    parameters: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "Deployer wallet address" },
      },
      required: ["wallet"],
    },
    async execute(_id, params) {
      const data = await apiCall(config, `/api/v1/deployer/${params.wallet}`);
      return textResult(formatCheckDeployer(data));
    },
  });

  // 4. kol_trades
  api.registerTool({
    name: "kol_trades",
    description: "Get KOL (Key Opinion Leader) trading activity: specific wallet trades or leaderboard rankings",
    parameters: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "KOL wallet address. If omitted, returns leaderboard." },
        period: { type: "string", description: "Time period: 1h, 6h, 24h, 7d, 30d", default: "24h" },
      },
    },
    async execute(_id, params) {
      const { wallet, period } = params;
      if (wallet) {
        const data = await apiCall(config, `/api/v1/kol/${wallet}`);
        return textResult(formatKolTrades(data, wallet as string));
      }
      const queryParams: Record<string, string> = {};
      if (period) queryParams.period = String(period);
      const data = await apiCall(config, `/api/v1/kol/leaderboard`, queryParams);
      return textResult(formatKolTrades(data, undefined, period as string));
    },
  });

  // 5. market_overview
  api.registerTool({
    name: "market_overview",
    description: "Get current Solana pump.fun market statistics: SOL price, active tokens, volume, market caps",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_id) {
      const data = await apiCall(config, `/api/v1/market`);
      return textResult(formatMarketOverview(data));
    },
  });

  // 6. assess_risk
  api.registerTool({
    name: "assess_risk",
    description: "Get comprehensive risk assessment for a token: dev score, bundle behavior, market health → 0-100 risk score",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string", description: "Token mint address" },
      },
      required: ["mint"],
    },
    async execute(_id, params) {
      const data = await apiCall(config, `/api/v1/risk/${params.mint}`);
      return textResult(formatAssessRisk(data));
    },
  });

  // 7. discover_tokens
  api.registerTool({
    name: "discover_tokens",
    description: "Discover and filter active Solana tokens by market cap, volume, KOL presence, bundles, bonding progress",
    parameters: {
      type: "object",
      properties: {
        min_mcap: { type: "number", description: "Minimum market cap in USD" },
        max_mcap: { type: "number", description: "Maximum market cap in USD" },
        has_kol: { type: "string", description: "Only tokens with KOL traders (true/false)", enum: ["true", "false"] },
        has_bundle: { type: "string", description: "Only tokens with detected bundles (true/false)", enum: ["true", "false"] },
        sort: { type: "string", description: "Sort by: mcap, volume, age, bonding", default: "mcap" },
        limit: { type: "number", description: "Number of results (default: 20, max: 200)", default: 20 },
      },
    },
    async execute(_id, params) {
      const queryParams: Record<string, string> = {};
      if (params.min_mcap !== undefined) queryParams.min_mcap = String(params.min_mcap);
      if (params.max_mcap !== undefined) queryParams.max_mcap = String(params.max_mcap);
      if (params.has_kol !== undefined) queryParams.has_kol = String(params.has_kol);
      if (params.has_bundle !== undefined) queryParams.has_bundle = String(params.has_bundle);
      if (params.sort) queryParams.sort = String(params.sort);
      queryParams.limit = String(params.limit ?? 20);
      const data = await apiCall(config, `/api/v1/tokens`, queryParams);
      return textResult(formatDiscoverTokens(data));
    },
  });
}
