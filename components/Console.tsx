'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, Wallet, ArrowRight, RotateCcw, CheckCircle2, Database } from 'lucide-react';
import { getApplication } from '@/lib/applications';
import { buildAudit, canExecute, isAvailable, approvalsMet, type ConsoleState } from '@/lib/engine';
import { getLedger } from '@/lib/ledger';
import { describeWalletError, getDemoWallet, getWallet, type WalletAdapter, type WalletState } from '@/lib/wallet';
import type { LedgerAuditRecord } from '@/lib/types';
import { Hero } from './Hero';
import { ApplicationSwitcher } from './ApplicationSwitcher';
import { SharedControl } from './SharedControl';
import { DistributedHosting } from './DistributedHosting';
import { AuditTrail } from './AuditTrail';
import { Eyebrow, cn } from './ui';

const NAV: { label: string; href: string }[] = [
  { label: 'Overview', href: '#overview' },
  { label: 'Applications', href: '#applications' },
  { label: 'Approvals', href: '#approvals' },
  { label: 'Hosting', href: '#hosting' },
  { label: 'Audit', href: '#audit' },
];

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return 'Something went wrong talking to the ledger.';
}

export function Console() {
  const ledger = useMemo(() => getLedger(), []);
  const isLive = ledger.kind === 'json-api';
  const [selectedId, setSelectedId] = useState('treasury');
  const [approvals, setApprovals] = useState<string[]>([]);
  const [executed, setExecuted] = useState(false);
  const [records, setRecords] = useState<LedgerAuditRecord[]>([]);
  const [offlineNodes, setOfflineNodes] = useState<string[]>([]);
  // The wallet is a real adapter over the Canton dApp SDK (lib/wallet.ts), not a
  // local boolean: `walletState` is what the SDK reports about the wallet that
  // is actually installed in this browser.
  const [wallet, setWallet] = useState<WalletAdapter>(() => getWallet());
  const [walletState, setWalletState] = useState<WalletState>({ connected: false, real: false });
  // Offered only when the browser has no Canton wallet at all, so the demo can
  // still run — the stand-in is labelled as such everywhere it appears.
  const [offerDemoSigner, setOfferDemoSigner] = useState(false);
  const walletConnected = walletState.connected;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The ledger's transaction id for the execution made in this session. It is
  // not part of the AuditRecord (the durable artefact), so it is intentionally
  // session-scoped: re-reading the ledger recovers the record, not this receipt.
  const [txId, setTxId] = useState<string | undefined>(undefined);

  const app = getApplication(selectedId);

  const refresh = useCallback(async () => {
    const [v, r, h] = await Promise.all([ledger.view(app), ledger.audit(app), ledger.hosting(app)]);
    setApprovals(v.approvals);
    setExecuted(v.executed);
    setRecords(r);
    // Hosting state is read from the application's HostingGroup contract, so
    // an operator's status is ledger truth rather than local UI state.
    setOfflineNodes(h.offline);
  }, [ledger, app]);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    setTxId(undefined); // the receipt belongs to the app that was just executed
    ledger
      .openRequest(app)
      .then(() => refresh())
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [ledger, app, refresh]);

  // On a real ledger, poll so a second approver's action (or a browser reload
  // on another machine) is reflected here. State lives on the ledger, so a
  // refresh always recovers it.
  useEffect(() => {
    if (!isLive) return;
    const onFocus = () => refresh().catch((e) => setError(errorMessage(e)));
    const id = setInterval(onFocus, 4000);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [isLive, refresh]);

  // Ask an installed wallet whether it already has an approved session. This is
  // silent by design — it never opens the wallet UI — so a returning user is
  // connected on load and a browser with no wallet simply stays disconnected.
  useEffect(() => {
    let active = true;
    wallet
      .restore()
      .then((s) => {
        if (active && s.connected) setWalletState(s);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [wallet]);

  const toggleWallet = async () => {
    setBusy(true);
    setError(null);
    setOfferDemoSigner(false);
    try {
      if (walletState.connected) {
        await wallet.disconnect();
        setWalletState({ connected: false, real: wallet.real });
      } else {
        setWalletState(await wallet.connect());
      }
    } catch (e) {
      const message = describeWalletError(e);
      setWalletState({ connected: false, real: wallet.real, reason: message });
      setError(message);
      // Only a wallet that isn't there justifies the stand-in. A rejected or
      // expired session is a real wallet problem, and the user should see it
      // rather than have the console quietly sign for them.
      if (wallet.real && /no canton wallet|not installed|was announced/i.test(message)) setOfferDemoSigner(true);
    } finally {
      setBusy(false);
    }
  };

  const useDemoSigner = async () => {
    setBusy(true);
    setError(null);
    setOfferDemoSigner(false);
    try {
      const demo = getDemoWallet();
      setWallet(demo);
      setWalletState(await demo.connect());
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(false);
    }
  };

  const state: ConsoleState = { approvals, offlineNodes, walletConnected, executed };
  const audit = useMemo(() => buildAudit(app, state, records), [app, approvals, offlineNodes, executed, records]);

  // When the connected wallet holds the very party the command must be
  // authorized by, the wallet signs and submits it. That is the whole point of
  // the integration: no server ever signs for a party the user owns. Anywhere
  // else — including LocalNet, where an installed wallet is on another network
  // entirely — this returns null and the command goes through the server route
  // exactly as before.
  const submitViaWallet = async (
    action: 'approve' | 'execute',
    slug: string,
  ): Promise<{ updateId?: string } | null> => {
    if (!walletState.connected || !walletState.real || !wallet.submit) return null;
    const prepared = await ledger.prepare(app, action, slug);
    if (!prepared || prepared.actAs[0] !== walletState.account?.partyId) return null;
    return wallet.submit({ commands: prepared.commands, actAs: prepared.actAs });
  };

  const toggleApproval = async (id: string) => {
    if (executed || busy) return;
    // Approvals are append-only on a real ledger — clicking an approved party
    // is a no-op. The in-memory demo keeps toggle semantics for convenience.
    if (approvals.includes(id) && isLive) return;
    setBusy(true);
    setError(null);
    try {
      if (approvals.includes(id)) await ledger.revoke(app, id);
      else if (!(await submitViaWallet('approve', id))) await ledger.approve(app, id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleNode = async (id: string) => {
    if (executed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // If the node is currently offline, bringing it back is an "online"
      // report; otherwise this takes it down. Either way the operator reports
      // its own status and the ledger re-checks the guards.
      await ledger.setNodeStatus(app, id, offlineNodes.includes(id));
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const doExecute = async () => {
    if (!canExecute(app, state) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const viaWallet = await submitViaWallet('execute', app.parties[0].id);
      const id = viaWallet ? viaWallet.updateId : await ledger.execute(app, app.parties[0].id);
      setTxId(id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    setError(null);
    setTxId(undefined);
    try {
      // On a real ledger there is no reset — just re-read current state.
      if (!isLive) await ledger.openRequest(app);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = canExecute(app, state);
  const met = approvalsMet(app, state);
  const available = isAvailable(app, state);
  const need = app.threshold - approvals.length;
  const blockReason = executed
    ? txId
      ? `Recorded on the ledger · tx ${txId.slice(0, 16)}…`
      : 'Executed and recorded on the ledger'
    : !met
    ? `Needs ${need} more approval${need === 1 ? '' : 's'}`
    : !available
    ? 'Hosting below threshold'
    : !walletConnected
    ? 'Connect Grofty to sign'
    : 'Ready to execute';

  return (
    <>
      <Topbar
        wallet={walletState}
        walletBusy={busy}
        offerDemoSigner={offerDemoSigner}
        onWallet={toggleWallet}
        onDemoSigner={useDemoSigner}
        ledgerKind={ledger.kind}
      />
      <div id="overview" className="scroll-mt-20">
        <Hero app={app} offlineNodes={offlineNodes} />
      </div>

      <section id="applications" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-14">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <Eyebrow>Reference applications</Eyebrow>
            <h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              The same layer protects every action
            </h2>
          </div>
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200"
          >
            <RotateCcw size={14} /> Reset demo
          </button>
        </div>

        <ApplicationSwitcher selected={selectedId} onSelect={setSelectedId} />

        <div className="mt-5 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <div id="approvals" className="scroll-mt-20">
            <SharedControl app={app} approvals={approvals} locked={executed || busy} onToggle={toggleApproval} />
          </div>
          <div id="hosting" className="scroll-mt-20">
            <DistributedHosting
              app={app}
              offlineNodes={offlineNodes}
              locked={executed || busy}
              onToggle={toggleNode}
              note={isLive ? 'read from ledger HostingGroup' : undefined}
            />
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-sm text-red-200"
          >
            <span className="mt-px font-mono text-[11px] uppercase tracking-wider text-red-400">Error</span>
            <span>{error}</span>
          </div>
        )}

        <div className="mt-4 flex flex-col items-stretch justify-between gap-4 rounded-2xl border border-white/8 bg-white/[0.02] p-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span
                className={cn(
                  'relative inline-flex h-3 w-3 rounded-full',
                  ready || executed ? 'bg-emerald-400' : 'bg-amber-400',
                )}
              />
            </span>
            <div>
              <b className="block text-sm text-white">
                {executed ? `${app.action.verb} executed` : app.action.title}
              </b>
              <small className="block font-mono text-[11px] text-slate-500">{blockReason}</small>
            </div>
          </div>
          {executed ? (
            <span className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-300">
              <CheckCircle2 size={16} /> Signed via Grofty
            </span>
          ) : (
            <button
              onClick={doExecute}
              disabled={!ready}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
            >
              Execute {app.action.verb} <ArrowRight size={16} />
            </button>
          )}
        </div>

        <div className="mt-4 scroll-mt-20" id="audit">
          <AuditTrail
            events={audit}
            note={isLive && records.length > 0 ? 'read from ledger AuditRecord' : undefined}
          />
        </div>
      </section>
    </>
  );
}

// The connected account is shown by its Canton party id, not a nickname: the
// party id is what the ledger authorizes, so it is what the user should see.
const shortParty = (partyId: string) => {
  const [name, fingerprint] = partyId.split('::');
  return fingerprint ? `${name}::${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}` : partyId;
};

function Topbar({
  wallet,
  walletBusy,
  offerDemoSigner,
  onWallet,
  onDemoSigner,
  ledgerKind,
}: {
  wallet: WalletState;
  walletBusy: boolean;
  offerDemoSigner: boolean;
  onWallet: () => void;
  onDemoSigner: () => void;
  ledgerKind: string;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-white/8 bg-[#070b12]/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-10 px-6">
        <div className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight text-white">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white">
            <Shield size={17} />
          </span>
          Canton<span className="text-brand-400">Resilience</span>
        </div>
        <nav className="hidden flex-1 items-center gap-6 md:flex">
          {NAV.map((n, i) => (
            <a
              key={n.label}
              href={n.href}
              className={cn(
                'cursor-pointer text-[13px] transition-colors hover:text-white',
                i === 0 ? 'text-white' : 'text-slate-500',
              )}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <span className="hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500 lg:inline-flex">
          <Database size={12} /> {ledgerKind}
        </span>
        {offerDemoSigner && !wallet.connected && (
          <button
            onClick={onDemoSigner}
            className="hidden items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] font-medium text-amber-300 transition-colors hover:border-amber-400/50 sm:inline-flex"
          >
            Use the demo signer
          </button>
        )}
        <button
          onClick={onWallet}
          disabled={walletBusy}
          title={wallet.reason ?? undefined}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] font-semibold transition-colors disabled:opacity-60',
            wallet.connected
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-white/10 bg-white/5 text-slate-200 hover:border-white/25',
          )}
        >
          <Wallet size={15} />
          {wallet.connected && wallet.account ? (
            <span className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-normal">{shortParty(wallet.account.partyId)}</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                  wallet.real ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-500/20 text-amber-200',
                )}
              >
                {wallet.real ? 'wallet' : 'demo'}
              </span>
            </span>
          ) : walletBusy ? (
            'Connecting…'
          ) : (
            'Connect Grofty'
          )}
        </button>
      </div>
      {wallet.connected && !wallet.real && (
        <div className="border-t border-amber-500/20 bg-amber-500/[0.07] px-6 py-1.5 text-center font-mono text-[10px] text-amber-300/90">
          Demo signer — no Canton wallet is installed in this browser, so nothing here is cryptographically signed.
        </div>
      )}
    </header>
  );
}
