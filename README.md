# openclaw-trenchscan

[![npm](https://img.shields.io/npm/v/openclaw-trenchscan)](https://www.npmjs.com/package/openclaw-trenchscan)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/github/stars/trenchscan/openclaw-trenchscan?style=social)](https://github.com/trenchscan/openclaw-trenchscan)

OpenClaw plugin for [TrenchScan](https://trenchscan.lol) — Solana pump.fun token scanner with **15 AI tools**, realtime KOL/bundle alerts, and autonomous trading strategies.

## Features

- **7 Analysis Tools** — token lookup, bundle detection, deployer reputation, KOL trades, risk scoring, market overview, token discovery
- **8 Trading Tools** — wallet management (encrypted), buy/sell on bonding curve + AMM, automated strategies
- **Realtime Alerts** — KOL trades, bundle detection, bundle dump alerts, new tokens, SOL price — delivered via OpenClaw hooks with configurable batching
- **Strategy Engine** — autonomous/confirm/alert modes with entry triggers, exit rules, position limits, and daily caps

## Quick Start

### 1. Install

```bash
npm install openclaw-trenchscan
```

### 2. Configure

Add to your OpenClaw config:

```json
{
  "plugins": {
    "trenchscan": {
      "apiKey": "your-trenchscan-api-key",
      "hookToken": "your-openclaw-hook-token",
      "tradingEnabled": true,
      "rpcUrl": "https://your-solana-rpc.com"
    }
  }
}
```

### 3. First Trade

```
> create a wallet with password "mypassword"
> check token GN5Wv...mint for risk
> buy 0.1 SOL of GN5Wv...mint
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | **required** | TrenchScan API key |
| `hookToken` | `string` | **required** | OpenClaw hook bearer token |
| `apiUrl` | `string` | `https://trenchscan.lol` | REST API base URL |
| `wsUrl` | `string` | `wss://trenchscan.lol/api/v1/ws` | WebSocket URL |
| `hookBaseUrl` | `string` | `http://localhost:3000` | OpenClaw gateway URL |
| `alertChannels` | `string[]` | `["kol_trades", "bundles"]` | WS channels to subscribe |
| `minMcap` | `number` | `0` | Minimum market cap filter (USD) |
| `maxMcap` | `number` | `0` | Maximum market cap filter (0 = no limit) |
| `batchWindowSec` | `number` | `30` | Alert batching window in seconds (0 = instant) |
| `rpcUrl` | `string` | `https://api.mainnet-beta.solana.com` | Solana RPC URL |
| `dataDir` | `string` | `./data` | Directory for wallet/strategy persistence |
| `tradingEnabled` | `boolean` | `false` | Enable trading module |
| `feeWallet` | `string` | TrenchScan wallet | Platform fee recipient address |
| `feeBps` | `number` | `50` | Platform fee in basis points (50 = 0.5%) |
| `jitoTipLamports` | `number` | `200000` | Jito MEV tip per transaction (lamports) |

## Tools Reference

### Analysis Tools (7)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `check_token` | `mint` | Token data, deployer score, bundles, KOL trades |
| `check_bundle` | `mint` | Bundle detection, wallet tracking, sell activity |
| `check_deployer` | `wallet` | Deployer reputation, rug history, past tokens |
| `kol_trades` | `wallet?`, `period?` | KOL profile/trades or leaderboard |
| `market_overview` | — | SOL price, active tokens, volume, market caps |
| `assess_risk` | `mint` | Risk score 0-100 with factor breakdown |
| `discover_tokens` | `min_mcap?`, `max_mcap?`, `has_kol?`, `has_bundle?`, `sort?`, `limit?` | Filter and discover tokens |

### Trading Tools (8)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_wallet` | `password?` | Generate new Solana keypair with optional encryption |
| `unlock_wallet` | `password` | Unlock encrypted wallet for trading |
| `wallet_info` | — | Wallet balance (SOL + token holdings) |
| `buy_token` | `mint`, `sol_amount`, `slippage_bps?` | Buy token (auto-detects bonding curve vs AMM) |
| `sell_token` | `mint`, `percent`, `slippage_bps?` | Sell token by percentage |
| `set_strategy` | `name`, `rules` | Create/update automated trading strategy |
| `list_strategies` | — | List all configured strategies |
| `remove_strategy` | `name` | Remove a strategy |

## Realtime Alerts

The plugin subscribes to TrenchScan WebSocket and forwards events to your AI agent via OpenClaw hooks.

### Channels

| Channel | Events |
|---------|--------|
| `kol_trades` | KOL buy/sell activity |
| `bundles` | New bundle detection, bundle dump alerts |
| `tokens` | New token creation, token price updates (used for position monitoring) |
| `market` | SOL price updates |

### Batching

Events are batched within `batchWindowSec` (default: 30s) to avoid flooding. High-priority events (bundle dump alerts) are delivered immediately.

## Trading Strategies

Strategies define automated trading behavior. Each strategy has:

- **Entry trigger** — what initiates a trade (`kol_buy`, `low_risk`, `new_token`)
- **Conditions** — filters (KOL names, risk score, market cap range, SOL amount)
- **Exit rules** — take profit, stop loss, trailing stop, max hold time, bundle dump exit
- **Automatic exits** — PositionManager monitors `token_update` prices in real-time and auto-sells when exit rules trigger
- **Mode** — `autonomous` (auto-execute), `confirm` (ask first), `alert` (notify only)
- **Limits** — max open positions, max SOL per trade, daily SOL cap

### Example Strategy

```json
{
  "mode": "confirm",
  "active": true,
  "entry": {
    "trigger": "kol_buy",
    "conditions": {
      "kol_names": ["ansem", "murad"],
      "max_risk_score": 40,
      "min_mcap": 50000,
      "max_mcap": 5000000,
      "sol_amount": 0.5
    }
  },
  "exit": {
    "take_profit_pct": 100,
    "stop_loss_pct": 30,
    "trailing_stop_pct": 20,
    "bundle_dump": true,
    "max_hold_minutes": 120
  },
  "limits": {
    "max_open_positions": 3,
    "max_sol_per_trade": 1,
    "max_daily_sol": 5
  }
}
```

## Security

- **Wallet encryption** — AES-256-GCM with user password, keys never leave your machine
- **Trading disabled by default** — explicit opt-in required
- **Max trade cap** — 10 SOL per transaction hard limit
- **Strategy modes** — choose between autonomous, confirm, or alert-only
- **Fee transparency** — 0.5% platform fee + 0.0002 SOL Jito tip, both configurable
- **No hidden data collection** — only TrenchScan API, Solana RPC, and OpenClaw hooks

See [SECURITY.md](./SECURITY.md) for responsible disclosure.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  OpenClaw Agent                      │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ Analysis │  │ Trading  │  │  Event Forwarder  │ │
│  │ 7 tools  │  │ 8 tools  │  │  (WS → Hooks)     │ │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘ │
│       │              │                 │            │
│       ▼              ▼                 ▼            │
│  TrenchScan    TradingEngine    TrenchScan WS       │
│  REST API      (Solana RPC)     (realtime feed)     │
│                     │                 │             │
│              ┌──────┼──────┐    PositionMgr         │
│              │      │      │    (exit monitor)      │
│         WalletMgr   │  StrategyMgr                  │
│         (AES-256)   │  (auto-trade)                 │
└─────────────────────────────────────────────────────┘
```

## License

[MIT](./LICENSE)
