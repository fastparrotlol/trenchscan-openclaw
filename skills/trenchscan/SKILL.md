# OpenClaw TrenchScan Plugin — AI Agent Skill Reference

> Complete reference for AI agents working with the TrenchScan plugin.
> 22 tools, Solana pump.fun, autonomous trading, real-time alerts.

**Entry point**: `build/index.js` (compiled from `src/index.ts`)
**Build**: `npm run build` → `build/`
**Type check**: `npx tsc --noEmit`

---

## Architecture

```
OpenClaw Agent (Claude)
├── 8 Analysis Tools ──── REST API (trenchscan.lol)
├── 14 Trading Tools ──── Solana RPC (buy/sell on-chain) + position mgmt
└── EventForwarder ────── WebSocket (real-time alerts)
    ├── TradingEngine      buy/sell bonding curve + AMM
    ├── StrategyManager    entry triggers (kol_buy, low_risk, new_token, smart_money_buy, whale_buy)
    ├── WalletManager      AES-256-GCM encrypted keypairs + SOL transfers
    ├── PositionManager    exit rules (TP tiers/SL/trail/hold/bundle dump/sniper exit/KOL sell exit)
    │                      DCA (dollar cost averaging), persistence, PnL tracking
    ├── KOL Confluence     multi-KOL buy detection with time window
    ├── Anti-Rug           risk API check before autonomous buys + risk-based position scaling
    ├── Sniper Tracking    track sniper sells per mint → trigger exit
    ├── Rate Limiter       token bucket (configurable RPM)
    ├── Alert Filters      whitelist/blacklist by mint/symbol
    ├── Auto-Withdraw      profit withdrawal after sells
    └── Metrics            WS status, events, trades, uptime
```

### Data Flow

```
WS connect → subscribe(channels, filter)
   ↓
kol_trade / bundle_detected / token_new → StrategyManager.evaluate()
trade (smart_money/whale) → handleTradeEvent() → StrategyManager.evaluate()
kol_trade (buy) → handleKolConfluence() → multi-KOL detection
   ↓ (if trigger matches)
executeStrategyAction() → anti-rug check → risk scaling → TradingEngine.buy()
   ↓                       → PositionManager.open(dcaConfig) → recordTrade()
token_update → PositionManager.evaluatePrice()     → saveToDisk()
   ↓ (if exit signal — TP tier, SL, trail, hold, bundle dump, sniper exit, KOL sell)
executeExit() → TradingEngine.sell() → PositionManager.close() or reducePosition()
   ↓                                  → recordTrade()
   └── auto-withdraw (if configured) → WalletManager.transferSol()
token_update (no exit) → evaluateDca() → buy more if price < entry
trade (!is_buy, sniper) → handleTradeEvent() → sniper tracking → sniper exit
kol_trade (!is_buy) → handleKolSellExit() → mirror exit
```

### Hooks

| Hook | Method | Purpose |
|------|--------|---------|
| `POST /hooks/wake` | `postWakeHook()` | Alerts, batched events, trade confirmations |
| `POST /hooks/agent` | `postAgentHook()` | High-priority events, strategy confirmations |

---

## File Map

| File | Class / Export | Purpose |
|------|---------------|---------|
| `src/index.ts` | `register(api)` | Entry point — parses config, registers tools, starts event forwarder |
| `src/types.ts` | interfaces | All TypeScript types: config, wallet, trade, strategy, WS events, TradeRecord, WithdrawConfig, AlertFilter, PluginMetrics |
| `src/tools.ts` | `registerTools()` | 8 analysis tools (REST API calls) |
| `src/trading-tools.ts` | `registerTradingTools()` | 14 trading tools (wallet, buy/sell, strategies, withdraw, history, positions, health, trade_analytics) |
| `src/trading.ts` | `TradingEngine` | On-chain buy/sell: bonding curve + AMM auto-detect |
| `src/strategy.ts` | `StrategyManager` | Entry trigger evaluation, per-strategy limits, strategy CRUD |
| `src/positions.ts` | `PositionManager` | Exit rule monitoring (TP tiers, SL, trailing stop, max hold, bundle dump), disk persistence, trade history, PnL |
| `src/wallet.ts` | `WalletManager` | Keypair generation, AES-256-GCM encryption, balance queries, SOL transfers |
| `src/events.ts` | `EventForwarder` | WS connection, event batching, strategy execution, exit execution, low_risk eval, trade event handling, KOL confluence, KOL sell exit, sniper tracking, DCA, anti-rug, alert filtering, rate limiting, metrics, auto-withdraw |
| `src/format.ts` | formatters | Event formatting + tool response formatting + trade history/positions/health formatters |

