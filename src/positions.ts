import type { Strategy, OpenClawPluginAPI } from "./types.js";

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

  constructor(private api: OpenClawPluginAPI) {}

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
    });
    this.api.logger.info(`Position opened: ${mint} @ ${entryPriceSol} SOL (strategy: ${strategy})`);
  }

  close(mint: string): void {
    this.positions.delete(mint);
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

  /** O(1) — evaluate a single price update against an open position */
  evaluatePrice(mint: string, currentPriceSol: number): ExitSignal | null {
    const pos = this.positions.get(mint);
    if (!pos) return null;

    const { exitRules, entryPriceSol } = pos;
    const changePct = ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100;

    // Take profit
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

    // Trailing stop — update high water mark, then check drawdown from peak
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

  /** O(n) — check max_hold_minutes for all open positions */
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
}
