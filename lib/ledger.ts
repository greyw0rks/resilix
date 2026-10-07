import type { DemoApplication, LedgerAuditRecord } from './types';

// Ledger abstraction for the Canton Resilience control layer.
//
// The UI never talks to a participant directly — it goes through this
// interface. `InMemoryLedger` reproduces the exact guards of the Daml
// choices in daml/Main.daml so the demo runs with no external dependency,
// and `HttpLedger` is a drop-in that proxies the same operations through the
// same-origin Next.js route (app/api/ledger/route.ts), which submits them to
// a real Canton participant over the Daml JSON Ledger API v2 (Canton 3.x).
//
// Approvals are append-only, matching the ledger: `ActionRequest.Approve`
// creates a new contract state, it never "un-approves". `revoke` exists only
// for the local demo reset and is unsupported against a real ledger.

export interface RequestView {
  approvals: string[]; // party ids that have approved
  executed: boolean;
}

// Distributed-hosting state, read from the application's HostingGroup contract
// (daml/Main.daml). `offline` holds UI node ids ('a', 'b', …).
export interface HostingView {
  offline: string[];
  online: number;
  threshold: number;
  available: boolean;
}

export interface ResilienceLedger {
  readonly kind: 'in-memory' | 'json-api';
  openRequest(app: DemoApplication): Promise<void>;
  approve(app: DemoApplication, partyId: string): Promise<void>;
  revoke(app: DemoApplication, partyId: string): Promise<void>;
  execute(app: DemoApplication, executor: string): Promise<void>;
  view(app: DemoApplication): Promise<RequestView>;
  // The immutable AuditRecord contracts for this application, oldest first.
  audit(app: DemoApplication): Promise<LedgerAuditRecord[]>;
  // The application's hosting state, as recorded on the ledger.
  hosting(app: DemoApplication): Promise<HostingView>;
  // Report a hosting operator online/offline. On a real ledger this is
  // submitted *as that operator's party* — an operator reports itself.
  setNodeStatus(app: DemoApplication, nodeId: string, online: boolean): Promise<void>;
}

// --- In-memory implementation (default) -----------------------------------
// Mirrors daml/Main.daml: member checks, no double approval, threshold gate.

class InMemoryLedger implements ResilienceLedger {
  readonly kind = 'in-memory' as const;
  private state = new Map<string, RequestView>();
  private records = new Map<string, LedgerAuditRecord[]>();
  private offline = new Map<string, string[]>();

  private ensure(app: DemoApplication): RequestView {
    let v = this.state.get(app.id);
    if (!v) {
      v = { approvals: [], executed: false };
      this.state.set(app.id, v);
    }
    return v;
  }

  async openRequest(app: DemoApplication) {
    this.state.set(app.id, { approvals: [], executed: false });
    this.records.delete(app.id); // demo reset; a real ledger keeps audit records forever
    this.offline.set(app.id, []); // all operators start online
  }

  async approve(app: DemoApplication, partyId: string) {
    const v = this.ensure(app);
    if (v.executed) throw new Error('Action already executed');
    if (!app.parties.some((p) => p.id === partyId))
      throw new Error('Approver is not a policy member');
    if (!v.approvals.includes(partyId)) v.approvals.push(partyId);
  }

  async revoke(app: DemoApplication, partyId: string) {
    const v = this.ensure(app);
    if (v.executed) return;
    v.approvals = v.approvals.filter((id) => id !== partyId);
  }

  async execute(app: DemoApplication, executor: string) {
    const v = this.ensure(app);
    if (v.approvals.length < app.threshold)
      throw new Error('Approval threshold not met');
    v.executed = true;
    // Mirror the ledger's Execute → AuditRecord effect for the demo, including
    // the hosting state captured at execution time.
    const list = this.records.get(app.id) ?? [];
    const offline = this.offline.get(app.id) ?? [];
    list.push({
      verb: app.action.verb,
      target: app.action.to ?? app.action.from ?? app.name,
      detail: app.action.detail,
      reference: app.action.reference,
      approvals: [...v.approvals],
      executor: app.parties.some((p) => p.id === executor) ? executor : app.parties[0].id,
      onlineOperators: app.hostingNodes.length - offline.length,
      hostingThreshold: app.hostingThreshold,
    });
    this.records.set(app.id, list);
  }

