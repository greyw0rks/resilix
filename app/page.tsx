import { Shield } from 'lucide-react';
import { Console } from '@/components/Console';
import { Architecture } from '@/components/Architecture';

export default function Home() {
  return (
    <main>
      <Console />
      <Architecture />
      <footer className="mt-8 border-t border-white/8">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-6 px-6 py-10 sm:flex-row">
          <div>
            <div className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight text-white">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white">
                <Shield size={17} />
              </span>
              Resi<span className="text-brand-400">lix</span>
            </div>
            <p className="mt-3 max-w-sm text-xs text-slate-500">
              Reusable decentralized authorization and hosting for Canton applications.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] text-slate-500">
            <span>LocalNet MVP</span>
            <span>Daml policy contracts</span>
            <span>Grofty adapter</span>
            <span>BitSafe Decentralization Manager</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