---

## Tools — Complete Reference (22)

### Analysis Tools (8) — `src/tools.ts`

| # | Tool | Parameters | API Endpoint | Returns |
|---|------|-----------|-------------|---------|
| 1 | `check_token` | `mint` (string) | `GET /api/v1/token/{mint}` | Price, mcap, volume, traders, buy/sell ratio, bonding %, deployer score, bundles, KOL trades |
| 2 | `check_bundle` | `mint` (string) | `GET /api/v1/bundles/{mint}` | Bundle count, wallet counts, SOL totals, supply %, sell activity |
| 3 | `check_deployer` | `wallet` (string) | `GET /api/v1/deployer/{wallet}` | Score 0-100, label, tokens created/rugged/survived, history |
| 4 | `kol_trades` | `wallet?` (string), `period?` ("1h"\|"6h"\|"24h"\|"7d"\|"30d") | `GET /api/v1/kol/{wallet}` or `GET /api/v1/kol/leaderboard?period=` | KOL profile + trades, or leaderboard |
| 5 | `market_overview` | — | `GET /api/v1/market` | SOL price, active tokens, volume, mcap stats |
| 6 | `assess_risk` | `mint` (string) | `GET /api/v1/risk/{mint}` | Risk score 0-100, recommendation, factor breakdown (dev, bundle, market) |
| 7 | `discover_tokens` | `min_mcap?`, `max_mcap?`, `has_kol?`, `has_bundle?`, `sort?` ("mcap"\|"volume"\|"age"\|"bonding"), `limit?` (max 200) | `GET /api/v1/tokens?...` | Token list with symbol, mcap, volume, bonding %, mint |
| 8 | `check_wallet` | `address` (string), `period?` ("1d"\|"7d"\|"30d"\|"all", default "7d") | `GET /api/v1/analytics/wallet/{address}/stats` + `/pnl` | Trade count, volume, tokens, labels, PnL, win rate, best/worst trades |

### Trading Tools (14) — `src/trading-tools.ts`

| # | Tool | Parameters | What it does |
|---|------|-----------|-------------|
| 1 | `create_wallet` | `password?` (string) | Generate Solana keypair, optionally encrypt with AES-256-GCM. Saves to `{dataDir}/wallet.json` |
| 2 | `unlock_wallet` | `password` (string) | Decrypt wallet with PBKDF2-derived key. Required before trading |
| 3 | `wallet_info` | — | SOL balance + all token holdings from RPC |
| 4 | `buy_token` | `mint` (string), `sol_amount` (number), `slippage_bps?` (default 500) | Auto-detect bonding/AMM → buy on-chain. Hard limit: 10 SOL |
| 5 | `sell_token` | `mint` (string), `percent?` (1-100), `token_amount?` (number), `slippage_bps?` (default 500) | Sell by % of holdings OR exact token amount. At least one required |
| 6 | `set_strategy` | `name` (string), `rules` (JSON string) | Create/update strategy. Parses all new fields: min_sol_amount, min_kol_count, confluence, risk_scaling, dca, sniper_exit, kol_sell_exit |
| 7 | `list_strategies` | — | List all strategies with status, mode, trigger, limits, TP tiers, confluence, DCA, risk scaling, sniper/KOL exit |
| 8 | `remove_strategy` | `name` (string) | Delete strategy by name |
| 9 | `withdraw` | `destination` (string), `amount` (number) | Transfer SOL from trading wallet to any address |
| 10 | `set_withdraw_config` | `config` (JSON string) | Configure auto-withdrawal: `{enabled, destination, mode, percent?, afterEveryTrade}` |
| 11 | `trade_history` | `limit?` (number, default 20), `mint?` (string) | View trade records + realized PnL by mint |
| 12 | `positions` | — | View all open positions with entry price, SOL spent, hold time, fired TP tiers |
| 13 | `health` | — | Plugin health: WS connected, reconnects, events received, trades executed, API calls, open positions, daily SOL spent, uptime |
| 14 | `trade_analytics` | `period?` ("1d"\|"7d"\|"30d"\|"all", default "all"), `strategy?` (string) | PnL, ROI, win rate, avg hold time, best/worst trade, by-strategy breakdown. Pure local computation |

