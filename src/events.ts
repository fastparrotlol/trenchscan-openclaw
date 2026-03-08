import WebSocket from "ws";
import type { PluginConfig, WsEvent, OpenClawPluginAPI } from "./types.js";
import { EVENT_CHANNEL, EVENT_PRIORITY } from "./types.js";
import {
  formatKolTrade, formatBundleDetected, formatBundleDumpAlert,
  formatTokenNew, formatSolPrice, formatBatchSummary,
} from "./format.js";

// ── Event Forwarder ─────────────────────────────────────────────────

export class EventForwarder {
  private ws: WebSocket | null = null;
  private batch: string[] = [];
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnectDelay = 1000;

  constructor(
    private config: PluginConfig,
    private api: OpenClawPluginAPI,
  ) {}

  start(): void {
    this.connect();
    if (this.config.batchWindowSec > 0) {
      this.batchTimer = setInterval(() => this.flush(), this.config.batchWindowSec * 1000);
    }
  }

  stop(): void {
    this.destroyed = true;
    if (this.batchTimer) clearInterval(this.batchTimer);
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
      this.api.log("info", "WS connected to TrenchScan");
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
      this.api.log("warn", "WS disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.api.log("error", `WS error: ${err.message}`);
      this.ws?.close();
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: Record<string, unknown> = {
      action: "subscribe",
      channels: this.config.alertChannels,
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
      this.api.log("info", `WS reconnecting (delay: ${this.reconnectDelay}ms)`);
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

    // Check if this channel is in our subscription
    if (!this.config.alertChannels.includes(channel)) return;

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
      this.api.log("error", `Hook /wake failed: ${e instanceof Error ? e.message : e}`);
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
      this.api.log("error", `Hook /agent failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
