import { Server, Power, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { DemoApplication } from '@/lib/types';
import { isAvailable, onlineCount } from '@/lib/engine';
import { Card, Pill, cn } from './ui';

// Distributed hosting: taking one operator offline must not take the
// application down while the hosting threshold still permits operation.
export function DistributedHosting({
  app,
  offlineNodes,
  locked,
  onToggle,
  note,
}: {
  app: DemoApplication;
  offlineNodes: string[];
  locked: boolean;
  onToggle: (nodeId: string) => void;
  note?: string;
}) {
  const s = { approvals: [], offlineNodes, walletConnected: false, executed: false };
  const available = isAvailable(app, s);
  const online = onlineCount(app, s);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Server size={15} className="text-brand-400" /> Distributed hosting
        </span>
        <Pill tone={available ? 'emerald' : 'red'}>{available ? 'Healthy' : 'Degraded'}</Pill>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-400">
        Hosted by {app.hostingNodes.length} independent operators. Stays available while at least{' '}
        {app.hostingThreshold} remain online.
      </p>

      {note && (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">{note}</p>
      )}

      <div className="mt-4 space-y-2">
        {app.hostingNodes.map((n) => {
          const off = offlineNodes.includes(n.id);
          return (
            <button
              key={n.id}
              disabled={locked}
              onClick={() => onToggle(n.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-3 text-left transition-colors hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span className="relative flex h-2.5 w-2.5 flex-none">
                {!off && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
                )}
                <span
                  className={cn(
                    'relative inline-flex h-2.5 w-2.5 rounded-full',
                    off ? 'bg-red-500' : 'bg-emerald-400',
                  )}
                />
              </span>
              <span className="flex-1">
                <b className="block text-[13px] text-slate-100">{n.label}</b>
                <small className="block font-mono text-[10px] text-slate-500">{n.operator}</small>
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 font-mono text-[11px]',
                  off ? 'text-red-300' : 'text-slate-400',
                )}
              >
                <Power size={13} /> {off ? 'Offline' : 'Online'}
              </span>
            </button>
          );
        })}
      </div>

      <div
        className={cn(
          'mt-4 flex items-center gap-3 rounded-xl border px-3.5 py-3',
          available
            ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300'
            : 'border-red-500/25 bg-red-500/[0.08] text-red-300',
        )}
      >
        {available ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <div>
          <b className="block text-[13px]">
            {available ? 'Application remains available' : 'Application unavailable'}
          </b>
          <small className="block font-mono text-[11px] opacity-80">
            {online}/{app.hostingNodes.length} operators online · threshold {app.hostingThreshold}
          </small>
        </div>
      </div>
    </Card>
  );
}
