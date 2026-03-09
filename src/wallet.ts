import { Keypair, Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WalletData, OpenClawPluginAPI } from "./types.js";

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;

export class WalletManager {
  private walletPath: string;
  private keypair: Keypair | null = null;
  private walletData: WalletData | null = null;
  private connection: Connection;

  constructor(
    private dataDir: string,
    private rpcUrl: string,
    private api: OpenClawPluginAPI,
  ) {
    this.walletPath = path.join(dataDir, "wallet.json");
    this.connection = new Connection(rpcUrl);
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.walletPath)) {
        const raw = fs.readFileSync(this.walletPath, "utf-8");
        this.walletData = JSON.parse(raw) as WalletData;
        if (!this.walletData.encrypted) {
          this.keypair = Keypair.fromSecretKey(bs58.decode(this.walletData.secretKey));
        }
        this.api.logger.info( `Wallet loaded: ${this.walletData.publicKey}`);
      }
    } catch (e) {
      this.api.logger.warn( `Failed to load wallet: ${e instanceof Error ? e.message : e}`);
    }
  }

  private saveToDisk(): void {
    if (!this.walletData) return;
    fs.mkdirSync(path.dirname(this.walletPath), { recursive: true });
    fs.writeFileSync(this.walletPath, JSON.stringify(this.walletData, null, 2));
  }

  get isLoaded(): boolean {
    return this.walletData !== null;
  }

  get isUnlocked(): boolean {
    return this.keypair !== null;
  }

  get publicKey(): string | null {
    return this.walletData?.publicKey ?? null;
  }

  getKeypair(): Keypair {
    if (!this.keypair) throw new Error("Wallet is locked. Use unlock_wallet first.");
    return this.keypair;
  }

  generate(password?: string): string {
    if (this.walletData) throw new Error("Wallet already exists. Delete wallet.json to generate a new one.");

    const kp = Keypair.generate();
    const secretKeyB58 = bs58.encode(kp.secretKey);

    if (password) {
      const salt = crypto.randomBytes(SALT_LENGTH);
      const iv = crypto.randomBytes(IV_LENGTH);
      const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(secretKeyB58, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      this.walletData = {
        publicKey: kp.publicKey.toBase58(),
        encrypted: true,
        secretKey: encrypted.toString("hex"),
        salt: salt.toString("hex"),
        iv: iv.toString("hex"),
        tag: tag.toString("hex"),
      };
      // Don't keep keypair in memory if encrypted — require unlock
      this.keypair = null;
    } else {
      this.walletData = {
        publicKey: kp.publicKey.toBase58(),
        encrypted: false,
        secretKey: secretKeyB58,
      };
      this.keypair = kp;
    }

    this.saveToDisk();
    this.api.logger.info( `Wallet generated: ${kp.publicKey.toBase58()}`);
    return kp.publicKey.toBase58();
  }

  unlock(password: string): string {
    if (!this.walletData) throw new Error("No wallet found. Use create_wallet first.");
    if (!this.walletData.encrypted) {
      this.keypair = Keypair.fromSecretKey(bs58.decode(this.walletData.secretKey));
      return this.walletData.publicKey;
    }
    if (!this.walletData.salt || !this.walletData.iv || !this.walletData.tag) {
      throw new Error("Wallet file is corrupted: missing encryption metadata.");
    }

    const salt = Buffer.from(this.walletData.salt, "hex");
    const iv = Buffer.from(this.walletData.iv, "hex");
    const tag = Buffer.from(this.walletData.tag, "hex");
    const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(this.walletData.secretKey, "hex")),
        decipher.final(),
      ]);
      const secretKeyB58 = decrypted.toString("utf8");
      this.keypair = Keypair.fromSecretKey(bs58.decode(secretKeyB58));
      this.api.logger.info( "Wallet unlocked");
      return this.walletData.publicKey;
    } catch {
      throw new Error("Wrong password or corrupted wallet file.");
    }
  }

  async transferSol(destination: string, amountSol: number): Promise<string> {
    if (!this.keypair) throw new Error("Wallet is locked. Use unlock_wallet first.");
    if (amountSol <= 0) throw new Error("Amount must be positive.");

    const lamports = Math.round(amountSol * 1e9);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: new PublicKey(destination),
        lamports,
      }),
    );

    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.keypair]);
    this.api.logger.info(`Transferred ${amountSol} SOL to ${destination}: ${signature}`);
    return signature;
  }

  async getBalance(): Promise<{ sol: number; tokens: { mint: string; amount: number; decimals: number }[] }> {
    if (!this.walletData) throw new Error("No wallet found.");
    const pubkey = new PublicKey(this.walletData.publicKey);

    const [solBalance, tokenAccounts] = await Promise.all([
      this.connection.getBalance(pubkey),
      this.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    ]);

    const tokens = tokenAccounts.value
      .map((ta) => {
        const info = ta.account.data.parsed.info;
        return {
          mint: info.mint as string,
          amount: Number(info.tokenAmount.amount),
          decimals: info.tokenAmount.decimals as number,
        };
      })
      .filter((t) => t.amount > 0);

    return { sol: solBalance / 1e9, tokens };
  }
}