---

## Trading Engine — `src/trading.ts`

### Public API

```typescript
async buy(mint: string, solAmount: number, keypair: Keypair, slippageBps?: number): Promise<TradeResult>
async sell(mint: string, tokenAmount: number, keypair: Keypair, slippageBps?: number): Promise<TradeResult>
```

Both methods auto-detect mode:
- **Bonding curve**: PDA `["bonding-curve", mint]` exists → `buyBonding()` / `sellBonding()`
- **AMM**: No bonding curve → `buyAmm()` / `sellAmm()`

### TradeResult

```typescript
{ success: boolean, signature?: string, error?: string, expectedAmount?: number, mode: "bonding" | "amm" }
```

### Program IDs

| Constant | Address |
|----------|---------|
| `PUMP_PROGRAM` | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| `PUMP_GLOBAL` | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` |
| `PUMP_EVENT_AUTHORITY` | `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1` |
| `PUMP_AMM_PROGRAM` | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| `WSOL_MINT` | `So11111111111111111111111111111111111111112` |
| `FEE_PROGRAM` | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |
| `ALT` | `AEEC3HHR8nfZ7Ci2kEFM2ffawLKxQvaYRGU4fz9Ng6nt` |

### Fees

- **Platform fee**: 50 bps (0.5%) of output amount → `feeWallet`
- **Jito MEV tip**: 200,000 lamports (0.0002 SOL) → random tip account
- **Compute budget**: 200k units (bonding) / 300k units (AMM), 200k microlamports price

### Hard Limits

- Max per transaction: **10 SOL** (hard-coded validation in `buy_token`)
- Default slippage: **500 bps (5%)**
- Bonding curve extra discount: **+150 bps** on top of slippage

---

## Strategy + PositionManager — Autonomous Trading

### Strategy Schema

```typescript
interface Strategy {
  name: string;
  active: boolean;                              // default: true
  mode: "autonomous" | "confirm" | "alert";     // default: "alert"
  entry: {
    trigger: "kol_buy" | "low_risk" | "new_token" | "smart_money_buy" | "whale_buy";
    conditions: {
      kol_names?: string[];      // case-insensitive match (kol_buy)
      max_risk_score?: number;   // anti-rug: skip if risk > this (any trigger)
      min_mcap?: number;         // USD
      max_mcap?: number;         // USD
      sol_amount: number;        // SOL to buy
      min_sol_amount?: number;   // min trade size to follow (smart_money/whale)
      min_kol_count?: number;    // multi-KOL confluence (kol_buy, default 1)
      confluence_window_seconds?: number;  // time window for confluence (default 300)
      risk_scaling?: {           // scale position by risk score
        low_pct: number;         // 0-20 risk → this % of sol_amount
        medium_pct: number;      // 21-45 risk
        high_pct: number;        // 46-70 risk
      };
      dca?: {                    // dollar cost averaging
        max_buys: number;        // max additional buys
        interval_seconds: number; // min seconds between DCA buys
        scale_factor: number;    // multiply amount by this each DCA
      };
    };
  };
  exit: {
    take_profit_pct?: number;    // e.g. 200 = +200% (final TP)
    take_profit_tiers?: { pct: number; sell_pct: number }[];
    stop_loss_pct?: number;      // e.g. 30 = -30%
    trailing_stop_pct?: number;  // e.g. 20 = -20% from peak
    bundle_dump?: boolean;       // exit on bundle_dump_alert event
    max_hold_minutes?: number;   // e.g. 120
    sniper_exit?: { min_sellers: number };  // exit when N snipers sell
    kol_sell_exit?: boolean;     // exit when KOL sells same token
    kol_sell_exit_names?: string[];  // only exit for these KOLs
  };
  limits: {
    max_open_positions: number;  // per-strategy (not global)
    max_sol_per_trade: number;
    max_daily_sol: number;
  };
}
```

### Entry Triggers — `StrategyManager.evaluate()` + `EventForwarder`

| Trigger | WS Event | How it works |
|---------|---------|-------------|
| `kol_buy` | `kol_trade` (is_buy=true) | Match kol_names (case-insensitive), check mcap filters, per-strategy limits. If min_kol_count > 1 → deferred to confluence logic |
| `smart_money_buy` | `trade` (is_buy=true, labels includes "smart_money") | Check min_sol_amount, mcap filters, per-strategy limits. Auto-subscribes `smart_money` WS channel |
| `whale_buy` | `trade` (is_buy=true, labels includes "whale") | Same as smart_money_buy but for "whale" label. Auto-subscribes `whale_alerts` WS channel |
| `new_token` | `token_new` | Check mcap filters, check per-strategy limits |
| `low_risk` | `token_new` | On token_new → call `GET /api/v1/risk/{mint}` (rate-limited) → if risk_score <= max_risk_score → trigger buy |

### Execution Modes

| Mode | Behavior |
|------|----------|
| `autonomous` | Auto-executes buy, opens position, records trade, posts wake hook |
| `confirm` | Posts to `/hooks/agent`, waits for agent decision |
| `alert` | Posts alert to `/hooks/wake`, no trade |

### Exit Rules — `PositionManager.evaluatePrice()`

Called on every `token_update` event for open positions.

| Rule | Logic |
|------|-------|
| **TP Tiers** | Sorted by pct ASC; if changePct >= tier.pct and not yet fired → partial sell (tier.sell_pct%) |
| **Take Profit** | `changePct >= take_profit_pct` → sell 100% (checked after tiers) |
| **Stop Loss** | `changePct <= -stop_loss_pct` → sell 100% |
| **Trailing Stop** | Updates high water mark; `drawdown >= trailing_stop_pct` → sell 100% |
| **Max Hold** | Checked every 10s via `evaluateAllTimers()`; `heldMinutes >= max_hold_minutes` → sell 100% |
| **Bundle Dump** | On `bundle_dump_alert` WS event; if position has `bundle_dump: true` → sell 100% |
| **Sniper Exit** | Tracks unique sniper wallets selling on this mint via `trade` events; if count >= `min_sellers` → sell 100% |
| **KOL Sell Exit** | On `kol_trade` with `is_buy=false`; if position has `kol_sell_exit: true` and name matches (or no filter) → sell 100% |

### Position Lifecycle

```
buy() success → PositionManager.open(dcaConfig, initialSolAmount) → recordTrade() → saveToDisk()
  ↓
