import WebSocket from "ws";
import type { PluginConfig, WsEvent, StrategyAction, TokenNewData, PluginMetrics, WithdrawConfig, AlertFilter, OpenClawPluginAPI } from "./types.js";
import { EVENT_CHANNEL, EVENT_PRIORITY } from "./types.js";
import {
  formatKolTrade, formatBundleDetected, formatBundleDumpAlert,
  formatTokenNew, formatSolPrice, formatBatchSummary,
} from "./format.js";
import type { StrategyManager } from "./strategy.js";
import type { TradingEngine } from "./trading.js";
import type { WalletManager } from "./wallet.js";
import type { PositionManager, ExitSignal } from "./positions.js";

// ── Event Forwarder ─────────────────────────────────────────────────

export class EventForwarder {
  private ws: WebSocket | null = null;
  private batch: string[] = [];
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnectDelay = 1000;

  private strategyManager: StrategyManager | null = null;
  private tradingEngine: TradingEngine | null = null;
  private walletManager: WalletManager | null = null;
  private positionManager: PositionManager | null = null;
  private holdTimer: ReturnType<typeof setInterval> | null = null;

  // Metrics
  private wsReconnects = 0;
  private eventsReceived = 0;
  private tradesExecuted = 0;
  private apiCallsCount = 0;
  private startedAt = Date.now();

  // Rate limiter (token bucket by timestamps)
  private apiCallTimestamps: number[] = [];

  // Runtime mutable config
  private withdrawConfig: WithdrawConfig | undefined;
  private alertFilters: AlertFilter | undefined;
  private rateLimitRpm: number;

  constructor(
    private config: PluginConfig,
    private api: OpenClawPluginAPI,
  ) {
    this.withdrawConfig = config.withdrawConfig;
    this.alertFilters = config.alertFilters;
    this.rateLimitRpm = config.rateLimitRpm ?? 60;
  }

  setTrading(strategyManager: StrategyManager, tradingEngine: TradingEngine, walletManager: WalletManager, positionManager: PositionManager): void {
    this.strategyManager = strategyManager;
    this.tradingEngine = tradingEngine;
    this.walletManager = walletManager;
    this.positionManager = positionManager;
  }

  setWithdrawConfig(wc: WithdrawConfig): void {
    this.withdrawConfig = wc;
  }

  start(): void {
    this.connect();
    if (this.config.batchWindowSec > 0) {
      this.batchTimer = setInterval(() => this.flush(), this.config.batchWindowSec * 1000);
    }
    // Timer to check max_hold_minutes for all positions every 10s
    this.holdTimer = setInterval(() => {
      if (!this.positionManager || !this.config.tradingEnabled) return;
      const signals = this.positionManager.evaluateAllTimers();
      for (const signal of signals) {
        this.executeExit(signal);
      }
    }, 10_000);
  }

