// Wallet / signing seam for Canton Resilience.
//
// The privileged action is authorized by the acting party's Canton wallet — the
// hackathon target is **Grofty**. `GroftyWallet` below is a real adapter over the
// published Canton dApp SDK (`@canton-network/dapp-sdk`, CIP-0103): it discovers
// an installed wallet, connects it, reads the party it holds, and can hand it a
// command to sign and submit.
//
// Two things make this a seam rather than a finished integration, and both are
// honest constraints rather than missing work:
//
//  1. A wallet signs against the network *its own validator* is on. A LocalNet
//     sandbox is not that network, so during the local demo no wallet can submit
//     to it. `GroftyWallet.submit()` is wired and is used the moment the connected
//     party is actually a member of the on-ledger policy — see `components/
//     Console.tsx`, which checks that before choosing the wallet over the server
//     route. On LocalNet that check is false and the server route submits instead.
//  2. A browser without a Canton wallet installed cannot connect at all. The
//     console then offers `DemoWallet`, which is labelled `real = false` in the
//     UI and produces no cryptographic signature — it is a stand-in for the demo
//     to stay runnable, never a claim that signing happened.

// The SDK's module namespace — its exported helpers delegate to a singleton
// client, so this is what the adapter actually talks to.
type DappSdkModule = typeof import('@canton-network/dapp-sdk');

export interface WalletAccount {
  partyId: string; // the Canton party the wallet holds, e.g. "alice::1220…"
  networkId?: string; // the network the wallet's validator is on
  hint?: string;
}

export interface WalletState {
  connected: boolean;
  real: boolean; // true only when a real wallet SDK is doing the work
  account?: WalletAccount;
  reason?: string; // why it is not connected, in words a user can act on
}

export interface SignRequest {
  application: string;
  verb: string;
  reference: string;
}

// A command the wallet should sign and submit itself, in the JSON Ledger API v2
// command shape the participant accepts.
export interface SubmitRequest {
  commands: unknown[];
  actAs: string[];
}

export interface WalletAdapter {
  readonly id: string;
  readonly label: string;
  readonly real: boolean;
  /** Restore a previously approved session without prompting the user. */
  restore(): Promise<WalletState>;
  /** Open the wallet and ask the user to approve the connection. */
  connect(): Promise<WalletState>;
  disconnect(): Promise<void>;
  sign(req: SignRequest): Promise<{ signature: string }>;
  /** Real adapters only: submit a command through the wallet. */
  submit?(req: SubmitRequest): Promise<{ commandId?: string; updateId?: string }>;
}

// CIP-0103 / discovery error codes, translated. The SDK throws `DiscoveryError`
// with a stable `code`; matching on it means the console can say something true
// ("no wallet installed") instead of surfacing a transport message.
const WALLET_ERRORS: Record<string, string> = {
  WALLET_NOT_FOUND: 'No Canton wallet found in this browser — install Grofty to sign with your own party.',
  WALLET_NOT_INSTALLED: 'No Canton wallet is installed in this browser.',
  PROVIDER_NOT_FOUND: 'No Canton wallet provider was announced by this browser.',
  USER_REJECTED: 'The connection was rejected in the wallet.',
  SESSION_EXPIRED: 'The wallet session expired — connect again.',
  TIMEOUT: 'The wallet did not respond in time.',
  TRANSPORT_ERROR: 'Lost the connection to the wallet.',
  NOT_CONNECTED: 'The wallet is not connected.',
};

export function describeWalletError(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && WALLET_ERRORS[code]) return WALLET_ERRORS[code];
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/provider not found|not installed|no wallet|wallet not found/i.test(msg)) return WALLET_ERRORS.WALLET_NOT_FOUND;
  if (/reject|cancel|denied/i.test(msg)) return WALLET_ERRORS.USER_REJECTED;
  return msg || 'The wallet could not complete the request.';
}

const DISCONNECTED = (reason?: string): WalletState => ({ connected: false, real: true, reason });

class GroftyWallet implements WalletAdapter {
  readonly id = 'grofty';
  readonly label = 'Grofty';
  readonly real = true;
  private mod: DappSdkModule | null = null;
  private account: WalletAccount | null = null;

