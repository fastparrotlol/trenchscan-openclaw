import WebSocket from "ws";
import type { PluginConfig, WsEvent, StrategyAction, OpenClawPluginAPI } from "./types.js";
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

  constructor(
    private config: PluginConfig,
    private api: OpenClawPluginAPI,
  ) {}

  setTrading(strategyManager: StrategyManager, tradingEngine: TradingEngine, walletManager: WalletManager, positionManager: PositionManager): void {
    this.strategyManager = strategyManager;
    this.tradingEngine = tradingEngine;
    this.walletManager = walletManager;
    this.positionManager = positionManager;
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
    // Flush remaining events
    this.flush();
  }

  // ── WS Connection ───────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;

    const url = `${this.config.wsUrl}?key=${this.config.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.api.logger.info( "WS connected to TrenchScan");
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
      this.api.logger.warn( "WS disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.api.logger.error( `WS error: ${err.message}`);
      this.ws?.close();
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const channels = [...this.config.alertChannels];
    // Ensure tokens channel is subscribed for position price monitoring
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
    this.reconnectTimer = setTimeout(() => {
      this.api.logger.info( `WS reconnecting (delay: ${this.reconnectDelay}ms)`);
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  // ── Message Handling ────────────────────────────────────────────

  private handleMessage(msg: any): void {
    const type = msg.type as WsEvent["type"] | undefined;
    if (!type || !msg.data) return;

    // Only handle event types we care about
    const channel = EVENT_CHANNEL[type];
    if (!channel) return;

    // token_update: only used for position exit evaluation, not formatted/batched
    if (type === "token_update") {
      if (this.positionManager && this.config.tradingEnabled) {
        const signal = this.positionManager.evaluatePrice(msg.data.mint, msg.data.price_sol);
        if (signal) this.executeExit(signal);
      }
      return;
    }

    // Check if this channel is in our subscription
    if (!this.config.alertChannels.includes(channel)) return;

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
      // High signal — instant forward to /hooks/agent
      this.postAgentHook(formatted, msg);
    } else if (this.config.batchWindowSec === 0) {
      // Instant mode — send each event immediately
      this.postWakeHook(formatted);
    } else {
      // Normal — accumulate in batch
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

  // ── Strategy Execution ──────────────────────────────────────────

  private async executeStrategyAction(action: StrategyAction): Promise<void> {
    const { strategy, mint, sol_amount, reason } = action;

    switch (strategy.mode) {
      case "autonomous": {
        if (!this.tradingEngine || !this.walletManager?.isUnlocked) {
          this.api.logger.warn( `Strategy "${strategy.name}": wallet not unlocked, skipping autonomous trade`);
          return;
        }
        const keypair = this.walletManager.getKeypair();
        const solAmt = sol_amount ?? 0.1;
        const result = await this.tradingEngine.buy(mint, solAmt, keypair);
        if (result.success) {
          this.strategyManager?.recordSpend(solAmt);
          // Record position for exit monitoring
          if (this.positionManager && result.expectedAmount && action.priceSol) {
            this.positionManager.open(mint, strategy.name, action.priceSol, result.expectedAmount, solAmt, strategy.exit);
          }
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
        if (sellPercent >= 100) {
          this.positionManager.close(mint);
        }
        this.postWakeHook(`EXIT: sold ${sellPercent}% of ${mint.slice(0, 8)} — ${reason}. Tx: ${result.signature}`);
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
      this.api.logger.error( `Hook /wake failed: ${e instanceof Error ? e.message : e}`);
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
      this.api.logger.error( `Hook /agent failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
