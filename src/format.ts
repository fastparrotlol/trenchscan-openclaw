import type { KolTradeData, BundleData, BundleDumpAlert, TokenNewData, SolPriceData, TradeRecord, PluginMetrics } from "./types.js";
import type { Position } from "./positions.js";

// ── Helpers ─────────────────────────────────────────────────────────

export function sol(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}

export function pct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

export function ago(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function usd(v: number): string {
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ── Event Formatters ────────────────────────────────────────────────

export function formatKolTrade(d: KolTradeData): string {
  const side = d.is_buy ? "BUY" : "SELL";
  const symbol = d.token_symbol ? `$${d.token_symbol}` : d.mint.slice(0, 8) + "…";
  return `KOL ${d.kol_name} ${side} ${d.sol_amount.toFixed(2)} SOL on ${symbol} @ ${usd(d.market_cap_usd)} mcap`;
}

export function formatBundleDetected(d: BundleData): string {
  const symbol = d.token_symbol ? `$${d.token_symbol}` : d.mint.slice(0, 8) + "…";
  return `Bundle detected on ${symbol}: ${d.wallet_count} wallets, ${sol(d.total_sol)} SOL, ${d.supply_pct.toFixed(1)}% supply`;
}

export function formatBundleDumpAlert(d: BundleDumpAlert): string {
  return `BUNDLE DUMP ALERT: ${d.pct_sold.toFixed(0)}% sold in ${d.time_since_creation_secs}s on ${d.mint} — ${d.wallets_selling} wallets selling`;
}

export function formatTokenNew(d: TokenNewData): string {
  const symbol = d.symbol ? `$${d.symbol}` : d.mint.slice(0, 8) + "…";
  const name = d.name ?? "unknown";
  return `New token: ${symbol} (${name}) @ ${usd(d.market_cap_usd)} mcap`;
}

export function formatSolPrice(d: SolPriceData): string {
  return `SOL price: $${d.price_usd.toFixed(2)}`;
}

// ── Batch Summary ───────────────────────────────────────────────────

export function formatBatchSummary(lines: string[]): string {
  if (lines.length === 0) return "";
  if (lines.length === 1) return lines[0];
  return lines.join("\n");
}

// ── Tool Response Formatters (mirror MCP) ───────────────────────────

export function formatCheckToken(data: any): string {
  const t = data.token;
  const lines: string[] = [
    `Token: $${t.symbol} (${t.name})`,
    `Mint: ${t.mint}`,
    `Price: ${t.price_sol} SOL | MCap: ${usd(t.market_cap_usd)}`,
    `Volume: ${t.volume_sol?.toFixed(2)} SOL | Traders: ${t.trader_count}`,
    `Buys: ${t.buy_count} | Sells: ${t.sell_count} | Ratio: ${t.sell_count ? (t.buy_count / t.sell_count).toFixed(2) : "∞"}`,
    `Bonding: ${pct(t.bonding_progress)}`,
    `Created: ${ago(t.created_at_ms)}`,
    `Deployer: ${t.deployer}`,
  ];

  if (data.dev_score) {
    const d = data.dev_score;
    lines.push("", `── Deployer Score ──`, `Label: ${d.label} | Score: ${d.score}/100`, `Created: ${d.tokens_created} | Rugged: ${d.tokens_rugged} | Survived: ${d.tokens_survived}`);
  }

  if (data.bundles?.length) {
    lines.push("", `── Bundles (${data.bundles.length}) ──`);
    for (const b of data.bundles) {
      lines.push(`  ${b.wallet_count} wallets | ${sol(b.total_sol)} SOL | ${b.supply_pct?.toFixed(1)}% supply`);
    }
  }

  if (data.bundle_sells) {
    const bs = data.bundle_sells;
    lines.push(`Bundle sells: ${sol(bs.total_sol_out)} SOL out of ${sol(bs.total_sol_in)} SOL in | Remaining: ${bs.remaining_supply_pct?.toFixed(1)}% supply`);
  }

  if (data.kol_trades?.length) {
    lines.push("", `── KOL Trades (${data.kol_trades.length}) ──`);
    for (const k of data.kol_trades.slice(0, 10)) {
      lines.push(`  ${k.kol_name}: ${k.is_buy ? "BUY" : "SELL"} ${k.sol_amount?.toFixed(2)} SOL @ ${usd(k.market_cap)} mcap (${ago(k.ts)})`);
    }
  }

  return lines.join("\n");
}

export function formatCheckBundle(data: any): string {
  const lines: string[] = [];

  if (!data.bundles?.length) {
    lines.push("No bundles detected for this token.");
  } else {
    lines.push(`Bundles detected: ${data.bundles.length}`);
    for (const b of data.bundles) {
      lines.push("", `Bundle: ${b.wallet_count} wallets | ${sol(b.total_sol)} SOL | ${b.supply_pct?.toFixed(1)}% supply`, `  Creator: ${b.creator}`, `  Detected: ${ago(b.detected_at_ms)}`, `  Tx: ${b.creation_tx}`);
      if (b.wallets?.length) {
        for (const w of b.wallets.slice(0, 5)) {
          lines.push(`    ${w.wallet.slice(0, 8)}… ${sol(w.sol_amount)} SOL`);
        }
        if (b.wallets.length > 5) lines.push(`    ...and ${b.wallets.length - 5} more`);
      }
    }
  }

  if (data.sell_state) {
    const s = data.sell_state;
    lines.push("", `── Sell Activity ──`, `Total in: ${sol(s.total_sol_in)} SOL | Total out: ${sol(s.total_sol_out)} SOL`, `Remaining supply: ${s.remaining_supply_pct?.toFixed(1)}%`);
    if (s.wallet_sells?.length) {
      for (const ws of s.wallet_sells.slice(0, 5)) {
        lines.push(`  ${ws.wallet.slice(0, 8)}… sold ${ws.sell_count}x | ${sol(ws.sol_out)} SOL out | ${ago(ws.last_sell_ms)}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatCheckDeployer(data: any): string {
  const d = data.deployer;
  const lines: string[] = [
    `Deployer: ${d.wallet}`,
    `Score: ${d.score}/100 | Label: ${d.label}`,
    `Tokens created: ${d.tokens_created} | Rugged: ${d.tokens_rugged} | Survived: ${d.tokens_survived}`,
    `Avg sell mcap: ${usd(d.avg_sell_mcap)}`,
  ];

  if (data.history?.length) {
    lines.push("", `── History (${data.history.length} tokens) ──`);
    for (const h of data.history.slice(0, 10)) {
      lines.push(`  ${h.mint.slice(0, 12)}… score: ${h.score} | label: ${h.label}`);
    }
  }

  return lines.join("\n");
}

export function formatKolTrades(data: any, wallet?: string, period?: string): string {
  if (wallet) {
    const k = data.kol;
    const lines: string[] = [
      `KOL: ${k.name} (@${k.twitter})`,
      `Wallet: ${k.wallet}`,
      `Trades: ${data.stats?.total_trades} | Buy vol: ${data.stats?.buy_volume_sol?.toFixed(2)} SOL | Sell vol: ${data.stats?.sell_volume_sol?.toFixed(2)} SOL`,
    ];
    if (data.recent_trades?.length) {
      lines.push("", `── Recent Trades ──`);
      for (const t of data.recent_trades.slice(0, 15)) {
        lines.push(`  ${t.is_buy ? "BUY" : "SELL"} ${t.sol_amount?.toFixed(2)} SOL @ ${usd(t.market_cap)} mcap (${ago(t.ts)})`);
      }
    }
    return lines.join("\n");
  }

  const lines: string[] = [`KOL Leaderboard (${period || "24h"})`, ""];
  for (const [i, k] of (data.leaderboard || []).entries()) {
    lines.push(`${i + 1}. ${k.kol_name} — ${k.trade_count} trades | PnL: ${k.pnl_sol?.toFixed(2)} SOL | ${k.token_count} tokens`);
  }
  return lines.join("\n");
}

export function formatMarketOverview(data: any): string {
  return [
    `── Market Overview ──`,
    `SOL Price: $${data.sol_price_usd?.toFixed(2)}`,
    `Active Tokens: ${data.active_tokens}`,
    `  Bonding: ${data.bonding_tokens} | Migrated: ${data.migrated_tokens}`,
    `Total Volume: ${data.total_volume_sol?.toFixed(1)} SOL`,
    `Avg MCap: ${usd(data.avg_mcap_usd)} | Median: ${usd(data.median_mcap_usd)} | Max: ${usd(data.max_mcap_usd)}`,
  ].join("\n");
}

export function formatAssessRisk(data: any): string {
  const lines: string[] = [
    `── Risk Assessment ──`,
    `Token: ${data.mint}`,
    `Risk Score: ${data.risk_score}/100 → ${data.recommendation?.toUpperCase()}`,
    "",
  ];

  const f = data.factors;
  if (f?.dev_score) {
    const d = f.dev_score;
    lines.push(`Dev Score (contribution: ${d.risk_contribution?.toFixed(1)})`, `  Label: ${d.label} | Score: ${d.score}/100`, `  Created: ${d.tokens_created} | Rugged: ${d.tokens_rugged} | Rug rate: ${d.rug_rate?.toFixed(1)}%`, "");
  }
  if (f?.bundle) {
    const b = f.bundle;
    lines.push(`Bundle (contribution: ${b.risk_contribution?.toFixed(1)})`, `  Detected: ${b.detected} | Wallets: ${b.wallet_count} | Supply: ${b.supply_pct?.toFixed(1)}%`, `  Sell progress: ${b.sell_progress?.toFixed(1)}% | Behavior: ${b.behavior}`, "");
  }
  if (f?.market) {
    const m = f.market;
    lines.push(`Market (contribution: ${m.risk_contribution?.toFixed(1)})`, `  Age: ${m.age_seconds}s | Bonding: ${pct(m.bonding_progress)}`, `  Volume: ${m.volume_sol?.toFixed(2)} SOL | Traders: ${m.trader_count}`, `  Buy/Sell ratio: ${m.buy_sell_ratio?.toFixed(2)} | MCap: ${usd(m.market_cap_usd)}`);
  }

  return lines.join("\n");
}

export function formatDiscoverTokens(data: any): string {
  const lines: string[] = [`Tokens found: ${data.total} (showing ${data.tokens?.length})`, ""];
  for (const t of data.tokens || []) {
    lines.push(`$${t.symbol} | MCap: ${usd(t.market_cap_usd)} | Vol: ${t.volume_sol?.toFixed(1)} SOL | Bonding: ${pct(t.bonding_progress)} | B/S: ${t.buy_count}/${t.sell_count}`, `  ${t.mint}`);
  }
  return lines.join("\n");
}

// ── New Formatters ──────────────────────────────────────────────────

export function formatTradeHistory(records: TradeRecord[]): string {
  if (records.length === 0) return "No trades recorded yet.";

  const lines: string[] = [`Trade History (${records.length} trades):`, ""];
  for (const r of records) {
    const side = r.side.toUpperCase();
    const time = ago(r.timestamp);
    const mintShort = r.mint.slice(0, 8) + "…";
    lines.push(`${side} ${r.solAmount.toFixed(4)} SOL | ${mintShort} | ${r.mode} | ${r.reason} | ${time}`);
    if (r.signature) lines.push(`  tx: ${r.signature}`);
  }
  return lines.join("\n");
}

export function formatPositions(positions: Position[]): string {
  if (positions.length === 0) return "No open positions.";

  const lines: string[] = [`Open Positions (${positions.length}):`, ""];
  for (const p of positions) {
    const mintShort = p.mint.slice(0, 8) + "…";
    const heldMin = Math.round((Date.now() - p.openedAt) / 60_000);
    const tiers = p.tpTiersFired.length > 0 ? ` | TP tiers fired: ${p.tpTiersFired.length}` : "";
    lines.push(`${mintShort} | Strategy: ${p.strategy} | Entry: ${p.entryPriceSol.toFixed(8)} SOL | Spent: ${p.solSpent.toFixed(4)} SOL | Held: ${heldMin}min${tiers}`);
  }
  return lines.join("\n");
}

export function formatHealth(metrics: PluginMetrics): string {
  const uptimeMin = Math.round(metrics.uptime / 60_000);
  return [
    `── Plugin Health ──`,
    `WS: ${metrics.wsConnected ? "Connected" : "Disconnected"} | Reconnects: ${metrics.wsReconnects}`,
    `Events received: ${metrics.eventsReceived}`,
    `Trades executed: ${metrics.tradesExecuted}`,
    `API calls: ${metrics.apiCallsCount}`,
    `Open positions: ${metrics.openPositions}`,
    `Daily SOL spent: ${metrics.dailySolSpent.toFixed(4)}`,
    `Uptime: ${uptimeMin}min`,
  ].join("\n");
}

export function formatPositionUpdate(mint: string, entryPrice: number, currentPrice: number): string {
  const changePct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const sign = changePct >= 0 ? "+" : "";
  return `${mint.slice(0, 8)}… | Entry: ${entryPrice.toFixed(8)} → ${currentPrice.toFixed(8)} SOL (${sign}${changePct.toFixed(1)}%)`;
}