  // The SDK is browser-only and pulls a large dependency graph, so it is loaded
  // lazily — never on the server, never before the user asks for a wallet.
  private async sdk(): Promise<DappSdkModule> {
    if (typeof window === 'undefined')
      throw new Error('A Canton wallet only exists in the browser');
    if (!this.mod) this.mod = await import('@canton-network/dapp-sdk');
    return this.mod;
  }

  private async readAccount(sdk: DappSdkModule): Promise<WalletAccount> {
    const wallets = await sdk.listAccounts();
    const held = wallets.find((w) => w.primary) ?? wallets[0];
    if (!held) throw new Error('The wallet connected but exposed no Canton party');
    return { partyId: held.partyId, networkId: held.networkId, hint: held.hint };
  }

  async restore(): Promise<WalletState> {
    try {
      // init() registers adapters and restores a persisted session *without*
      // opening the wallet picker, so a returning user is already connected.
      const sdk = await this.sdk();
      await sdk.init();
      const res = await sdk.isConnected();
      if (!res.isConnected) return DISCONNECTED(res.reason);
      this.account = await this.readAccount(sdk);
      return { connected: true, real: true, account: this.account };
    } catch (e) {
      return DISCONNECTED(describeWalletError(e));
    }
  }

  async connect(): Promise<WalletState> {
    try {
      const sdk = await this.sdk();
      await sdk.init();
      const res = await sdk.connect();
      if (!res.isConnected) throw new Error(res.reason ?? res.networkReason ?? 'The wallet did not connect');
      this.account = await this.readAccount(sdk);
      return { connected: true, real: true, account: this.account };
    } catch (e) {
      this.account = null;
      throw new Error(describeWalletError(e));
    }
  }

  async disconnect(): Promise<void> {
    const sdk = await this.sdk();
    await sdk.disconnect();
    this.account = null;
  }

  async sign(req: SignRequest): Promise<{ signature: string }> {
    if (!this.account) throw new Error('Connect the wallet before signing');
    // Real signing happens inside the wallet as part of submitting a command
    // (see `submit`). This only records what was signed.
    return { signature: `grofty:${req.application}:${req.verb}:${req.reference}` };
  }

  // Hand the command to the wallet: it signs with the party's key and submits
  // through its own validator. This is the path that makes the wallet part of
  // the flow rather than a decoration.
  async submit(req: SubmitRequest): Promise<{ commandId?: string; updateId?: string }> {
    const sdk = await this.sdk();
    const params = { commands: req.commands, actAs: req.actAs } as Parameters<
      typeof sdk.prepareExecuteAndWait
    >[0];
    const { tx } = await sdk.prepareExecuteAndWait(params);
    // The result is the wallet's own transaction event; the update id is carried
    // in its payload when the wallet exposes it.
    const payload = (tx as { payload?: { updateId?: string } } | undefined)?.payload;
    return { commandId: tx?.commandId, updateId: payload?.updateId };
  }
}

// Stand-in for a browser with no Canton wallet installed. It produces no
// signature and is surfaced in the UI as `real = false`, so nothing about a demo
// run can be mistaken for real signing.
class DemoWallet implements WalletAdapter {
  readonly id = 'demo';
  readonly label = 'Grofty (demo signer)';
  readonly real = false;
  private connected = false;

  async restore(): Promise<WalletState> {
    return { connected: false, real: false, reason: 'No wallet session to restore' };
  }
  async connect(): Promise<WalletState> {
    this.connected = true;
    return { connected: true, real: false, reason: 'Demo signer — no cryptographic signature' };
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async sign(req: SignRequest): Promise<{ signature: string }> {
    if (!this.connected) throw new Error('Connect a wallet before signing');
    return { signature: `demo:${req.application}:${req.verb}:${req.reference}` };
  }
}

const grofty = new GroftyWallet();
const demo = new DemoWallet();

/** The real adapter: an installed Canton wallet (Grofty). */
export const getWallet = (): WalletAdapter => grofty;

/** The explicit stand-in, used only when no wallet is installed. */
export const getDemoWallet = (): WalletAdapter => demo;
