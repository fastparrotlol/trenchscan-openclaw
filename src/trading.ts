import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Connection,
  ComputeBudgetProgram,
  SystemProgram,
  Keypair,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import type { TradeResult, OpenClawPluginAPI } from "./types.js";

// ── Program IDs ──

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

// ── Platform fee defaults ──
const DEFAULT_FEE_WALLET = "7uLD9sc2JPmm4daKSHRABzwX3pvbVSUwagVt6EKGgxJb";
const DEFAULT_FEE_BPS = 50;
const DEFAULT_JITO_TIP_LAMPORTS = 200_000;

// ── Jito tip ──
const JITO_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

// ── Address Lookup Table ──
const ALT_ADDRESS = new PublicKey("AEEC3HHR8nfZ7Ci2kEFM2ffawLKxQvaYRGU4fz9Ng6nt");

// ── Discriminators ──
const BUY_DISCRIMINATOR = new Uint8Array([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const SELL_DISCRIMINATOR = new Uint8Array([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
const AMM_BUY_DISC = new Uint8Array([0xc6, 0x2e, 0x15, 0x52, 0xb4, 0xd9, 0xe8, 0x70]);
const AMM_SELL_DISC = new Uint8Array([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

// ── Fee config seeds ──
const BONDING_FEE_CONFIG_SEED = new Uint8Array([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
  81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);
const AMM_FEE_CONFIG_SEED = new Uint8Array([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
  244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

// ── Helpers ──

function getATA(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function writeU64LE(buf: Buffer, value: bigint, offset: number) {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function createAtaIdempotentIx(
  payer: PublicKey, ata: PublicKey, mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID, owner?: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner ?? payer, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]),
  });
}

function syncNativeIx(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from([17]),
  });
}

function closeAccountIx(account: PublicKey, dest: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from([9]),
  });
}

async function fetchMintTokenProgram(mint: PublicKey, connection: Connection): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error("Mint account not found");
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function fetchBondingFeeRecipient(connection: Connection): Promise<PublicKey> {
  const info = await connection.getAccountInfo(PUMP_GLOBAL);
  if (!info) throw new Error("Pump Global account not found");
  return new PublicKey(info.data.subarray(41, 73));
}

interface BondingCurveData {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  creator: PublicKey;
}

async function fetchBondingCurveData(bondingCurve: PublicKey, connection: Connection): Promise<BondingCurveData> {
  const info = await connection.getAccountInfo(bondingCurve);
  if (!info) throw new Error("Bonding curve account not found");
  const d = info.data;
  return {
    virtualTokenReserves: d.readBigUInt64LE(8),
    virtualSolReserves: d.readBigUInt64LE(16),
    creator: new PublicKey(d.subarray(49, 81)),
  };
}

function jitoTipIx(payer: PublicKey, tipLamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]),
    lamports: tipLamports,
  });
}

// ── AMM Pool Data ──

interface AmmPoolData {
  pool: PublicKey;
  coinCreator: PublicKey;
  poolBaseAta: PublicKey;
  poolQuoteAta: PublicKey;
}

async function fetchAmmPoolData(mint: string, connection: Connection): Promise<AmmPoolData> {
  const mintPk = new PublicKey(mint);
  const largest = await connection.getTokenLargestAccounts(mintPk);
  const addresses = largest.value.slice(0, 10).map((a) => new PublicKey(a.address));
  const ataInfos = await connection.getMultipleAccountsInfo(addresses);

  const owners: PublicKey[] = [];
  for (const ataInfo of ataInfos) {
    if (!ataInfo || ataInfo.data.length < 64) continue;
    owners.push(new PublicKey(ataInfo.data.subarray(32, 64)));
  }

  const ownerInfos = await connection.getMultipleAccountsInfo(owners);
  for (let i = 0; i < ownerInfos.length; i++) {
    const poolInfo = ownerInfos[i];
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM)) continue;
    if (poolInfo.data.length < 245) continue;
    const d = poolInfo.data;
    return {
      pool: owners[i],
      poolBaseAta: new PublicKey(d.subarray(139, 171)),
      poolQuoteAta: new PublicKey(d.subarray(171, 203)),
      coinCreator: new PublicKey(d.subarray(211, 243)),
    };
  }
  throw new Error("AMM pool not found for this token");
}

async function fetchProtocolFeeRecipient(connection: Connection): Promise<PublicKey> {
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")], PUMP_AMM_PROGRAM,
  );
  const info = await connection.getAccountInfo(globalConfig);
  if (!info) throw new Error("AMM GlobalConfig not found");
  return new PublicKey(info.data.subarray(57, 89));
}

