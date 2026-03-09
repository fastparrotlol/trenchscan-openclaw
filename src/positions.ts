import * as fs from "node:fs";
import * as path from "node:path";
import type { Strategy, TradeRecord, OpenClawPluginAPI } from "./types.js";

// ── Position Types ──────────────────────────────────────────────────

export interface Position {
  mint: string;
  strategy: string;
  entryPriceSol: number;
  tokenAmount: number;
  solSpent: number;
  openedAt: number;
  highWaterMark: number;
  exitRules: Strategy["exit"];
  tpTiersFired: number[];
}

export interface ExitSignal {
  mint: string;
  position: Position;
  reason: string;
  sellPercent: number;
}

// ── Position Manager ────────────────────────────────────────────────

export class PositionManager {
  private positions = new Map<string, Position>();
  private trades: TradeRecord[] = [];
  private positionsPath: string;
  private tradesPath: string;

  constructor(
    private dataDir: string,
    private api: OpenClawPluginAPI,
  ) {
    this.positionsPath = path.join(dataDir, "positions.json");
    this.tradesPath = path.join(dataDir, "trades.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.positionsPath)) {
        const raw = JSON.parse(fs.readFileSync(this.positionsPath, "utf-8")) as Position[];
        for (const p of raw) {
          this.positions.set(p.mint, p);
        }
        this.api.logger.info(`Loaded ${this.positions.size} positions`);
      }
    } catch (e) {
      this.api.logger.warn(`Failed to load positions: ${e instanceof Error ? e.message : e}`);
    }
    try {
      if (fs.existsSync(this.tradesPath)) {
        this.trades = JSON.parse(fs.readFileSync(this.tradesPath, "utf-8")) as TradeRecord[];
        this.api.logger.info(`Loaded ${this.trades.length} trade records`);
      }
    } catch (e) {
      this.api.logger.warn(`Failed to load trades: ${e instanceof Error ? e.message : e}`);
    }
  }

  private savePositions(): void {
    try {
      fs.mkdirSync(path.dirname(this.positionsPath), { recursive: true });
      fs.writeFileSync(this.positionsPath, JSON.stringify(Array.from(this.positions.values()), null, 2));
    } catch (e) {
      this.api.logger.error(`Failed to save positions: ${e instanceof Error ? e.message : e}`);
    }
  }

  private saveTrades(): void {
    try {
      fs.mkdirSync(path.dirname(this.tradesPath), { recursive: true });
      fs.writeFileSync(this.tradesPath, JSON.stringify(this.trades, null, 2));
    } catch (e) {
      this.api.logger.error(`Failed to save trades: ${e instanceof Error ? e.message : e}`);
    }
  }

  open(
    mint: string,
    strategy: string,
    entryPriceSol: number,
    tokenAmount: number,
    solSpent: number,
    exitRules: Strategy["exit"],
  ): void {
    this.positions.set(mint, {
      mint,
      strategy,
      entryPriceSol,
      tokenAmount,
      solSpent,
      openedAt: Date.now(),
      highWaterMark: entryPriceSol,
      exitRules,
      tpTiersFired: [],
    });
    this.savePositions();
    this.api.logger.info(`Position opened: ${mint} @ ${entryPriceSol} SOL (strategy: ${strategy})`);
  }

  close(mint: string): void {
    this.positions.delete(mint);
    this.savePositions();
    this.api.logger.info(`Position closed: ${mint}`);
  }

  getPosition(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  count(): number {
    return this.positions.size;
  }

  countByStrategy(strategyName: string): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.strategy === strategyName) count++;
    }
    return count;
  }

  reducePosition(mint: string, soldPercent: number, tierIndex?: number): void {
    const pos = this.positions.get(mint);
    if (!pos) return;

    pos.tokenAmount = Math.floor(pos.tokenAmount * (1 - soldPercent / 100));
    pos.solSpent = pos.solSpent * (1 - soldPercent / 100);

    if (tierIndex != null && !pos.tpTiersFired.includes(tierIndex)) {
      pos.tpTiersFired.push(tierIndex);
    }

    if (pos.tokenAmount <= 0) {
      this.positions.delete(mint);
    }

    this.savePositions();
  }

  /** Evaluate price with partial TP tiers support */
  evaluatePrice(mint: string, currentPriceSol: number): ExitSignal | null {
    const pos = this.positions.get(mint);
    if (!pos) return null;

    const { exitRules, entryPriceSol } = pos;
    const changePct = ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100;

    // Partial TP tiers — checked BEFORE simple take_profit_pct
    if (exitRules.take_profit_tiers?.length) {
      const sorted = [...exitRules.take_profit_tiers].sort((a, b) => a.pct - b.pct);
      for (let i = 0; i < sorted.length; i++) {
        const tier = sorted[i];
        if (pos.tpTiersFired.includes(i)) continue;
        if (changePct >= tier.pct) {
          return {
            mint,
            position: pos,
            reason: `TP tier ${i + 1}: +${changePct.toFixed(1)}% (≥${tier.pct}%), sell ${tier.sell_pct}%`,
            sellPercent: tier.sell_pct,
          };
        }
      }
    }

    // Take profit (full)
    if (exitRules.take_profit_pct != null && changePct >= exitRules.take_profit_pct) {
      return {
        mint,
        position: pos,
        reason: `TP +${changePct.toFixed(1)}%`,
        sellPercent: 100,
      };
    }

    // Stop loss
    if (exitRules.stop_loss_pct != null && changePct <= -exitRules.stop_loss_pct) {
      return {
        mint,
        position: pos,
        reason: `SL ${changePct.toFixed(1)}%`,
        sellPercent: 100,
      };
    }

    // Trailing stop
    if (exitRules.trailing_stop_pct != null) {
      if (currentPriceSol > pos.highWaterMark) {
        pos.highWaterMark = currentPriceSol;
      }
      const drawdownPct = ((pos.highWaterMark - currentPriceSol) / pos.highWaterMark) * 100;
      if (drawdownPct >= exitRules.trailing_stop_pct) {
        return {
          mint,
          position: pos,
          reason: `Trail -${drawdownPct.toFixed(1)}% from peak`,
          sellPercent: 100,
        };
      }
    }

    // Max hold time
    if (exitRules.max_hold_minutes != null) {
      const heldMinutes = (Date.now() - pos.openedAt) / 60_000;
      if (heldMinutes >= exitRules.max_hold_minutes) {
        return {
          mint,
          position: pos,
          reason: `Hold ${Math.round(heldMinutes)}min`,
          sellPercent: 100,
        };
      }
    }

    return null;
  }

  /** Check if a position should exit on bundle dump */
  evaluateBundleDump(mint: string): ExitSignal | null {
    const pos = this.positions.get(mint);
    if (!pos) return null;
    if (!pos.exitRules.bundle_dump) return null;

    return {
      mint,
      position: pos,
      reason: "Bundle dump detected",
      sellPercent: 100,
    };
  }

  /** Check max_hold_minutes for all open positions */
  evaluateAllTimers(): ExitSignal[] {
    const signals: ExitSignal[] = [];
    const now = Date.now();

    for (const pos of this.positions.values()) {
      if (pos.exitRules.max_hold_minutes == null) continue;
      const heldMinutes = (now - pos.openedAt) / 60_000;
      if (heldMinutes >= pos.exitRules.max_hold_minutes) {
        signals.push({
          mint: pos.mint,
          position: pos,
          reason: `Hold ${Math.round(heldMinutes)}min`,
          sellPercent: 100,
        });
      }
    }

    return signals;
  }

  // ── Trade History ───────────────────────────────────────────────────

  recordTrade(record: TradeRecord): void {
    this.trades.push(record);
    this.saveTrades();
  }

  getHistory(limit?: number, mint?: string): TradeRecord[] {
    let filtered = this.trades;
    if (mint) {
      filtered = filtered.filter((t) => t.mint === mint);
    }
    const sorted = filtered.slice().sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  getRealizedPnl(): { mint: string; pnl: number }[] {
    const byMint = new Map<string, number>();

    for (const t of this.trades) {
      const current = byMint.get(t.mint) ?? 0;
      if (t.side === "sell") {
        byMint.set(t.mint, current + t.solAmount);
      } else {
        byMint.set(t.mint, current - t.solAmount);
      }
    }

    return Array.from(byMint.entries())
      .map(([mint, pnl]) => ({ mint, pnl }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  getDailySolSpent(): number {
    const today = new Date().toDateString();
    let spent = 0;
    for (const t of this.trades) {
      if (t.side === "buy" && new Date(t.timestamp).toDateString() === today) {
        spent += t.solAmount;
      }
    }
    return spent;
  }
}
