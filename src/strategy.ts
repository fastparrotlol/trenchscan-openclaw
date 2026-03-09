import * as fs from "node:fs";
import * as path from "node:path";
import type { Strategy, StrategyAction, WsEvent, OpenClawPluginAPI } from "./types.js";
import type { PositionManager } from "./positions.js";

export class StrategyManager {
  private strategiesPath: string;
  private strategies: Strategy[] = [];
  private dailySolSpent = 0;
  private dailyResetDate = new Date().toDateString();
  private positionManager: PositionManager | null = null;

  constructor(
    private dataDir: string,
    private api: OpenClawPluginAPI,
  ) {
    this.strategiesPath = path.join(dataDir, "strategies.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.strategiesPath)) {
        const raw = fs.readFileSync(this.strategiesPath, "utf-8");
        this.strategies = JSON.parse(raw) as Strategy[];
        this.api.logger.info( `Loaded ${this.strategies.length} strategies`);
      }
    } catch (e) {
      this.api.logger.warn( `Failed to load strategies: ${e instanceof Error ? e.message : e}`);
    }
  }

  private saveToDisk(): void {
    fs.mkdirSync(path.dirname(this.strategiesPath), { recursive: true });
    fs.writeFileSync(this.strategiesPath, JSON.stringify(this.strategies, null, 2));
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      this.dailySolSpent = 0;
      this.dailyResetDate = today;
    }
  }

  save(strategy: Strategy): void {
    const idx = this.strategies.findIndex((s) => s.name === strategy.name);
    if (idx >= 0) {
      this.strategies[idx] = strategy;
    } else {
      this.strategies.push(strategy);
    }
    this.saveToDisk();
  }

  remove(name: string): boolean {
    const idx = this.strategies.findIndex((s) => s.name === name);
    if (idx < 0) return false;
    this.strategies.splice(idx, 1);
    this.saveToDisk();
    return true;
  }

  list(): Strategy[] {
    return this.strategies;
  }

  evaluate(event: WsEvent): StrategyAction[] {
    this.resetDailyIfNeeded();
    const actions: StrategyAction[] = [];
    const active = this.strategies.filter((s) => s.active);

    for (const strategy of active) {
      const action = this.evaluateStrategy(strategy, event);
      if (action) actions.push(action);
    }

    return actions;
  }

  recordSpend(sol: number): void {
    this.resetDailyIfNeeded();
    this.dailySolSpent += sol;
  }

  setPositionManager(pm: PositionManager): void {
    this.positionManager = pm;
  }

  private evaluateStrategy(strategy: Strategy, event: WsEvent): StrategyAction | null {
    const { entry } = strategy;

    // Check trigger type against event type
    switch (entry.trigger) {
      case "kol_buy":
        if (event.type !== "kol_trade") return null;
        if (!event.data.is_buy) return null;
        // Filter by KOL names if specified
        if (entry.conditions.kol_names && entry.conditions.kol_names.length > 0) {
          const nameMatch = entry.conditions.kol_names.some(
            (n) => n.toLowerCase() === event.data.kol_name.toLowerCase(),
          );
          if (!nameMatch) return null;
        }
        // Market cap filters
        if (entry.conditions.min_mcap && event.data.market_cap_usd < entry.conditions.min_mcap) return null;
        if (entry.conditions.max_mcap && event.data.market_cap_usd > entry.conditions.max_mcap) return null;
        // Limits check
        if (!this.checkLimits(strategy)) return null;

        return {
          strategy,
          action: "buy",
          mint: event.data.mint,
          sol_amount: entry.conditions.sol_amount,
          priceSol: event.data.price_sol,
          reason: `KOL ${event.data.kol_name} bought $${event.data.token_symbol ?? event.data.mint.slice(0, 8)} @ $${Math.round(event.data.market_cap_usd).toLocaleString()} mcap`,
        };

      case "new_token":
        if (event.type !== "token_new") return null;
        if (entry.conditions.min_mcap && event.data.market_cap_usd < entry.conditions.min_mcap) return null;
        if (entry.conditions.max_mcap && event.data.market_cap_usd > entry.conditions.max_mcap) return null;
        if (!this.checkLimits(strategy)) return null;

        return {
          strategy,
          action: "buy",
          mint: event.data.mint,
          sol_amount: entry.conditions.sol_amount,
          priceSol: event.data.price_sol,
          reason: `New token $${event.data.symbol ?? event.data.mint.slice(0, 8)} @ $${Math.round(event.data.market_cap_usd).toLocaleString()} mcap`,
        };

      case "low_risk":
        // low_risk trigger fires on kol_trade events where we'd need to check risk separately
        // This is handled at the events.ts level where risk API is called
        return null;

      default:
        return null;
    }
  }

  private checkLimits(strategy: Strategy): boolean {
    const { limits } = strategy;
    const solAmount = strategy.entry.conditions.sol_amount;

    // Max open positions
    if (this.positionManager && this.positionManager.count() >= limits.max_open_positions) {
      this.api.logger.warn(`Strategy "${strategy.name}": max_open_positions reached (${this.positionManager.count()}/${limits.max_open_positions})`);
      return false;
    }

    // Daily SOL limit
    if (this.dailySolSpent + solAmount > limits.max_daily_sol) {
      this.api.logger.warn( `Strategy "${strategy.name}": daily SOL limit reached (${this.dailySolSpent}/${limits.max_daily_sol})`);
      return false;
    }

    // Per-trade limit
    if (solAmount > limits.max_sol_per_trade) {
      this.api.logger.warn( `Strategy "${strategy.name}": trade exceeds max_sol_per_trade`);
      return false;
    }

    return true;
  }
}