token_update → evaluatePrice(mint, currentPrice) → ExitSignal | null
  ↓ (no exit)
  └── evaluateDca(mint, price) → if price < entry & interval elapsed → buy more → recordDcaBuy()
  ↓ (exit signal)
ExitSignal(sellPercent=100) → executeExit() → sell() → close() → recordTrade()
ExitSignal(sellPercent<100) → executeExit() → sell() → reducePosition() → recordTrade()
  ↓ (if auto-withdraw configured)
  └── WalletManager.transferSol(destination, profit)
```

### Limits — `StrategyManager.checkLimits()`

1. `max_open_positions`: checked per-strategy via `positionManager.countByStrategy(name)`
2. `max_daily_sol`: tracked in `dailySolSpent`, resets at midnight
3. `max_sol_per_trade`: validated per action

---

## Position Persistence

Positions and trades are saved to disk (`positions.json`, `trades.json`) and survive restarts.

### Position Fields

```typescript
interface Position {
  mint: string;
  strategy: string;
  entryPriceSol: number;
  tokenAmount: number;
  solSpent: number;
  openedAt: number;
  highWaterMark: number;
  exitRules: Strategy["exit"];
  tpTiersFired: number[];      // indices of fired TP tiers
  dcaBuyCount?: number;         // number of DCA buys executed
  dcaConfig?: { max_buys: number; interval_seconds: number; scale_factor: number };
  lastDcaAt?: number;           // timestamp of last DCA buy
  initialSolAmount?: number;    // original buy amount (for DCA scaling)
}
```

### Trade History & PnL

```typescript
interface TradeRecord {
  mint: string;
  strategy: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  signature: string;
  mode: "bonding" | "amm";
  reason: string;
  timestamp: number;
}
```

PnL calculated by grouping trades by mint: sum of sell SOL - sum of buy SOL.

---

## Auto-Withdraw

Configured via `set_withdraw_config` tool or `withdrawConfig` in plugin config.

```typescript
interface WithdrawConfig {
  enabled: boolean;
  destination: string;         // wallet address
  mode: "all_profit" | "percent";
  percent?: number;            // if mode=percent
  afterEveryTrade: boolean;    // auto after each sell
}
```

After each sell, if profit > 0:
- `all_profit`: withdraw entire profit
- `percent`: withdraw `percent%` of profit

Minimum withdrawal: 0.001 SOL (to avoid dust transactions).

---

## Alert Filtering

```typescript
interface AlertFilter {
  mints?: string[];          // whitelist
  symbols?: string[];        // whitelist (case-insensitive)
  excludeMints?: string[];   // blacklist
}
```

- If whitelist exists → only matching events are forwarded
- Blacklist is always checked (takes priority)
- Filtering applies to formatted alerts, NOT to position monitoring or strategy evaluation

---

## Rate Limiting

Token bucket rate limiter for API calls (used by `low_risk` trigger):
- Default: 60 requests per minute
- Configurable via `rateLimitRpm`
- Only applies to risk API calls, not to trading or analysis tools

---

## Plugin Metrics

Available via `health` tool:

```typescript
interface PluginMetrics {
  wsConnected: boolean;
  wsReconnects: number;
  eventsReceived: number;
  tradesExecuted: number;
  apiCallsCount: number;
  uptime: number;
  openPositions: number;
  dailySolSpent: number;
}
```

---

## Configuration — `PluginConfig`

| Key | Type | Default | Required | Description |
|-----|------|---------|----------|-------------|
| `apiKey` | string | — | **YES** | TrenchScan API key (tier: agent) |
| `hookToken` | string | — | **YES** | OpenClaw hook bearer token |
| `apiUrl` | string | `https://trenchscan.lol` | no | REST API base URL |
| `wsUrl` | string | `wss://trenchscan.lol/api/v1/ws` | no | WebSocket URL |
| `hookBaseUrl` | string | `http://localhost:3000` | no | OpenClaw gateway URL |
| `alertChannels` | string[] | `["kol_trades", "bundles"]` | no | WS channels to subscribe |
| `minMcap` | number | `0` | no | Min market cap filter (USD) |
| `maxMcap` | number | `0` | no | Max market cap filter (0 = no limit) |
| `batchWindowSec` | number | `30` | no | Event batching window (0 = instant) |
| `rpcUrl` | string | `https://api.mainnet-beta.solana.com` | no | Solana RPC endpoint |
| `dataDir` | string | `./data` | no | Wallet + strategy + position + trade persistence |
| `tradingEnabled` | boolean | `false` | no | Enable trading module |
| `feeWallet` | string | `7uLD9sc...gxJb` | no | Platform fee recipient |
| `feeBps` | number | `50` | no | Platform fee in basis points |
| `jitoTipLamports` | number | `200000` | no | MEV tip in lamports |
| `withdrawConfig` | object | — | no | Auto-withdraw settings (see WithdrawConfig) |
| `alertFilters` | object | — | no | Alert filtering (see AlertFilter) |
| `rateLimitRpm` | number | `60` | no | API rate limit (requests per minute) |

