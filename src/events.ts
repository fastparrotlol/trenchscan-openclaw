import WebSocket from "ws";
import type { PluginConfig, WsEvent, StrategyAction, TokenNewData, TradeData, KolTradeData, PluginMetrics, WithdrawConfig, AlertFilter, OpenClawPluginAPI } from "./types.js";
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

  // Feature 7: Multi-KOL confluence
  private kolConfluence = new Map<string, { kols: Set<string>; firstSeen: number; event: KolTradeData }>();
  private confluenceCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Feature 5: Sniper sell tracking
  private sniperSells = new Map<string, Set<string>>();

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
    // Cleanup stale confluence entries every 60s
    this.confluenceCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [mint, entry] of this.kolConfluence) {
        const maxWindow = 600_000; // 10min max
        if (now - entry.firstSeen > maxWindow) {
          this.kolConfluence.delete(mint);
        }
      }
    }, 60_000);

    // Timer to check max_hold_minutes for all positions every 10s
    this.holdTimer = setInterval(() => {
      if (!this.positionManager || !this.config.tradingEnabled) return;
      const signals = this.positionManager.evaluateAllTimers();
      for (const signal of signals) {
        this.executeExit(signal);
      }
    }, 1_000);
  }

  stop(): void {
    this.destroyed = true;
    if (this.batchTimer) clearInterval(this.batchTimer);
    if (this.holdTimer) clearInterval(this.holdTimer);
    if (this.confluenceCleanupTimer) clearInterval(this.confluenceCleanupTimer);
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

    // Auto-add channels needed by strategies
    if (this.strategyManager && this.config.tradingEnabled) {
      const strategies = this.strategyManager.list().filter((s) => s.active);
      const needsSmartMoney = strategies.some((s) => s.entry.trigger === "smart_money_buy");
      const needsWhale = strategies.some((s) => s.entry.trigger === "whale_buy");
      const needsSniper = strategies.some((s) => s.exit.sniper_exit);
      if ((needsSmartMoney || needsSniper) && !channels.includes("smart_money")) {
        channels.push("smart_money");
      }
      if (needsWhale && !channels.includes("whale_alerts")) {
        channels.push("whale_alerts");
      }
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

    // trade events: smart_money/whale triggers + sniper tracking
    if (type === "trade" && this.config.tradingEnabled) {
      this.handleTradeEvent(msg.data as TradeData);
      return;
    }

    // token_update: position exit evaluation + DCA
    if (type === "token_update") {
      if (this.positionManager && this.config.tradingEnabled) {
        const signal = this.positionManager.evaluatePrice(msg.data.mint, msg.data.price_sol);
        if (signal) {
          this.executeExit(signal);
        } else {
          // No exit → check DCA
          this.evaluateDca(msg.data.mint, msg.data.price_sol);
        }
      }
      return;
    }

    // token_new: evaluate low_risk strategies
    if (type === "token_new" && this.config.tradingEnabled) {
      this.evaluateLowRiskStrategies(msg.data as TokenNewData);
    }

    // kol_trade: confluence tracking + KOL sell exit
    if (type === "kol_trade" && this.config.tradingEnabled) {
      const kolData = msg.data as KolTradeData;
      if (kolData.is_buy) {
        this.handleKolConfluence(kolData);
      } else {
        this.handleKolSellExit(kolData);
      }
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

  // ── Trade Event Handling (smart_money / whale / sniper) ──────────

  private handleTradeEvent(data: TradeData): void {
    if (!this.strategyManager) return;

    // Feature 5: Track sniper sells
    if (!data.is_buy && data.labels.includes("sniper") && this.positionManager) {
      const snipers = this.sniperSells.get(data.mint);
      if (snipers) {
        snipers.add(data.wallet);
      } else {
        this.sniperSells.set(data.mint, new Set([data.wallet]));
      }

      // Check sniper exit for positions on this mint
      const pos = this.positionManager.getPosition(data.mint);
      if (pos?.exitRules.sniper_exit) {
        const count = this.sniperSells.get(data.mint)?.size ?? 0;
        if (count >= pos.exitRules.sniper_exit.min_sellers) {
          this.executeExit({
            mint: data.mint,
            position: pos,
            reason: `${count} snipers selling`,
            sellPercent: 100,
          });
        }
      }
    }

    // Evaluate strategies (smart_money_buy / whale_buy)
    if (data.is_buy) {
      const actions = this.strategyManager.evaluate({ type: "trade", data });
      for (const action of actions) {
        this.executeStrategyAction(action);
      }
    }
  }

  // ── KOL Confluence (Feature 7) ─────────────────────────────────

  private handleKolConfluence(data: KolTradeData): void {
    if (!this.strategyManager) return;

    const strategies = this.strategyManager.list().filter(
      (s) => s.active && s.entry.trigger === "kol_buy" && (s.entry.conditions.min_kol_count ?? 0) > 1,
    );
    if (strategies.length === 0) return;

    // Filter by KOL names if specified in any strategy
    const entry = this.kolConfluence.get(data.mint);
    const now = Date.now();

    if (entry) {
      entry.kols.add(data.kol_name.toLowerCase());
    } else {
      this.kolConfluence.set(data.mint, {
        kols: new Set([data.kol_name.toLowerCase()]),
        firstSeen: now,
        event: data,
      });
    }

    const confluenceEntry = this.kolConfluence.get(data.mint)!;

    for (const strategy of strategies) {
      const windowMs = (strategy.entry.conditions.confluence_window_seconds ?? 300) * 1000;
      if (now - confluenceEntry.firstSeen > windowMs) continue;

      // Filter by kol_names if set
      if (strategy.entry.conditions.kol_names?.length) {
        const matchingKols = [...confluenceEntry.kols].filter((k) =>
          strategy.entry.conditions.kol_names!.some((n) => n.toLowerCase() === k),
        );
        if (matchingKols.length < (strategy.entry.conditions.min_kol_count ?? 2)) continue;
      } else {
        if (confluenceEntry.kols.size < (strategy.entry.conditions.min_kol_count ?? 2)) continue;
      }

      // mcap filters
      if (strategy.entry.conditions.min_mcap && data.market_cap_usd < strategy.entry.conditions.min_mcap) continue;
      if (strategy.entry.conditions.max_mcap && data.market_cap_usd > strategy.entry.conditions.max_mcap) continue;

      const kolList = [...confluenceEntry.kols].join(", ");
      this.executeStrategyAction({
        strategy,
        action: "buy",
        mint: data.mint,
        sol_amount: strategy.entry.conditions.sol_amount,
        priceSol: data.price_sol,
        reason: `${confluenceEntry.kols.size} KOLs (${kolList}) bought $${data.token_symbol ?? data.mint.slice(0, 8)} @ $${Math.round(data.market_cap_usd).toLocaleString()} mcap`,
      });

      // Remove from confluence map to avoid re-firing
      this.kolConfluence.delete(data.mint);
      break;
    }
  }

  // ── KOL Sell Exit (Feature 6) ──────────────────────────────────

  private handleKolSellExit(data: KolTradeData): void {
    if (!this.positionManager) return;

    const pos = this.positionManager.getPosition(data.mint);
    if (!pos || !pos.exitRules.kol_sell_exit) return;

    // Check name filter
    if (pos.exitRules.kol_sell_exit_names?.length) {
      const nameMatch = pos.exitRules.kol_sell_exit_names.some(
        (n) => n.toLowerCase() === data.kol_name.toLowerCase(),
      );
      if (!nameMatch) return;
    }

    this.executeExit({
      mint: data.mint,
      position: pos,
      reason: `KOL ${data.kol_name} selling`,
      sellPercent: 100,
    });
  }

  // ── DCA Evaluation (Feature 4) ─────────────────────────────────

  private evaluateDca(mint: string, currentPrice: number): void {
    if (!this.positionManager || !this.tradingEngine || !this.walletManager?.isUnlocked) return;

    const result = this.positionManager.evaluateDca(mint, currentPrice);
    if (!result) return;

    const keypair = this.walletManager.getKeypair();
    this.tradingEngine.buy(mint, result.solAmount, keypair).then((tradeResult) => {
      if (tradeResult.success && this.positionManager) {
        this.positionManager.recordDcaBuy(mint, tradeResult.expectedAmount ?? 0, result.solAmount);
        this.strategyManager?.recordSpend(result.solAmount);
        this.tradesExecuted++;
        this.positionManager.recordTrade({
          mint,
          strategy: this.positionManager.getPosition(mint)?.strategy ?? "dca",
          side: "buy",
          solAmount: result.solAmount,
          tokenAmount: tradeResult.expectedAmount ?? 0,
          priceSol: currentPrice,
          signature: tradeResult.signature ?? "",
          mode: tradeResult.mode,
          reason: `DCA buy #${(this.positionManager.getPosition(mint)?.dcaBuyCount ?? 0)}`,
          timestamp: Date.now(),
        });
        this.postWakeHook(`DCA: bought ${result.solAmount.toFixed(4)} SOL more of ${mint.slice(0, 8)}…`);
      }
    }).catch((e) => {
      this.api.logger.error(`DCA buy failed: ${e instanceof Error ? e.message : e}`);
    });
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
        let solAmt = sol_amount ?? 0.1;

        // Anti-rug + risk scaling (Features 3, 9)
        if (strategy.entry.conditions.max_risk_score != null) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const url = `${this.config.apiUrl}/api/v1/risk/${mint}`;
            const resp = await fetch(url, {
              headers: { "x-api-key": this.config.apiKey },
              signal: controller.signal,
            });
            clearTimeout(timeout);

            if (resp.ok) {
              const riskData = await resp.json() as { risk_score: number };
              if (riskData.risk_score > strategy.entry.conditions.max_risk_score) {
                this.api.logger.info(`Strategy "${strategy.name}": skipping ${mint} — risk ${riskData.risk_score} > max ${strategy.entry.conditions.max_risk_score}`);
                return;
              }
              // Risk scaling
              if (strategy.entry.conditions.risk_scaling) {
                const rs = strategy.entry.conditions.risk_scaling;
                let scalePct: number;
                if (riskData.risk_score <= 20) scalePct = rs.low_pct;
                else if (riskData.risk_score <= 45) scalePct = rs.medium_pct;
                else scalePct = rs.high_pct;
                solAmt = solAmt * scalePct / 100;
              }
            }
          } catch {
            this.api.logger.warn(`Strategy "${strategy.name}": risk check timeout for ${mint}, proceeding`);
          }
        }

        // Fire-and-forget: don't await buy — process result asynchronously
        const dcaConfig = strategy.entry.conditions.dca;
        this.tradingEngine.buy(mint, solAmt, keypair).then((result) => {
          if (result.success) {
            this.strategyManager?.recordSpend(solAmt);
            this.tradesExecuted++;
            if (this.positionManager && result.expectedAmount && action.priceSol) {
              this.positionManager.open(mint, strategy.name, action.priceSol, result.expectedAmount, solAmt, strategy.exit, dcaConfig, solAmt);
            }
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
            this.postWakeHook(`Strategy "${strategy.name}": BUY ${solAmt.toFixed(4)} SOL of ${mint}. ${reason}. Tx: ${result.signature}`);
          } else {
            this.postWakeHook(`Strategy "${strategy.name}": BUY FAILED — ${result.error}. ${reason}`);
          }
        }).catch((e) => {
          this.api.logger.error(`Strategy "${strategy.name}": BUY error — ${e instanceof Error ? e.message : e}`);
        });
        break;
      }

      case "confirm": {
        let riskInfo = "";
        if (strategy.entry.conditions.max_risk_score != null) {
          riskInfo = ` (anti-rug: max risk ${strategy.entry.conditions.max_risk_score})`;
        }
        const message = `${reason}${riskInfo}. Buy ${sol_amount} SOL? Strategy: "${strategy.name}" (confirm mode). Confirm or skip.`;
        this.postAgentHook(message, {});
        break;
      }

      case "alert": {
        let riskInfo = "";
        if (strategy.entry.conditions.max_risk_score != null) {
          riskInfo = ` | Anti-rug: max risk ${strategy.entry.conditions.max_risk_score}`;
        }
        this.postWakeHook(`Strategy "${strategy.name}" match: ${reason}${riskInfo}`);
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

        // Clean up sniper tracking when position closes
        if (sellPercent >= 100) {
          this.sniperSells.delete(mint);
        }

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
