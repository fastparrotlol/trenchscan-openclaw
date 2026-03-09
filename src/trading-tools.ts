import type { PluginConfig, WithdrawConfig, OpenClawPluginAPI, Strategy, ToolResult } from "./types.js";
import type { WalletManager } from "./wallet.js";
import type { TradingEngine } from "./trading.js";
import type { StrategyManager } from "./strategy.js";
import type { PositionManager } from "./positions.js";
import type { EventForwarder } from "./events.js";
import { formatTradeHistory, formatPositions, formatHealth } from "./format.js";

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function registerTradingTools(
  api: OpenClawPluginAPI,
  config: PluginConfig,
  walletManager: WalletManager,
  tradingEngine: TradingEngine,
  strategyManager: StrategyManager,
  positionManager: PositionManager,
  eventForwarder: EventForwarder,
): void {

  // 1. create_wallet
  api.registerTool({
    name: "create_wallet",
    description: "Generate a new Solana wallet keypair for trading. Optionally encrypt with a password.",
    parameters: {
      type: "object",
      properties: {
        password: { type: "string", description: "Password to encrypt the private key (optional, recommended)" },
      },
    },
    async execute(_id, params) {
      const address = walletManager.generate(params.password as string | undefined);
      const encrypted = !!params.password;
      return textResult(`Wallet created: ${address}\nEncrypted: ${encrypted}\n${encrypted ? "Use unlock_wallet with your password before trading." : "Ready to trade (fund with SOL first)."}`);
    },
  });

  // 2. unlock_wallet
  api.registerTool({
    name: "unlock_wallet",
    description: "Unlock an encrypted wallet with password. Required before trading if wallet was created with a password.",
    parameters: {
      type: "object",
      properties: {
        password: { type: "string", description: "Wallet encryption password" },
      },
      required: ["password"],
    },
    async execute(_id, params) {
      const address = walletManager.unlock(params.password as string);
      return textResult(`Wallet unlocked: ${address}\nReady to trade.`);
    },
  });

  // 3. wallet_info
  api.registerTool({
    name: "wallet_info",
    description: "Get wallet balance: SOL and all token holdings",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      if (!walletManager.isLoaded) return textResult("No wallet found. Use create_wallet first.");
      const balance = await walletManager.getBalance();
      const lines = [`Wallet: ${walletManager.publicKey}`, `SOL: ${balance.sol.toFixed(6)}`];
      if (balance.tokens.length > 0) {
        lines.push(`\nTokens (${balance.tokens.length}):`);
        for (const t of balance.tokens) {
          const uiAmount = t.amount / Math.pow(10, t.decimals);
          lines.push(`  ${t.mint}: ${uiAmount.toLocaleString()}`);
        }
      } else {
        lines.push("No token holdings.");
      }
      return textResult(lines.join("\n"));
    },
  });

  // 4. buy_token
  api.registerTool({
    name: "buy_token",
    description: "Buy a pump.fun token with SOL. Auto-detects bonding curve vs AMM (post-migration).",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string", description: "Token mint address" },
        sol_amount: { type: "number", description: "SOL amount to spend" },
        slippage_bps: { type: "number", description: "Slippage in basis points (default: 500 = 5%)", default: 500 },
      },
      required: ["mint", "sol_amount"],
    },
    async execute(_id, params) {
      if (!config.tradingEnabled) return textResult("Trading is disabled. Set tradingEnabled: true in plugin config.");
      if (!walletManager.isUnlocked) return textResult("Wallet is locked. Use unlock_wallet first.");

      const solAmt = Number(params.sol_amount);
      if (solAmt <= 0 || solAmt > 10) return textResult("Invalid SOL amount (must be 0 < amount <= 10).");

      const keypair = walletManager.getKeypair();
      const result = await tradingEngine.buy(
        params.mint as string, solAmt, keypair, Number(params.slippage_bps ?? 500),
      );

      if (result.success) {
        return textResult(`BUY successful (${result.mode})\nMint: ${params.mint}\nSOL spent: ${solAmt}\nTx: ${result.signature}`);
      }
      return textResult(`BUY failed (${result.mode}): ${result.error}`);
    },
  });

  // 5. sell_token
  api.registerTool({
    name: "sell_token",
    description: "Sell a pump.fun token. Specify percentage of holdings or exact token_amount. At least one of percent or token_amount is required.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string", description: "Token mint address" },
        percent: { type: "number", description: "Percentage to sell (1-100)" },
        token_amount: { type: "number", description: "Exact raw token amount to sell (alternative to percent)" },
        slippage_bps: { type: "number", description: "Slippage in basis points (default: 500 = 5%)", default: 500 },
      },
      required: ["mint"],
    },
    async execute(_id, params) {
      if (!config.tradingEnabled) return textResult("Trading is disabled. Set tradingEnabled: true in plugin config.");
      if (!walletManager.isUnlocked) return textResult("Wallet is locked. Use unlock_wallet first.");

      const hasPercent = params.percent != null;
      const hasTokenAmount = params.token_amount != null;
      if (!hasPercent && !hasTokenAmount) return textResult("Provide either percent or token_amount.");

      let tokenAmount: number;
      let pctLabel: string;

      if (hasTokenAmount) {
        tokenAmount = Math.floor(Number(params.token_amount));
        if (tokenAmount <= 0) return textResult("Invalid token_amount.");
        pctLabel = `${tokenAmount} raw`;
      } else {
        const pct = Number(params.percent);
        if (pct <= 0 || pct > 100) return textResult("Invalid percent (must be 1-100).");

        const balance = await walletManager.getBalance();
        const token = balance.tokens.find((t) => t.mint === params.mint);
        if (!token || token.amount === 0) return textResult(`No balance found for mint: ${params.mint}`);

        tokenAmount = Math.floor(token.amount * (pct / 100));
        if (tokenAmount === 0) return textResult("Token amount too small to sell.");
        pctLabel = `${pct}% (${tokenAmount} raw)`;
      }

      const keypair = walletManager.getKeypair();
      const result = await tradingEngine.sell(
        params.mint as string, tokenAmount, keypair, Number(params.slippage_bps ?? 500),
      );

      if (result.success) {
        return textResult(`SELL successful (${result.mode})\nMint: ${params.mint}\nSold: ${pctLabel}\nExpected SOL out: ~${result.expectedAmount?.toFixed(6) ?? "?"}\nTx: ${result.signature}`);
      }
      return textResult(`SELL failed (${result.mode}): ${result.error}`);
    },
  });

  // 6. set_strategy
  api.registerTool({
    name: "set_strategy",
    description: "Create or update a trading strategy with entry/exit rules and execution mode (autonomous/confirm/alert)",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Strategy name" },
        rules: { type: "string", description: "Strategy JSON: {mode, entry: {trigger, conditions}, exit, limits}" },
      },
      required: ["name", "rules"],
    },
    async execute(_id, params) {
      if (!config.tradingEnabled) return textResult("Trading is disabled. Set tradingEnabled: true in plugin config.");

      try {
        const parsed = JSON.parse(params.rules as string);
        const strategy: Strategy = {
          name: params.name as string,
          active: parsed.active ?? true,
          mode: parsed.mode ?? "alert",
          entry: {
            trigger: parsed.entry?.trigger ?? "kol_buy",
            conditions: {
              kol_names: parsed.entry?.conditions?.kol_names,
              max_risk_score: parsed.entry?.conditions?.max_risk_score,
              min_mcap: parsed.entry?.conditions?.min_mcap,
              max_mcap: parsed.entry?.conditions?.max_mcap,
              sol_amount: parsed.entry?.conditions?.sol_amount ?? 0.1,
            },
          },
          exit: {
            take_profit_pct: parsed.exit?.take_profit_pct,
            stop_loss_pct: parsed.exit?.stop_loss_pct,
            bundle_dump: parsed.exit?.bundle_dump,
            trailing_stop_pct: parsed.exit?.trailing_stop_pct,
            max_hold_minutes: parsed.exit?.max_hold_minutes,
            take_profit_tiers: parsed.exit?.take_profit_tiers,
          },
          limits: {
            max_open_positions: parsed.limits?.max_open_positions ?? 3,
            max_sol_per_trade: parsed.limits?.max_sol_per_trade ?? 1,
            max_daily_sol: parsed.limits?.max_daily_sol ?? 5,
          },
        };

        strategyManager.save(strategy);
        return textResult(`Strategy "${params.name}" saved.\nMode: ${strategy.mode}\nTrigger: ${strategy.entry.trigger}\nSOL/trade: ${strategy.entry.conditions.sol_amount}\nActive: ${strategy.active}`);
      } catch (e) {
        return textResult(`Invalid strategy JSON: ${e instanceof Error ? e.message : e}`);
      }
    },
  });

  // 7. list_strategies
  api.registerTool({
    name: "list_strategies",
    description: "List all trading strategies with their status and configuration",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const strategies = strategyManager.list();
      if (strategies.length === 0) return textResult("No strategies configured. Use set_strategy to create one.");

      const lines = [`Strategies (${strategies.length}):\n`];
      for (const s of strategies) {
        lines.push(`[${s.active ? "ACTIVE" : "PAUSED"}] ${s.name}`);
        lines.push(`  Mode: ${s.mode} | Trigger: ${s.entry.trigger}`);
        lines.push(`  SOL/trade: ${s.entry.conditions.sol_amount} | Max daily: ${s.limits.max_daily_sol}`);
        if (s.entry.conditions.kol_names?.length) {
          lines.push(`  KOLs: ${s.entry.conditions.kol_names.join(", ")}`);
        }
        if (s.exit.take_profit_pct) lines.push(`  TP: +${s.exit.take_profit_pct}%`);
        if (s.exit.stop_loss_pct) lines.push(`  SL: -${s.exit.stop_loss_pct}%`);
        if (s.exit.take_profit_tiers?.length) {
          lines.push(`  TP tiers: ${s.exit.take_profit_tiers.map((t) => `+${t.pct}%→sell ${t.sell_pct}%`).join(", ")}`);
        }
        lines.push("");
      }
      return textResult(lines.join("\n"));
    },
  });

  // 8. remove_strategy
  api.registerTool({
    name: "remove_strategy",
    description: "Remove a trading strategy by name",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Strategy name to remove" },
      },
      required: ["name"],
    },
    async execute(_id, params) {
      const removed = strategyManager.remove(params.name as string);
      return textResult(removed ? `Strategy "${params.name}" removed.` : `Strategy "${params.name}" not found.`);
    },
  });

  // ── NEW TOOLS (9-13) ─────────────────────────────────────────────

  // 9. withdraw
  api.registerTool({
    name: "withdraw",
    description: "Transfer SOL from trading wallet to another address",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Destination wallet address" },
        amount: { type: "number", description: "SOL amount to transfer" },
      },
      required: ["destination", "amount"],
    },
    async execute(_id, params) {
      if (!walletManager.isUnlocked) return textResult("Wallet is locked. Use unlock_wallet first.");

      const amount = Number(params.amount);
      if (amount <= 0) return textResult("Amount must be positive.");

      try {
        const sig = await walletManager.transferSol(params.destination as string, amount);
        return textResult(`Transferred ${amount} SOL → ${params.destination}\nTx: ${sig}`);
      } catch (e) {
        return textResult(`Transfer failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  });

  // 10. set_withdraw_config
  api.registerTool({
    name: "set_withdraw_config",
    description: "Configure auto-withdrawal settings (withdraw profits after each sell)",
    parameters: {
      type: "object",
      properties: {
        config: { type: "string", description: 'JSON: {enabled, destination, mode: "all_profit"|"percent", percent?, afterEveryTrade}' },
      },
      required: ["config"],
    },
    async execute(_id, params) {
      try {
        const wc = JSON.parse(params.config as string) as WithdrawConfig;
        if (!wc.destination) return textResult("destination is required.");
        if (!["all_profit", "percent"].includes(wc.mode)) return textResult('mode must be "all_profit" or "percent".');

        eventForwarder.setWithdrawConfig(wc);
        return textResult(`Withdraw config saved.\nEnabled: ${wc.enabled}\nDestination: ${wc.destination}\nMode: ${wc.mode}${wc.mode === "percent" ? ` (${wc.percent}%)` : ""}\nAfter every trade: ${wc.afterEveryTrade}`);
      } catch (e) {
        return textResult(`Invalid config JSON: ${e instanceof Error ? e.message : e}`);
      }
    },
  });

  // 11. trade_history
  api.registerTool({
    name: "trade_history",
    description: "View trade history with optional filtering by mint and limit",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max trades to show (default: 20)" },
        mint: { type: "string", description: "Filter by token mint address" },
      },
    },
    async execute(_id, params) {
      const records = positionManager.getHistory(
        Number(params.limit ?? 20),
        params.mint as string | undefined,
      );
      const pnl = positionManager.getRealizedPnl();
      let text = formatTradeHistory(records);
      if (pnl.length > 0) {
        const totalPnl = pnl.reduce((sum, p) => sum + p.pnl, 0);
        text += `\n\n── Realized PnL ──\nTotal: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`;
        for (const p of pnl.slice(0, 10)) {
          text += `\n  ${p.mint.slice(0, 8)}…: ${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(4)} SOL`;
        }
      }
      return textResult(text);
    },
  });

  // 12. positions
  api.registerTool({
    name: "positions",
    description: "View all open trading positions",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const positions = positionManager.getAllPositions();
      return textResult(formatPositions(positions));
    },
  });

  // 13. health
  api.registerTool({
    name: "health",
    description: "Plugin health check: WS status, uptime, events, trades, positions, daily spend",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const metrics = eventForwarder.getMetrics();
      return textResult(formatHealth(metrics));
    },
  });
}