---

## WebSocket Events

### Event Types

| Event | Channel | Priority | Handled by plugin |
|-------|---------|----------|------------------|
| `kol_trade` | `kol_trades` | normal | Strategy eval (kol_buy trigger) + KOL confluence + KOL sell exit + alert |
| `bundle_detected` | `bundles` | normal | Alert only |
| `bundle_dump_alert` | `bundles` | **high** (instant) | Position exit (if bundle_dump=true) + instant forward to `/hooks/agent` |
| `token_new` | `tokens` | normal | Strategy eval (new_token + low_risk triggers) + alert |
| `token_update` | `tokens` | normal | Position price monitoring + DCA evaluation (no alert) |
| `sol_price` | `market` | normal | Alert only |
| `trade` | `trades` | normal | Strategy eval (smart_money_buy / whale_buy) + sniper sell tracking + sniper exit |

### Subscription

```json
{
  "action": "subscribe",
  "channels": ["kol_trades", "bundles"],
  "filter": { "min_mcap": 0, "max_mcap": 0 }
}
```

If `tradingEnabled`: `"tokens"` channel is always added (needed for position monitoring via `token_update`).
If any active strategy uses `smart_money_buy` or `sniper_exit`: `"smart_money"` channel is auto-added.
If any active strategy uses `whale_buy`: `"whale_alerts"` channel is auto-added.

### Batching

- `batchWindowSec > 0`: events accumulate, flushed every N seconds via `postWakeHook()`
- `batchWindowSec = 0`: each event posted instantly
- `priority = "high"` (`bundle_dump_alert`): always instant to `/hooks/agent`

---

