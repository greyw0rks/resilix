import { FileCheck2, CircleDot, CheckCircle2, ServerOff, ShieldCheck, Ban } from 'lucide-react';
import type { AuditEvent, AuditKind } from '@/lib/types';
import { Card, Pill, cn } from './ui';

const ICONS: Record<AuditKind, React.ElementType> = {
  requested: CircleDot,
  approved: CheckCircle2,
  'node-offline': ServerOff,
  'node-online': ServerOff,
  blocked: Ban,
  executed: ShieldCheck,
};

const TONE: Record<AuditKind, string> = {
  requested: 'bg-white/5 text-slate-400',
  approved: 'bg-emerald-500/15 text-emerald-300',
  'node-offline': 'bg-red-500/15 text-red-300',
  'node-online': 'bg-white/5 text-slate-400',
  blocked: 'bg-amber-500/15 text-amber-300',
  executed: 'bg-brand-500/15 text-brand-400',
};

// Auditability: every request, approval, hosting change and execution is
// captured as an ordered, traceable record.
//
// A ledger timestamp arrives as ISO-8601 and is formatted by slicing rather
// than through `Date`, so the rendering is identical on the server and the
// client (no locale or timezone to disagree about).
const stamped = (iso: string): string => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}Z` : iso;
};

export function AuditTrail({ events, note }: { events: AuditEvent[]; note?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-200">
          <FileCheck2 size={15} className="text-brand-400" /> Audit trail
        </span>
        <div className="flex items-center gap-2">
          {note && (
            <span className="hidden font-mono text-[10px] uppercase tracking-wider text-emerald-400 sm:inline">
              {note}
            </span>
          )}
          <Pill>{events.length} events</Pill>
        </div>
      </div>

      <ol className="mt-4 space-y-px">
        {events.map((e, i) => {
          const I = ICONS[e.kind];
          return (
            <li key={e.id} className="relative flex items-center gap-3 py-2.5">
              {i < events.length - 1 && (
                <span className="absolute left-[15px] top-9 h-[calc(100%-1rem)] w-px bg-white/8" />
              )}
              <span className={cn('z-10 grid h-8 w-8 flex-none place-items-center rounded-lg', TONE[e.kind])}>
                <I size={14} />
              </span>
              <span className="flex-1">
                <b className="block text-[13px] text-slate-100">{e.label}</b>
                {e.detail && <small className="block font-mono text-[11px] text-slate-500">{e.detail}</small>}
              </span>
              {(e.actor || e.ledgerTime) && (
                <span className="flex flex-none flex-col items-end gap-1">
                  {e.ledgerTime && (
                    <time
                      dateTime={e.ledgerTime}
                      className="font-mono text-[10px] text-slate-500"
                      title="Ledger timestamp"
                    >
                      {stamped(e.ledgerTime)}
                    </time>
                  )}
                  {e.actor && (
                    <span className="rounded-full bg-white/5 px-2.5 py-1 font-mono text-[10px] font-medium text-slate-400">
                      {e.actor}
                    </span>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
