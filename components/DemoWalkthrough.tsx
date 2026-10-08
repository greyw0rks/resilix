'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Play, Pause, RotateCcw, Shield } from 'lucide-react';
import { getApplication } from '@/lib/applications';
import { buildAudit, type ConsoleState } from '@/lib/engine';
import { SharedControl } from './SharedControl';
import { DistributedHosting } from './DistributedHosting';
import { AuditTrail } from './AuditTrail';
import { Eyebrow, Pill, cn } from './ui';

// A hands-free, narrated walkthrough of one protected action moving through the
// four pillars: policy → shared-control approval → distributed-hosting
// resilience → immutable audit. It runs on the Treasury reference app with the
// in-memory model (no ledger needed), so it always plays. The interactive,
// ledger-backed version is the console at `/`.

type Focus = 'control' | 'hosting' | 'audit';

interface Step {
  title: string;
  caption: string;
  approvals: string[];
  offline: string[];
  executed: boolean;
  focus: Focus;
}

const app = getApplication('treasury');

const STEPS: Step[] = [
  {
    title: 'A protected action is requested',
    caption:
      'Alice opens a TRANSFER request for 50,000 CC (REQ-1042) against the Treasury policy. Nothing moves yet — the request only records intent and the quorum it must meet.',
    approvals: [],
    offline: [],
    executed: false,
    focus: 'control',
  },
  {
    title: 'First approval',
    caption:
      'Alice approves. That is one of the two signatures the policy requires. The action stays blocked — no single party can move funds alone.',
    approvals: ['alice'],
    offline: [],
    executed: false,
    focus: 'control',
  },
  {
    title: 'Quorum met',
    caption:
      'Bob approves. Two of two — shared control is satisfied on the ledger, not in the UI. The approval set is append-only and attributable.',
    approvals: ['alice', 'bob'],
    offline: [],
    executed: false,
    focus: 'control',
  },
  {
    title: 'An operator goes offline',
    caption:
      'Operator Beta (Node B) drops. Two of three operators remain online — at or above the hosting threshold — so the application stays available. Approval and hosting are independent concerns.',
    approvals: ['alice', 'bob'],
    offline: ['b'],
    executed: false,
    focus: 'hosting',
  },
  {
    title: 'Execute',
    caption:
      'With quorum met and hosting healthy, the action executes and writes an immutable AuditRecord. The request contract is consumed, so it can never execute twice.',
    approvals: ['alice', 'bob'],
    offline: ['b'],
    executed: true,
    focus: 'audit',
  },
  {
    title: 'Everything is traceable',
    caption:
      'Request, each approval, the hosting change and the execution are all captured in order. On a live ledger this trail is read back from the AuditRecord contracts, not reconstructed in the browser.',
    approvals: ['alice', 'bob'],
    offline: ['b'],
    executed: true,
    focus: 'audit',
  },
];

const FOCUS_RING = 'ring-2 ring-brand-500/60 ring-offset-2 ring-offset-[#070b12]';

export function DemoWalkthrough() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const step = STEPS[i];
  const atEnd = i === STEPS.length - 1;

  // Auto-advance ~every 3.6s while playing; stop at the final step.
  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setI((n) => Math.min(n + 1, STEPS.length - 1)), 3600);
    return () => clearTimeout(t);
  }, [playing, i, atEnd]);

  const state: ConsoleState = {
    approvals: step.approvals,
    offlineNodes: step.offline,
    walletConnected: step.executed,
    executed: step.executed,
  };
  const audit = useMemo(() => buildAudit(app, state, []), [i]); // eslint-disable-line react-hooks/exhaustive-deps
  const noop = () => {};

  const go = (n: number) => {
    setPlaying(false);
    setI(Math.max(0, Math.min(STEPS.length - 1, n)));
  };
  const replay = () => {
    setI(0);
    setPlaying(true);
  };

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#070b12]/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
          <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight text-white">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600">
              <Shield size={17} />
            </span>
            Resi<span className="text-brand-400">lix</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-white/25 hover:text-white"
          >
            <ArrowLeft size={14} /> Open the interactive console
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-10">
        <Eyebrow light>Guided walkthrough · Treasury (2 of 3)</Eyebrow>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          One protected action, four pillars
        </h1>
        {/* Narration + controls */}
        <div className="mt-6 rounded-2xl border border-brand-500/20 bg-brand-500/[0.04] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <Pill tone="brand">
                  Step {i + 1} / {STEPS.length}
                </Pill>
                <b className="text-sm font-semibold text-white">{step.title}</b>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">{step.caption}</p>
            </div>
            <div className="flex flex-none items-center gap-1.5">
              <Ctrl onClick={() => go(i - 1)} disabled={i === 0} label="Previous step">
                <ArrowLeft size={16} />
              </Ctrl>
              {atEnd ? (
                <Ctrl onClick={replay} label="Replay">
                  <RotateCcw size={16} />
                </Ctrl>
              ) : (
                <Ctrl onClick={() => setPlaying((p) => !p)} label={playing ? 'Pause' : 'Play'}>
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </Ctrl>
              )}
              <Ctrl onClick={() => go(i + 1)} disabled={atEnd} label="Next step">
                <ArrowRight size={16} />
              </Ctrl>
            </div>
          </div>

          <div className="mt-4 flex gap-1.5">
            {STEPS.map((_, n) => (
              <button
                key={n}
                onClick={() => go(n)}
                aria-label={`Go to step ${n + 1}`}
                className={cn(
                  'h-1.5 flex-1 rounded-full transition-colors',
                  n === i ? 'bg-brand-500' : n < i ? 'bg-brand-500/40' : 'bg-white/10',
                )}
              />
            ))}
          </div>
        </div>
        {/* The three pillars, driven by the current step */}
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <div className={cn('rounded-2xl transition-shadow', step.focus === 'control' && FOCUS_RING)}>
            <SharedControl app={app} approvals={step.approvals} locked onToggle={noop} />
          </div>
          <div className={cn('rounded-2xl transition-shadow', step.focus === 'hosting' && FOCUS_RING)}>
            <DistributedHosting app={app} offlineNodes={step.offline} locked onToggle={noop} />
          </div>
        </div>

        <div className={cn('mt-4 rounded-2xl transition-shadow', step.focus === 'audit' && FOCUS_RING)}>
          <AuditTrail events={audit} />
        </div>

        <p className="mt-6 text-xs text-slate-500">
          This walkthrough runs on the in-memory model. The same flow backed by a live Canton ledger
          is the interactive console at{' '}
          <Link href="/" className="text-brand-400 hover:underline">
            /
          </Link>
          .
        </p>
      </section>
    </main>
  );
}

function Ctrl({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-slate-200 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
