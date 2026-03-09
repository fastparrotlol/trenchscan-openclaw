# Security

## Wallet Security

- **Private keys are encrypted at rest** using AES-256-GCM with a user-provided password
- Keys are stored in `data/wallet.json` — **never commit this file**
- The wallet must be explicitly unlocked before any trading operation
- No private key material is ever sent over the network or logged

## Trading Safeguards

- **Trading is disabled by default** — set `tradingEnabled: true` to activate
- Maximum trade size is capped at **10 SOL per transaction**
- Strategies support three modes:
  - `alert` — notify only, no execution
  - `confirm` — require explicit approval before each trade
  - `autonomous` — execute automatically within configured limits
- Daily SOL spending limits are enforced per strategy
- **Per-strategy position limits** prevent overexposure per trading strategy
- **API rate limiting** — configurable requests per minute (default: 60 RPM)
- **Auto-withdraw minimum** — 0.001 SOL threshold to prevent dust transactions

## Fee Transparency

- Platform fee: **0.5% (50 bps)** per trade by default
- Jito MEV tip: **0.0002 SOL** per transaction by default
- Both values are configurable in the plugin config (`feeBps`, `jitoTipLamports`)
- Fee wallet address is visible in config and on-chain
- All fees are transparently included in the transaction — no hidden charges

## Data Storage

- Wallet data is stored locally in `dataDir` (default: `./data`)
- Strategy configurations, positions, and trade history are stored locally
- No data is sent to external servers except:
  - TrenchScan API calls (for token analysis)
  - Solana RPC calls (for trading transactions)
  - OpenClaw hook callbacks (for realtime alerts)

## Responsible Disclosure

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** create a public GitHub issue
2. Email: **security@trenchscan.lol**
3. Include a detailed description and steps to reproduce
4. We will acknowledge receipt within 48 hours and work on a fix

Thank you for helping keep TrenchScan secure.