// ══════════════════════════════════════════════════════════
// TradingEngine
// ══════════════════════════════════════════════════════════

export interface TradingFeeConfig {
  feeWallet?: string;
  feeBps?: number;
  jitoTipLamports?: number;
}

export class TradingEngine {
  private connection: Connection;
  private cachedALT: AddressLookupTableAccount | null = null;
  private feeWallet: PublicKey;
  private feeBps: bigint;
  private jitoTipLamports: bigint;

  constructor(
    private rpcUrl: string,
    private api: OpenClawPluginAPI,
    feeConfig?: TradingFeeConfig,
  ) {
    this.connection = new Connection(rpcUrl);
    this.feeWallet = new PublicKey(feeConfig?.feeWallet ?? DEFAULT_FEE_WALLET);
    this.feeBps = BigInt(feeConfig?.feeBps ?? DEFAULT_FEE_BPS);
    this.jitoTipLamports = BigInt(feeConfig?.jitoTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS);
  }

  private async getALT(): Promise<AddressLookupTableAccount[]> {
    if (!this.cachedALT) {
      const resp = await this.connection.getAddressLookupTable(ALT_ADDRESS);
      this.cachedALT = resp.value;
    }
    return this.cachedALT ? [this.cachedALT] : [];
  }

  // ── Auto-detect mode ──

  async buy(mint: string, solAmount: number, keypair: Keypair, slippageBps?: number): Promise<TradeResult> {
    const mintPk = new PublicKey(mint);
    const [bcPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBytes()], PUMP_PROGRAM,
    );

    try {
      const bcInfo = await this.connection.getAccountInfo(bcPda);
      if (bcInfo && bcInfo.owner.equals(PUMP_PROGRAM)) {
        return this.buyBonding(mint, solAmount, keypair, slippageBps);
      }
    } catch {
      // fall through to AMM
    }

