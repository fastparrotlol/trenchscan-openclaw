import type { PluginConfig, OpenClawPluginAPI, Strategy } from "./types.js";
import { WalletManager } from "./wallet.js";
import { TradingEngine } from "./trading.js";
import { StrategyManager } from "./strategy.js";

export function registerTradingTools(
  api: OpenClawPluginAPI,
  config: PluginConfig,
  walletManager: WalletManager,
  tradingEngine: TradingEngine,
  strategyManager: StrategyManager,
): void {

  // 1. create_wallet
  api.registerTool({
    name: "create_wallet",
    description: "Generate a new Solana wallet keypair for trading. Optionally encrypt with a password.",
    parameters: {
      password: { type: "string", description: "Password to encrypt the private key (optional, recommended)" },
    },
    async handler({ password }) {
      const address = walletManager.generate(password as string | undefined);
      const encrypted = !!password;
      return `Wallet created: ${address}\nEncrypted: ${encrypted}\n${encrypted ? "Use unlock_wallet with your password before trading." : "Ready to trade (fund with SOL first)."}`;
    },
  });

  // 2. unlock_wallet
  api.registerTool({
    name: "unlock_wallet",
    description: "Unlock an encrypted wallet with password. Required before trading if wallet was created with a password.",
    parameters: {
      password: { type: "string", description: "Wallet encryption password", required: true },
    },
    async handler({ password }) {
      const address = walletManager.unlock(password as string);
      return `Wallet unlocked: ${address}\nReady to trade.`;
    },
  });

  // 3. wallet_info
  api.registerTool({
    name: "wallet_info",
    description: "Get wallet balance: SOL and all token holdings",
    parameters: {},
    async handler() {
      if (!walletManager.isLoaded) return "No wallet found. Use create_wallet first.";
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
      return lines.join("\n");
    },
  });

  // 4. buy_token
  api.registerTool({
    name: "buy_token",
    description: "Buy a pump.fun token with SOL. Auto-detects bonding curve vs AMM (post-migration).",
    parameters: {
      mint: { type: "string", description: "Token mint address", required: true },
      sol_amount: { type: "number", description: "SOL amount to spend", required: true },
      slippage_bps: { type: "number", description: "Slippage in basis points (default: 500 = 5%)", default: 500 },
    },
    async handler({ mint, sol_amount, slippage_bps }) {
      if (!config.tradingEnabled) return "Trading is disabled. Set tradingEnabled: true in plugin config.";
      if (!walletManager.isUnlocked) return "Wallet is locked. Use unlock_wallet first.";

      const solAmt = Number(sol_amount);
      if (solAmt <= 0 || solAmt > 10) return "Invalid SOL amount (must be 0 < amount <= 10).";

      const keypair = walletManager.getKeypair();
      const result = await tradingEngine.buy(
        mint as string, solAmt, keypair, Number(slippage_bps ?? 500),
      );

      if (result.success) {
        return `BUY successful (${result.mode})\nMint: ${mint}\nSOL spent: ${solAmt}\nTx: ${result.signature}`;
      }
      return `BUY failed (${result.mode}): ${result.error}`;
    },
  });

  // 5. sell_token
  api.registerTool({
    name: "sell_token",
    description: "Sell a pump.fun token. Specify percentage of your holdings to sell.",
    parameters: {
      mint: { type: "string", description: "Token mint address", required: true },
      percent: { type: "number", description: "Percentage to sell (1-100)", required: true },
      slippage_bps: { type: "number", description: "Slippage in basis points (default: 500 = 5%)", default: 500 },
    },
    async handler({ mint, percent, slippage_bps }) {
      if (!config.tradingEnabled) return "Trading is disabled. Set tradingEnabled: true in plugin config.";
      if (!walletManager.isUnlocked) return "Wallet is locked. Use unlock_wallet first.";

      const pct = Number(percent);
      if (pct <= 0 || pct > 100) return "Invalid percent (must be 1-100).";

      // Fetch token balance
      const balance = await walletManager.getBalance();
      const token = balance.tokens.find((t) => t.mint === mint);
      if (!token || token.amount === 0) return `No balance found for mint: ${mint}`;

      const tokenAmount = Math.floor(token.amount * (pct / 100));
      if (tokenAmount === 0) return "Token amount too small to sell.";

      const keypair = walletManager.getKeypair();
      const result = await tradingEngine.sell(
        mint as string, tokenAmount, keypair, Number(slippage_bps ?? 500),
      );

      if (result.success) {
        return `SELL successful (${result.mode})\nMint: ${mint}\nSold: ${pct}% (${tokenAmount} raw)\nExpected SOL out: ~${result.expectedAmount?.toFixed(6) ?? "?"}\nTx: ${result.signature}`;
      }
      return `SELL failed (${result.mode}): ${result.error}`;
    },
  });

  // 6. set_strategy
  api.registerTool({
    name: "set_strategy",
    description: "Create or update a trading strategy with entry/exit rules and execution mode (autonomous/confirm/alert)",
    parameters: {
      name: { type: "string", description: "Strategy name", required: true },
      rules: { type: "string", description: "Strategy JSON: {mode, entry: {trigger, conditions}, exit, limits}", required: true },
    },
    async handler({ name, rules }) {
      if (!config.tradingEnabled) return "Trading is disabled. Set tradingEnabled: true in plugin config.";

      try {
        const parsed = JSON.parse(rules as string);
        const strategy: Strategy = {
          name: name as string,
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
          },
          limits: {
            max_open_positions: parsed.limits?.max_open_positions ?? 3,
            max_sol_per_trade: parsed.limits?.max_sol_per_trade ?? 1,
            max_daily_sol: parsed.limits?.max_daily_sol ?? 5,
          },
        };

        strategyManager.save(strategy);
        return `Strategy "${name}" saved.\nMode: ${strategy.mode}\nTrigger: ${strategy.entry.trigger}\nSOL/trade: ${strategy.entry.conditions.sol_amount}\nActive: ${strategy.active}`;
      } catch (e) {
        return `Invalid strategy JSON: ${e instanceof Error ? e.message : e}`;
      }
    },
  });

  // 7. list_strategies
  api.registerTool({
    name: "list_strategies",
    description: "List all trading strategies with their status and configuration",
    parameters: {},
    async handler() {
      const strategies = strategyManager.list();
      if (strategies.length === 0) return "No strategies configured. Use set_strategy to create one.";

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
        lines.push("");
      }
      return lines.join("\n");
    },
  });

  // 8. remove_strategy
  api.registerTool({
    name: "remove_strategy",
    description: "Remove a trading strategy by name",
    parameters: {
      name: { type: "string", description: "Strategy name to remove", required: true },
    },
    async handler({ name }) {
      const removed = strategyManager.remove(name as string);
      return removed ? `Strategy "${name}" removed.` : `Strategy "${name}" not found.`;
    },
  });
}
