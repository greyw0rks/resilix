import { Wallet, Shield, Server, Activity, ChevronRight } from 'lucide-react';
import { APPLICATIONS } from '@/lib/applications';
import { Icon } from './icons';
import { Card, Eyebrow, cn } from './ui';

const LAYERS = [
  { title: 'Grofty', text: 'User interaction · wallet · signing', icon: Wallet },
  { title: 'Resilix', text: 'Policy · approval · audit engines', icon: Shield, primary: true },
  { title: 'Decentralization Manager', text: 'Decentralized Party · operators', icon: Server },
  { title: 'Canton Network', text: 'Settlement · privacy', icon: Activity },
];

// Static explanation of how the layers compose. Each component has one job.
export function Architecture() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <Eyebrow>How it fits together</Eyebrow>
      <h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
        One control layer. Every privileged action.
      </h2>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-400">
        Grofty is the interaction layer. Resilix is the control layer. The
        Decentralization Manager owns the Decentralized Party and operator topology. Canton settles.
      </p>

      <div className="bg-grid mt-8 flex flex-col items-stretch gap-3 rounded-2xl border border-white/8 p-4 md:flex-row md:items-center">
        {LAYERS.map((l, i) => (
          <div key={l.title} className="flex flex-1 items-center gap-3">
            <div
              className={cn(
                'flex min-h-[128px] flex-1 flex-col rounded-xl border p-4',
                l.primary ? 'border-brand-500/50 bg-brand-500/[0.08]' : 'border-white/8 bg-white/[0.02]',
              )}
            >
              <span
                className={cn(
                  'mb-4 grid h-9 w-9 place-items-center rounded-lg',
                  l.primary ? 'bg-brand-500 text-white' : 'bg-white/5 text-brand-400',
                )}
              >
                <l.icon size={17} />
              </span>
              <b className="text-[13px] text-white">{l.title}</b>
              <small className="mt-1 text-[11px] leading-snug text-slate-500">{l.text}</small>
            </div>
            {i < LAYERS.length - 1 && (
              <ChevronRight className="flex-none rotate-90 text-slate-600 md:rotate-0" size={18} />
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {APPLICATIONS.map((a) => (
          <Card key={a.id} className="flex items-center gap-3 p-3.5">
            <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-brand-500/10 text-brand-400">
              <Icon name={a.icon} size={16} />
            </span>
            <span>
              <b className="block text-[13px] text-slate-100">{a.name}</b>
              <small className="block text-[11px] leading-snug text-slate-500">{a.summary}</small>
            </span>
          </Card>
        ))}
      </div>
    </section>
  );
}