    return this.buyAmm(mint, solAmount, keypair, slippageBps);
  }

  async sell(mint: string, tokenAmount: number, keypair: Keypair, slippageBps?: number): Promise<TradeResult> {
    const mintPk = new PublicKey(mint);
    const [bcPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBytes()], PUMP_PROGRAM,
    );

    try {
      const bcInfo = await this.connection.getAccountInfo(bcPda);
      if (bcInfo && bcInfo.owner.equals(PUMP_PROGRAM)) {
        return this.sellBonding(mint, tokenAmount, keypair, slippageBps);
      }
    } catch {
      // fall through to AMM
    }

    return this.sellAmm(mint, tokenAmount, keypair, slippageBps);
  }

  // ── Bonding Curve Buy ──

  private async buyBonding(mint: string, solAmount: number, keypair: Keypair, slippageBps = 500): Promise<TradeResult> {
    try {
      const mintPk = new PublicKey(mint);
      const buyerPk = keypair.publicKey;
      const [bcPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPk.toBytes()], PUMP_PROGRAM,
      );

      const [mintTokenProgram, bcData, feeRecipient, lookupTables] = await Promise.all([
        fetchMintTokenProgram(mintPk, this.connection),
        fetchBondingCurveData(bcPda, this.connection),
        fetchBondingFeeRecipient(this.connection),
        this.getALT(),
      ]);

      const associatedBondingCurve = getATA(mintPk, bcPda, mintTokenProgram);
      const associatedUser = getATA(mintPk, buyerPk, mintTokenProgram);

      const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), bcData.creator.toBytes()], PUMP_PROGRAM,
      );
      const [globalVolumeAcc] = PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")], PUMP_PROGRAM,
      );
      const [userVolumeAcc] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), buyerPk.toBytes()], PUMP_PROGRAM,
      );
      const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), BONDING_FEE_CONFIG_SEED], FEE_PROGRAM,
      );

      const solLamports = BigInt(Math.floor(solAmount * 1e9));
      const discountBps = BigInt(slippageBps) + 150n;
      const solForCurve = solLamports * (10000n - discountBps) / 10000n;
      const k = bcData.virtualSolReserves * bcData.virtualTokenReserves;
      const newVirtualSol = bcData.virtualSolReserves + solForCurve;
      const newVirtualTokens = k / newVirtualSol;
      const tokenAmount = bcData.virtualTokenReserves - newVirtualTokens;
      const maxSolCost = solLamports + (solLamports * BigInt(slippageBps)) / 10000n;

      const data = Buffer.alloc(25);
      data.set(BUY_DISCRIMINATOR, 0);
      writeU64LE(data, tokenAmount, 8);
      writeU64LE(data, maxSolCost, 16);
      data[24] = 0x00;

      const buyIx = new TransactionInstruction({
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: feeRecipient, isSigner: false, isWritable: true },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: bcPda, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          { pubkey: buyerPk, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: mintTokenProgram, isSigner: false, isWritable: false },
          { pubkey: creatorVault, isSigner: false, isWritable: true },
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: globalVolumeAcc, isSigner: false, isWritable: false },
          { pubkey: userVolumeAcc, isSigner: false, isWritable: true },
          { pubkey: feeConfig, isSigner: false, isWritable: false },
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM,
        data,
      });

      const feeLamports = solLamports * this.feeBps / 10000n;
      const { blockhash } = await this.connection.getLatestBlockhash();

      const messageV0 = new TransactionMessage({
        payerKey: buyerPk,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
          createAtaIdempotentIx(buyerPk, associatedUser, mintPk, mintTokenProgram),
          buyIx,
          SystemProgram.transfer({ fromPubkey: buyerPk, toPubkey: this.feeWallet, lamports: feeLamports }),
          jitoTipIx(buyerPk, this.jitoTipLamports),
        ],
      }).compileToV0Message(lookupTables);

      const tx = new VersionedTransaction(messageV0);
      tx.sign([keypair]);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      await this.connection.confirmTransaction(signature, "confirmed");

      this.api.logger.info( `Bonding BUY tx: ${signature}`);
      return { success: true, signature, expectedAmount: Number(tokenAmount), mode: "bonding" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.api.logger.error( `Bonding BUY failed: ${msg}`);
      return { success: false, error: msg, mode: "bonding" };
    }
  }

  // ── Bonding Curve Sell ──

  private async sellBonding(mint: string, tokenAmount: number, keypair: Keypair, slippageBps = 500): Promise<TradeResult> {
    try {
      const mintPk = new PublicKey(mint);
      const sellerPk = keypair.publicKey;
      const [bcPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPk.toBytes()], PUMP_PROGRAM,
      );

      const [mintTokenProgram, bcData, feeRecipient, lookupTables] = await Promise.all([
        fetchMintTokenProgram(mintPk, this.connection),
        fetchBondingCurveData(bcPda, this.connection),
        fetchBondingFeeRecipient(this.connection),
        this.getALT(),
      ]);

      const associatedBondingCurve = getATA(mintPk, bcPda, mintTokenProgram);
      const associatedUser = getATA(mintPk, sellerPk, mintTokenProgram);

      const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), bcData.creator.toBytes()], PUMP_PROGRAM,
      );
      const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), BONDING_FEE_CONFIG_SEED], FEE_PROGRAM,
      );

      const tokenAmountBig = BigInt(Math.floor(tokenAmount));
      const k = bcData.virtualSolReserves * bcData.virtualTokenReserves;
      const newVirtualTokens = bcData.virtualTokenReserves + tokenAmountBig;
      const newVirtualSol = k / newVirtualTokens;
      const solOut = bcData.virtualSolReserves - newVirtualSol;
      const discountBps = BigInt(slippageBps) + 150n;
      const minSolOutput = solOut * (10000n - discountBps) / 10000n;

      const data = Buffer.alloc(24);
      data.set(SELL_DISCRIMINATOR, 0);
      writeU64LE(data, tokenAmountBig, 8);
      writeU64LE(data, minSolOutput > 0n ? minSolOutput : 0n, 16);

      const sellIx = new TransactionInstruction({
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: feeRecipient, isSigner: false, isWritable: true },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: bcPda, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          { pubkey: sellerPk, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: creatorVault, isSigner: false, isWritable: true },
          { pubkey: mintTokenProgram, isSigner: false, isWritable: false },
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: feeConfig, isSigner: false, isWritable: false },
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM,
        data,
      });

      const feeLamports = solOut * this.feeBps / 10000n;
      const { blockhash } = await this.connection.getLatestBlockhash();

      const messageV0 = new TransactionMessage({
        payerKey: sellerPk,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
          sellIx,
          SystemProgram.transfer({ fromPubkey: sellerPk, toPubkey: this.feeWallet, lamports: feeLamports }),
          jitoTipIx(sellerPk, this.jitoTipLamports),
        ],
      }).compileToV0Message(lookupTables);

      const tx = new VersionedTransaction(messageV0);
      tx.sign([keypair]);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      await this.connection.confirmTransaction(signature, "confirmed");

      this.api.logger.info( `Bonding SELL tx: ${signature}`);
      return { success: true, signature, expectedAmount: Number(solOut) / 1e9, mode: "bonding" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.api.logger.error( `Bonding SELL failed: ${msg}`);
      return { success: false, error: msg, mode: "bonding" };
    }
  }

  // ── AMM Buy ──

  private async buyAmm(mint: string, solAmount: number, keypair: Keypair, slippageBps = 500): Promise<TradeResult> {
    try {
      const mintPk = new PublicKey(mint);
      const userPk = keypair.publicKey;
      const solLamports = BigInt(Math.floor(solAmount * 1e9));

      const [poolData, protocolFeeRecipient, baseTokenProgram, lookupTables] = await Promise.all([
        fetchAmmPoolData(mint, this.connection),
        fetchProtocolFeeRecipient(this.connection),
        fetchMintTokenProgram(mintPk, this.connection),
        this.getALT(),
      ]);

      const [baseBalResp, quoteBalResp] = await Promise.all([
        this.connection.getTokenAccountBalance(poolData.poolBaseAta),
        this.connection.getTokenAccountBalance(poolData.poolQuoteAta),
      ]);
      const baseReserves = BigInt(baseBalResp.value.amount);
      const quoteReserves = BigInt(quoteBalResp.value.amount);
      const baseOut = (baseReserves * solLamports) / (quoteReserves + solLamports);
      const minBaseOut = (baseOut * BigInt(10000 - slippageBps)) / 10000n;

      const userBaseAta = getATA(mintPk, userPk, baseTokenProgram);
      const userWsolAta = getATA(WSOL_MINT, userPk);
      const protocolFeeAta = getATA(WSOL_MINT, protocolFeeRecipient);

      const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM);
      const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM);
      const [coinCreatorVaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_vault"), poolData.coinCreator.toBytes()], PUMP_AMM_PROGRAM,
      );
      const coinCreatorVaultAta = getATA(WSOL_MINT, coinCreatorVaultAuth);
      const [globalVolumeAcc] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_AMM_PROGRAM);
      const [userVolumeAcc] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), userPk.toBytes()], PUMP_AMM_PROGRAM,
      );
      const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), AMM_FEE_CONFIG_SEED], FEE_PROGRAM,
      );

      const data = Buffer.alloc(25);
      data.set(AMM_BUY_DISC, 0);
      writeU64LE(data, solLamports, 8);
      writeU64LE(data, minBaseOut > 0n ? minBaseOut : 0n, 16);
      data[24] = 0x00;

      const ammBuyIx = new TransactionInstruction({
        keys: [
          { pubkey: poolData.pool, isSigner: false, isWritable: true },
          { pubkey: userPk, isSigner: true, isWritable: true },
          { pubkey: globalConfig, isSigner: false, isWritable: false },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
          { pubkey: userBaseAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: poolData.poolBaseAta, isSigner: false, isWritable: true },
          { pubkey: poolData.poolQuoteAta, isSigner: false, isWritable: true },
          { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
          { pubkey: protocolFeeAta, isSigner: false, isWritable: true },
          { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
          { pubkey: coinCreatorVaultAuth, isSigner: false, isWritable: false },
          { pubkey: globalVolumeAcc, isSigner: false, isWritable: false },
          { pubkey: userVolumeAcc, isSigner: false, isWritable: true },
          { pubkey: feeConfig, isSigner: false, isWritable: false },
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM,
        data,
      });

      const feeLamports = solLamports * this.feeBps / 10000n;
      const { blockhash } = await this.connection.getLatestBlockhash();

      const messageV0 = new TransactionMessage({
        payerKey: userPk,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
          createAtaIdempotentIx(userPk, userWsolAta, WSOL_MINT, TOKEN_PROGRAM_ID),
          createAtaIdempotentIx(userPk, userBaseAta, mintPk, baseTokenProgram),
          SystemProgram.transfer({ fromPubkey: userPk, toPubkey: userWsolAta, lamports: solLamports }),
          syncNativeIx(userWsolAta),
          ammBuyIx,
          closeAccountIx(userWsolAta, userPk, userPk),
          SystemProgram.transfer({ fromPubkey: userPk, toPubkey: this.feeWallet, lamports: feeLamports }),
          jitoTipIx(userPk, this.jitoTipLamports),
        ],
      }).compileToV0Message(lookupTables);

      const tx = new VersionedTransaction(messageV0);
      tx.sign([keypair]);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      await this.connection.confirmTransaction(signature, "confirmed");

      this.api.logger.info( `AMM BUY tx: ${signature}`);
      return { success: true, signature, expectedAmount: Number(baseOut), mode: "amm" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.api.logger.error( `AMM BUY failed: ${msg}`);
      return { success: false, error: msg, mode: "amm" };
    }
  }

  // ── AMM Sell ──

  private async sellAmm(mint: string, tokenAmount: number, keypair: Keypair, slippageBps = 500): Promise<TradeResult> {
    try {
      const mintPk = new PublicKey(mint);
      const userPk = keypair.publicKey;
      const tokenAmountBig = BigInt(Math.floor(tokenAmount));

      const [poolData, protocolFeeRecipient, baseTokenProgram, lookupTables] = await Promise.all([
        fetchAmmPoolData(mint, this.connection),
        fetchProtocolFeeRecipient(this.connection),
        fetchMintTokenProgram(mintPk, this.connection),
        this.getALT(),
      ]);

      const [baseBalResp, quoteBalResp] = await Promise.all([
        this.connection.getTokenAccountBalance(poolData.poolBaseAta),
        this.connection.getTokenAccountBalance(poolData.poolQuoteAta),
      ]);
      const baseReserves = BigInt(baseBalResp.value.amount);
      const quoteReserves = BigInt(quoteBalResp.value.amount);
      const quoteOut = (quoteReserves * tokenAmountBig) / (baseReserves + tokenAmountBig);
      const minQuoteOut = (quoteOut * BigInt(10000 - slippageBps)) / 10000n;

      const userBaseAta = getATA(mintPk, userPk, baseTokenProgram);
      const userWsolAta = getATA(WSOL_MINT, userPk);
      const protocolFeeAta = getATA(WSOL_MINT, protocolFeeRecipient);

      const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM);
      const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM);
      const [coinCreatorVaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_vault"), poolData.coinCreator.toBytes()], PUMP_AMM_PROGRAM,
      );
      const coinCreatorVaultAta = getATA(WSOL_MINT, coinCreatorVaultAuth);
      const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), AMM_FEE_CONFIG_SEED], FEE_PROGRAM,
      );

      const data = Buffer.alloc(24);
      data.set(AMM_SELL_DISC, 0);
      writeU64LE(data, tokenAmountBig, 8);
      writeU64LE(data, minQuoteOut > 0n ? minQuoteOut : 0n, 16);

      const ammSellIx = new TransactionInstruction({
        keys: [
          { pubkey: poolData.pool, isSigner: false, isWritable: true },
          { pubkey: userPk, isSigner: true, isWritable: true },
          { pubkey: globalConfig, isSigner: false, isWritable: false },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
          { pubkey: userBaseAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: poolData.poolBaseAta, isSigner: false, isWritable: true },
          { pubkey: poolData.poolQuoteAta, isSigner: false, isWritable: true },
          { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
          { pubkey: protocolFeeAta, isSigner: false, isWritable: true },
          { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
          { pubkey: coinCreatorVaultAuth, isSigner: false, isWritable: false },
          { pubkey: feeConfig, isSigner: false, isWritable: false },
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM,
        data,
      });

      const feeLamports = quoteOut * this.feeBps / 10000n;
      const { blockhash } = await this.connection.getLatestBlockhash();

      const messageV0 = new TransactionMessage({
        payerKey: userPk,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
          createAtaIdempotentIx(userPk, userWsolAta, WSOL_MINT, TOKEN_PROGRAM_ID),
          ammSellIx,
          closeAccountIx(userWsolAta, userPk, userPk),
          SystemProgram.transfer({ fromPubkey: userPk, toPubkey: this.feeWallet, lamports: feeLamports }),
          jitoTipIx(userPk, this.jitoTipLamports),
        ],
      }).compileToV0Message(lookupTables);

      const tx = new VersionedTransaction(messageV0);
      tx.sign([keypair]);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      await this.connection.confirmTransaction(signature, "confirmed");

      this.api.logger.info( `AMM SELL tx: ${signature}`);
      return { success: true, signature, expectedAmount: Number(quoteOut) / 1e9, mode: "amm" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.api.logger.error( `AMM SELL failed: ${msg}`);
      return { success: false, error: msg, mode: "amm" };
    }
  }
}
