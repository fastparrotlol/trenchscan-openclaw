// ── Plugin Config ────────────────────────────────────────────────────

export interface PluginConfig {
  apiKey: string;
  apiUrl: string;
  wsUrl: string;
  hookToken: string;
  hookBaseUrl: string;
  alertChannels: string[];
  minMcap: number;
  maxMcap: number;
  batchWindowSec: number;
}

export const DEFAULT_CONFIG: Omit<PluginConfig, "apiKey" | "hookToken"> = {
  apiUrl: "https://trenchscan.lol",
  wsUrl: "wss://trenchscan.lol/api/v1/ws",
  hookBaseUrl: "http://localhost:3000",
  alertChannels: ["kol_trades", "bundles"],
  minMcap: 0,
  maxMcap: 0,
  batchWindowSec: 30,
};

// ── WS Message Types ────────────────────────────────────────────────

export interface KolTradeData {
  id: number;
  kol_name: string;
  kol_wallet: string;
  kol_pfp?: string;
  twitter?: string;
  mint: string;
  is_buy: boolean;
  sol_amount: number;
  timestamp_ms: number;
  market_cap_usd: number;
  price_sol: number;
  token_name?: string;
  token_symbol?: string;
  token_image_url?: string;
}

export interface BundleData {
  id: number;
  mint: string;
  creator: string;
  creation_slot: number;
  wallet_count: number;
  total_sol: number;
  wallets: { wallet: string; sol_amount: number }[];
  detected_at_ms: number;
  token_name?: string;
  token_symbol?: string;
  token_image_url?: string;
  market_cap_usd: number;
  creation_tx?: string;
  supply_pct: number;
}

export interface BundleDumpAlert {
  mint: string;
  pct_sold: number;
  time_since_creation_secs: number;
  wallets_selling: number;
}

export interface TokenNewData {
  mint: string;
  name?: string;
  symbol?: string;
  deployer?: string;
  market_cap_usd: number;
  price_sol: number;
  bonding_progress: number;
}

export interface SolPriceData {
  price_usd: number;
}

// ── WS Message Union ────────────────────────────────────────────────

export type WsEvent =
  | { type: "kol_trade"; data: KolTradeData }
  | { type: "bundle_detected"; data: BundleData }
  | { type: "bundle_dump_alert"; data: BundleDumpAlert }
  | { type: "token_new"; data: TokenNewData }
  | { type: "sol_price"; data: SolPriceData };

// ── Channel Mapping ─────────────────────────────────────────────────

export const EVENT_CHANNEL: Record<WsEvent["type"], string> = {
  kol_trade: "kol_trades",
  bundle_detected: "bundles",
  bundle_dump_alert: "bundles",
  token_new: "tokens",
  sol_price: "market",
};

// ── Priority ────────────────────────────────────────────────────────

export type EventPriority = "normal" | "high";

export const EVENT_PRIORITY: Record<WsEvent["type"], EventPriority> = {
  kol_trade: "normal",
  bundle_detected: "normal",
  bundle_dump_alert: "high",
  token_new: "normal",
  sol_price: "normal",
};

// ── OpenClaw Plugin API (minimal typing) ────────────────────────────

export interface OpenClawPluginAPI {
  registerTool(def: ToolDefinition): void;
  log(level: "info" | "warn" | "error", msg: string): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParam>;
  handler(args: Record<string, unknown>): Promise<string>;
}

export interface ToolParam {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}