  async view(app: DemoApplication): Promise<RequestView> {
    const v = this.ensure(app);
    return { approvals: [...v.approvals], executed: v.executed };
  }

  async audit(app: DemoApplication): Promise<LedgerAuditRecord[]> {
    return [...(this.records.get(app.id) ?? [])];
  }

  // Mirrors HostingGroup's guards: only a listed operator may report, and the
  // report must change the state (no double-offline / redundant online).
  async setNodeStatus(app: DemoApplication, nodeId: string, online: boolean) {
    if (!app.hostingNodes.some((n) => n.id === nodeId))
      throw new Error('Not a hosting operator for this application');
    const current = this.offline.get(app.id) ?? [];
    const isOffline = current.includes(nodeId);
    if (!online && isOffline) throw new Error('Operator is already offline');
    if (online && !isOffline) throw new Error('Operator is already online');
    this.offline.set(app.id, online ? current.filter((id) => id !== nodeId) : [...current, nodeId]);
  }

  async hosting(app: DemoApplication): Promise<HostingView> {
    const offline = [...(this.offline.get(app.id) ?? [])];
    const online = app.hostingNodes.length - offline.length;
    return { offline, online, threshold: app.hostingThreshold, available: online >= app.hostingThreshold };
  }
}

// --- HTTP proxy implementation (JSON Ledger API v2, via /api/ledger) -------
// Active when NEXT_PUBLIC_LEDGER_MODE=json-api. The browser only ever talks to
// the same-origin Next.js route app/api/ledger/route.ts, which owns the
// connection to the Canton participant. Approvals are append-only here, exactly
// as on the ledger — there is no `revoke`.

class HttpLedger implements ResilienceLedger {
  readonly kind = 'json-api' as const;

  private async call(
    op: string,
    app: DemoApplication,
    partyId?: string,
    extra?: Record<string, unknown>,
  ): Promise<any> {
    const res = await fetch('/api/ledger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, appId: app.id, partyId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `Ledger request failed (${res.status})`);
    return data;
  }

  async openRequest(app: DemoApplication) {
    await this.call('openRequest', app);
  }

  async approve(app: DemoApplication, partyId: string) {
    await this.call('approve', app, partyId);
  }

  async revoke(): Promise<void> {
    throw new Error('Approvals are append-only on a real ledger');
  }

  async execute(app: DemoApplication, executor: string) {
    await this.call('execute', app, executor);
  }

  async view(app: DemoApplication): Promise<RequestView> {
    const data = await this.call('view', app);
    return { approvals: data.view?.approvals ?? [], executed: Boolean(data.view?.executed) };
  }

  async audit(app: DemoApplication): Promise<LedgerAuditRecord[]> {
    const data = await this.call('audit', app);
    return (data.records ?? []) as LedgerAuditRecord[];
  }

  async hosting(app: DemoApplication): Promise<HostingView> {
    const data = await this.call('hosting', app);
    return data.hosting as HostingView;
  }

  async setNodeStatus(app: DemoApplication, nodeId: string, online: boolean) {
    await this.call('hostingSet', app, undefined, { nodeId, online });
  }
}

// --- Factory ---------------------------------------------------------------

let singleton: ResilienceLedger | null = null;

export function getLedger(): ResilienceLedger {
  if (singleton) return singleton;
  singleton =
    process.env.NEXT_PUBLIC_LEDGER_MODE === 'json-api' ? new HttpLedger() : new InMemoryLedger();
  return singleton;
}
