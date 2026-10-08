import type { DemoApplication } from '@/lib/types';
import { isAvailable, onlineCount } from '@/lib/engine';
import { cn, Eyebrow } from './ui';

// Signature visual: one operator disappears, the application survives.
// Driven by live console state so toggling a node updates the hero.
export function Hero({ app, offlineNodes }: { app: DemoApplication; offlineNodes: string[] }) {
  const s = { approvals: [], offlineNodes, walletConnected: false, executed: false };
  const available = isAvailable(app, s);
  const online = onlineCount(app, s);

  return (
    <section className="bg-grid relative overflow-hidden border-b border-white/8">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-500/60 to-transparent"
        aria-hidden
      />
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-24">
        <Eyebrow light>
          <span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 align-middle" />
          Decentralized control for Canton
        </Eyebrow>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight text-white md:text-[3.4rem]">
          What happens when{' '}
          <span className="text-brand-400">one operator disappears?</span>
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-slate-400">
          Resilix is a reusable control layer for Canton applications. It defines who can
          act, how many parties must approve, which operators host the Decentralized Party, and how
          every decision is audited.
        </p>

        <div className="mt-14 flex flex-col items-center gap-0">
          <TopoBox className="border-brand-500/30 bg-brand-500/[0.07]">
            <b className="text-sm text-white">Decentralization Manager</b>
            <small className="mt-0.5 block font-mono text-[11px] text-slate-400">
              Decentralized Party · {app.name}
            </small>
          </TopoBox>
          <Spine />
          <div className="flex flex-wrap justify-center gap-3">
            {app.hostingNodes.map((n) => {
              const off = offlineNodes.includes(n.id);
              return (
                <div
                  key={n.id}
                  className={cn(
                    'relative min-w-[130px] rounded-xl border px-4 py-3 text-center transition-colors',
                    off
                      ? 'border-red-500/30 bg-red-500/[0.08]'
                      : 'border-emerald-500/25 bg-emerald-500/[0.06]',
                  )}
                >
                  {off && (
                    <span className="absolute right-2.5 top-2 font-bold text-red-400">✕</span>
                  )}
                  <span
                    className={cn(
                      'font-mono text-[9px] font-semibold tracking-[0.14em]',
                      off ? 'text-red-400' : 'text-emerald-400',
                    )}
                  >
                    {off ? 'OFFLINE' : 'ONLINE'}
                  </span>
                  <b className="mt-0.5 block text-[13px] text-white">{n.label}</b>
                  <small className="block font-mono text-[10px] text-slate-500">{n.operator}</small>
                </div>
              );
            })}
          </div>
          <Spine />
          <TopoBox
            className={cn(
              'min-w-[320px]',
              available
                ? 'border-emerald-500/30 bg-emerald-500/[0.07]'
                : 'border-red-500/30 bg-red-500/[0.08]',
            )}
          >
            <b className={cn('text-[15px]', available ? 'text-emerald-300' : 'text-red-300')}>
              APPLICATION {available ? 'REMAINS AVAILABLE' : 'UNAVAILABLE'}
            </b>
            <small className="mt-0.5 block font-mono text-[11px] text-slate-400">
              {online}/{app.hostingNodes.length} operators online · needs {app.hostingThreshold}
            </small>
          </TopoBox>
        </div>
      </div>
    </section>
  );
}

function TopoBox({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-xl border px-6 py-3.5 text-center', className)}>{children}</div>
  );
}
function Spine() {
  return <div className="h-6 w-px bg-slate-600/60" />;
}