## How to Extend

### Add a new analysis tool

1. **`src/tools.ts`** — inside `registerTools()`:
```typescript
api.registerTool({
  name: "my_tool",
  description: "...",
  parameters: { type: "object", properties: { ... }, required: [...] },
  execute: async (params) => {
    const res = await fetch(`${config.apiUrl}/api/v1/my-endpoint/${params.mint}`, {
      headers: { "X-API-Key": config.apiKey }
    });
    const data = await res.json();
    return formatMyTool(data);
  }
});
```

2. **`src/format.ts`** — add `formatMyTool(data)` function

### Add a new trading tool

1. **`src/trading-tools.ts`** — inside `registerTradingTools()`:
```typescript
api.registerTool({
  name: "my_trading_tool",
  description: "...",
  parameters: { ... },
  execute: async (params) => {
    if (!config.tradingEnabled) return "Trading is disabled";
    // use walletManager, tradingEngine, strategyManager, positionManager, eventForwarder
  }
});
```

### Add a new entry trigger

1. **`src/strategy.ts`** — in `evaluateStrategy()`, add case:
```typescript
case "my_trigger":
  if (event.type !== "expected_event") return null;
  // check conditions
  // check limits
  return { strategy, action: "buy", mint, sol_amount, reason: "..." };
```

2. **`src/types.ts`** — add `"my_trigger"` to `Strategy.entry.trigger` union type

### Add a new exit rule

1. **`src/positions.ts`** — in `evaluatePrice()`, add check:
```typescript
if (pos.exitRules.my_rule) {
  // evaluate condition
  if (shouldExit) {
    return { mint, position: pos, reason: "My rule triggered", sellPercent: 100 };
  }
}
```

2. **`src/types.ts`** — add `my_rule` field to `Strategy.exit`

### Build & verify

```bash
npm run build        # Compile TypeScript → build/
npx tsc --noEmit     # Type-check without emitting
```

---

## Key Constants

| Value | Purpose |
|-------|---------|
| 500 bps | Default slippage (5%) |
| 150 bps | Extra bonding curve discount |
| 10 SOL | Hard max per buy transaction |
| 200,000 CU | Bonding curve compute limit |
| 300,000 CU | AMM compute limit |
| 200,000 μlamports | Compute unit price |
| 100,000 iterations | PBKDF2 key derivation |
| 30 seconds | Default batch window |
| 10 seconds | Position timer check interval |
| 50 bps | Default platform fee (0.5%) |
| 200,000 lamports | Default Jito MEV tip |
| 60 RPM | Default API rate limit |
| 0.001 SOL | Minimum auto-withdraw amount |

---

## Wallet Encryption

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key derivation**: PBKDF2, 100k iterations, 32-byte salt
- **IV**: 12 bytes random per encryption
- **Storage**: `{dataDir}/wallet.json` — `{ publicKey, encrypted, secretKey, salt?, iv?, tag? }`
- **Flow**: `create_wallet(password)` → encrypted on disk → `unlock_wallet(password)` → keypair in memory → ready to trade

---

## REST API Endpoints

| Endpoint | Tool | Method |
|----------|------|--------|
| `/api/v1/token/{mint}` | `check_token` | GET |
| `/api/v1/bundles/{mint}` | `check_bundle` | GET |
| `/api/v1/deployer/{wallet}` | `check_deployer` | GET |
| `/api/v1/kol/{wallet}` | `kol_trades` | GET |
| `/api/v1/kol/leaderboard?period=` | `kol_trades` | GET |
| `/api/v1/market` | `market_overview` | GET |
| `/api/v1/risk/{mint}` | `assess_risk`, `low_risk` trigger | GET |
| `/api/v1/tokens?...` | `discover_tokens` | GET |
| `/api/v1/analytics/wallet/{address}/stats?period=` | `check_wallet` | GET |
| `/api/v1/analytics/wallet/{address}/pnl?period=` | `check_wallet` | GET |

All REST calls use header: `X-API-Key: {config.apiKey}`

---

## Data Files

| File | Format | Written by |
|------|--------|-----------|
| `{dataDir}/wallet.json` | JSON | WalletManager |
| `{dataDir}/strategies.json` | JSON array | StrategyManager |
| `{dataDir}/positions.json` | JSON array | PositionManager (on open/close/reduce) |
| `{dataDir}/trades.json` | JSON array | PositionManager (on recordTrade) |