  stop(): void {
    this.destroyed = true;
    if (this.batchTimer) clearInterval(this.batchTimer);
    if (this.holdTimer) clearInterval(this.holdTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.flush();
  }

  getMetrics(): PluginMetrics {
    return {
      wsConnected: this.ws?.readyState === WebSocket.OPEN,
      wsReconnects: this.wsReconnects,
      eventsReceived: this.eventsReceived,
      tradesExecuted: this.tradesExecuted,
      apiCallsCount: this.apiCallsCount,
      uptime: Date.now() - this.startedAt,
      openPositions: this.positionManager?.count() ?? 0,
      dailySolSpent: this.positionManager?.getDailySolSpent() ?? 0,
    };
  }

  // ── WS Connection ───────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;

    const url = `${this.config.wsUrl}?key=${this.config.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.api.logger.info("WS connected to TrenchScan");
      this.reconnectDelay = 1000;
      this.subscribe();
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch {
        // ignore unparseable messages
      }
    });

    this.ws.on("close", () => {
      this.api.logger.warn("WS disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.api.logger.error(`WS error: ${err.message}`);
      this.ws?.close();
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const channels = [...this.config.alertChannels];
    if (this.config.tradingEnabled && !channels.includes("tokens")) {
      channels.push("tokens");
    }

    const msg: Record<string, unknown> = {
      action: "subscribe",
      channels,
    };

    const filter: Record<string, number> = {};
    if (this.config.minMcap > 0) filter.min_mcap = this.config.minMcap;
    if (this.config.maxMcap > 0) filter.max_mcap = this.config.maxMcap;
    if (Object.keys(filter).length > 0) msg.filter = filter;

    this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.wsReconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.api.logger.info(`WS reconnecting (delay: ${this.reconnectDelay}ms)`);
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  // ── Rate Limiter ──────────────────────────────────────────────────

  private checkRateLimit(): boolean {
    const now = Date.now();
    this.apiCallTimestamps = this.apiCallTimestamps.filter((t) => now - t < 60_000);
    if (this.apiCallTimestamps.length >= this.rateLimitRpm) return false;
    this.apiCallTimestamps.push(now);
    this.apiCallsCount++;
    return true;
  }

  // ── Alert Filtering ───────────────────────────────────────────────

  private matchesAlertFilter(msg: any): boolean {
    if (!this.alertFilters) return true;

    const mint: string | undefined = msg.data?.mint;
    const symbol: string | undefined = msg.data?.token_symbol ?? msg.data?.symbol;

    // Blacklist check
    if (mint && this.alertFilters.excludeMints?.includes(mint)) return false;

    // Whitelist checks — if whitelists exist, must match at least one
    const hasWhitelist = (this.alertFilters.mints?.length ?? 0) > 0 || (this.alertFilters.symbols?.length ?? 0) > 0;
    if (!hasWhitelist) return true;

    if (mint && this.alertFilters.mints?.includes(mint)) return true;
    if (symbol && this.alertFilters.symbols?.some((s) => s.toLowerCase() === symbol.toLowerCase())) return true;

    return !hasWhitelist;
  }

  // ── Message Handling ────────────────────────────────────────────

  private handleMessage(msg: any): void {
    const type = msg.type as WsEvent["type"] | undefined;
    if (!type || !msg.data) return;

    const channel = EVENT_CHANNEL[type];
    if (!channel) return;

    this.eventsReceived++;

    // bundle_dump_alert → position exit (independent of channel subscription)
    if (type === "bundle_dump_alert" && this.positionManager && this.config.tradingEnabled) {
      const signal = this.positionManager.evaluateBundleDump(msg.data.mint);
      if (signal) this.executeExit(signal);
    }

    // token_update: position exit evaluation + low_risk not applicable here
    if (type === "token_update") {
      if (this.positionManager && this.config.tradingEnabled) {
        const signal = this.positionManager.evaluatePrice(msg.data.mint, msg.data.price_sol);
        if (signal) this.executeExit(signal);
      }
      return;
    }

    // token_new: evaluate low_risk strategies
    if (type === "token_new" && this.config.tradingEnabled) {
      this.evaluateLowRiskStrategies(msg.data as TokenNewData);
    }

    // Check if this channel is in our subscription
    if (!this.config.alertChannels.includes(channel)) return;

    // Alert filtering
    if (!this.matchesAlertFilter(msg)) return;

    // Evaluate strategies before formatting
    if (this.strategyManager && this.config.tradingEnabled) {
      const actions = this.strategyManager.evaluate(msg as WsEvent);
      for (const action of actions) {
        this.executeStrategyAction(action);
      }
    }

    const priority = EVENT_PRIORITY[type];
    const formatted = this.formatEvent(msg as WsEvent);
    if (!formatted) return;

    if (priority === "high") {
      this.postAgentHook(formatted, msg);
    } else if (this.config.batchWindowSec === 0) {
      this.postWakeHook(formatted);
    } else {
      this.batch.push(formatted);
    }
  }

  private formatEvent(event: WsEvent): string | null {
    switch (event.type) {
      case "kol_trade": return formatKolTrade(event.data);
      case "bundle_detected": return formatBundleDetected(event.data);
      case "bundle_dump_alert": return formatBundleDumpAlert(event.data);
      case "token_new": return formatTokenNew(event.data);
      case "sol_price": return formatSolPrice(event.data);
      default: return null;
    }
  }

  // ── Low Risk Evaluation ───────────────────────────────────────────

  private async evaluateLowRiskStrategies(tokenData: TokenNewData): Promise<void> {
    if (!this.strategyManager || !this.tradingEngine || !this.walletManager || !this.positionManager) return;

    const strategies = this.strategyManager.list().filter(
      (s) => s.active && s.entry.trigger === "low_risk",
    );
    if (strategies.length === 0) return;

    // mcap prefilter
    const matching = strategies.filter((s) => {
      const { min_mcap, max_mcap } = s.entry.conditions;
      if (min_mcap && tokenData.market_cap_usd < min_mcap) return false;
      if (max_mcap && tokenData.market_cap_usd > max_mcap) return false;
      return true;
    });
    if (matching.length === 0) return;

    // Rate limit check
    if (!this.checkRateLimit()) {
      this.api.logger.warn("Rate limit reached, skipping low_risk evaluation");
      return;
    }

    try {
      const url = `${this.config.apiUrl}/api/v1/risk/${tokenData.mint}`;
      const resp = await fetch(url, {
        headers: { "x-api-key": this.config.apiKey },
      });
      if (!resp.ok) return;

      const data = await resp.json() as { risk_score: number };

      for (const strategy of matching) {
        const maxRisk = strategy.entry.conditions.max_risk_score;
        if (maxRisk != null && data.risk_score <= maxRisk) {
          const action: StrategyAction = {
            strategy,
            action: "buy",
            mint: tokenData.mint,
            sol_amount: strategy.entry.conditions.sol_amount,
            priceSol: tokenData.price_sol,
            reason: `Low risk (${data.risk_score}) on $${tokenData.symbol ?? tokenData.mint.slice(0, 8)} @ $${Math.round(tokenData.market_cap_usd).toLocaleString()} mcap`,
          };
          this.executeStrategyAction(action);
        }
      }
    } catch (e) {
      this.api.logger.error(`Risk API call failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── Strategy Execution ──────────────────────────────────────────

  private async executeStrategyAction(action: StrategyAction): Promise<void> {
    const { strategy, mint, sol_amount, reason } = action;

    switch (strategy.mode) {
      case "autonomous": {
        if (!this.tradingEngine || !this.walletManager?.isUnlocked) {
          this.api.logger.warn(`Strategy "${strategy.name}": wallet not unlocked, skipping autonomous trade`);
          return;
        }
        const keypair = this.walletManager.getKeypair();
        const solAmt = sol_amount ?? 0.1;
        const result = await this.tradingEngine.buy(mint, solAmt, keypair);
        if (result.success) {
          this.strategyManager?.recordSpend(solAmt);
          this.tradesExecuted++;
          if (this.positionManager && result.expectedAmount && action.priceSol) {
            this.positionManager.open(mint, strategy.name, action.priceSol, result.expectedAmount, solAmt, strategy.exit);
          }
          // Record trade
          this.positionManager?.recordTrade({
            mint,
            strategy: strategy.name,
            side: "buy",
            solAmount: solAmt,
            tokenAmount: result.expectedAmount ?? 0,
            priceSol: action.priceSol ?? 0,
            signature: result.signature ?? "",
            mode: result.mode,
            reason,
            timestamp: Date.now(),
          });
          this.postWakeHook(`Strategy "${strategy.name}": BUY ${solAmt} SOL of ${mint}. ${reason}. Tx: ${result.signature}`);
        } else {
          this.postWakeHook(`Strategy "${strategy.name}": BUY FAILED — ${result.error}. ${reason}`);
        }
        break;
      }

      case "confirm": {
        const message = `${reason}. Buy ${sol_amount} SOL? Strategy: "${strategy.name}" (confirm mode). Confirm or skip.`;
        this.postAgentHook(message, {});
        break;
      }

      case "alert": {
        this.postWakeHook(`Strategy "${strategy.name}" match: ${reason}`);
        break;
      }
    }
  }

  // ── Exit Execution ─────────────────────────────────────────────

  private async executeExit(signal: ExitSignal): Promise<void> {
    if (!this.tradingEngine || !this.walletManager?.isUnlocked || !this.positionManager) return;

    const { mint, position, reason, sellPercent } = signal;
    const sellAmount = Math.floor(position.tokenAmount * (sellPercent / 100));

    try {
      const keypair = this.walletManager.getKeypair();
      const result = await this.tradingEngine.sell(mint, sellAmount, keypair);

      if (result.success) {
        this.tradesExecuted++;

        // Record trade
        this.positionManager.recordTrade({
          mint,
          strategy: position.strategy,
          side: "sell",
          solAmount: result.expectedAmount ?? 0,
          tokenAmount: sellAmount,
          priceSol: position.entryPriceSol,
          signature: result.signature ?? "",
          mode: result.mode,
          reason,
          timestamp: Date.now(),
        });

        if (sellPercent >= 100) {
          this.positionManager.close(mint);
        } else {
          // Partial sell — find tier index if applicable
          const tiers = position.exitRules.take_profit_tiers;
          let tierIdx: number | undefined;
          if (tiers?.length) {
            const sorted = [...tiers].sort((a, b) => a.pct - b.pct);
            tierIdx = sorted.findIndex((t) => t.sell_pct === sellPercent && !position.tpTiersFired.includes(sorted.indexOf(t)));
            if (tierIdx < 0) tierIdx = undefined;
          }
          this.positionManager.reducePosition(mint, sellPercent, tierIdx);
        }

        this.postWakeHook(`EXIT: sold ${sellPercent}% of ${mint.slice(0, 8)} — ${reason}. Tx: ${result.signature}`);

        // Auto-withdraw after sell
        if (this.withdrawConfig?.enabled && this.withdrawConfig.afterEveryTrade && result.expectedAmount) {
          const profit = result.expectedAmount - (position.solSpent * sellPercent / 100);
          if (profit > 0) {
            try {
              let withdrawAmount = profit;
              if (this.withdrawConfig.mode === "percent" && this.withdrawConfig.percent) {
                withdrawAmount = profit * this.withdrawConfig.percent / 100;
              }
              if (withdrawAmount > 0.001) {
                const sig = await this.walletManager.transferSol(this.withdrawConfig.destination, withdrawAmount);
                this.api.logger.info(`Auto-withdraw ${withdrawAmount.toFixed(4)} SOL → ${this.withdrawConfig.destination}: ${sig}`);
              }
            } catch (e) {
              this.api.logger.error(`Auto-withdraw failed: ${e instanceof Error ? e.message : e}`);
            }
          }
        }
      } else {
        this.api.logger.error(`Exit sell failed for ${mint}: ${result.error}`);
      }
    } catch (e) {
      this.api.logger.error(`Exit execution error for ${mint}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── Hook Posting ────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    const lines = this.batch.splice(0);
    const text = formatBatchSummary(lines);
    await this.postWakeHook(text);
  }

  private async postWakeHook(text: string): Promise<void> {
    try {
      const url = `${this.config.hookBaseUrl}/hooks/wake`;
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.hookToken}`,
        },
        body: JSON.stringify({ text, mode: "now" }),
      });
    } catch (e) {
      this.api.logger.error(`Hook /wake failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async postAgentHook(formatted: string, _raw: any): Promise<void> {
    try {
      const url = `${this.config.hookBaseUrl}/hooks/agent`;
      const message = `${formatted} — assess risk and advise`;
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.hookToken}`,
        },
        body: JSON.stringify({ message, model: "openclaw:main" }),
      });
    } catch (e) {
      this.api.logger.error(`Hook /agent failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
