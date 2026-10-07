import type { AuditEvent, DemoApplication, LedgerAuditRecord } from './types';

// Pure derivations over the live demo state. Keeping these free of React lets
// the same policy/hosting/audit logic map cleanly onto the Daml choices that
// back it on a real ledger (see daml/Main.daml).

export interface ConsoleState {
  approvals: string[]; // party ids that have approved
  offlineNodes: string[]; // hosting node ids that are offline
  walletConnected: boolean;
  executed: boolean;
}

export const onlineCount = (app: DemoApplication, s: ConsoleState) =>
  app.hostingNodes.length - s.offlineNodes.filter((id) => app.hostingNodes.some((n) => n.id === id)).length;

// Distributed hosting: the application stays available while enough operators
// remain online, independent of who approves an action.
export const isAvailable = (app: DemoApplication, s: ConsoleState) =>
  onlineCount(app, s) >= app.hostingThreshold;

// Shared control: the action does not execute until the approval threshold is met.
export const approvalsMet = (app: DemoApplication, s: ConsoleState) =>
  s.approvals.length >= app.threshold;

export const canExecute = (app: DemoApplication, s: ConsoleState) =>
  !s.executed && approvalsMet(app, s) && isAvailable(app, s) && s.walletConnected;

// Build the audit trail from current state. Deterministic ordering:
// request, approvals (in party order), hosting events, then execution.
//
// `records` are the real AuditRecord contracts read back from the ledger. When
// present, the execution entries come from the ledger (real executor + quorum),
// not from synthetic state — this is what makes the audit trail authoritative
// in live mode rather than a UI reconstruction.
export const buildAudit = (
  app: DemoApplication,
  s: ConsoleState,
  records: LedgerAuditRecord[] = [],
): AuditEvent[] => {
  const events: AuditEvent[] = [];
  let at = 0;
  const nameOf = (slug: string) => app.parties.find((p) => p.id === slug)?.name ?? slug;
  const push = (e: Omit<AuditEvent, 'id' | 'at'>) =>
    events.push({ ...e, id: `${app.id}-${at}`, at: at++ });

  push({
    kind: 'requested',
    label: `${app.action.verb} requested`,
    detail: `${app.action.title} · ${app.action.reference}`,
    actor: app.parties[0].name,
  });

  for (const party of app.parties) {
    if (s.approvals.includes(party.id)) {
      push({
        kind: 'approved',
        label: `Approved by ${party.name}`,
        detail: party.role,
        actor: party.name,
      });
    }
  }

  for (const node of app.hostingNodes) {
    if (s.offlineNodes.includes(node.id)) {
      push({
        kind: 'node-offline',
        label: `${node.label} offline`,
        detail: `${node.operator} · hosting continues on ${onlineCount(app, s)}/${app.hostingNodes.length}`,
      });
    }
  }

  if (records.length > 0) {
    // Authoritative: one entry per immutable AuditRecord on the ledger. The
    // hosting state captured at execution time is part of the record, so the
    // trail shows the resilience fact alongside the quorum.
    for (const r of records) {
      const hosting =
        r.onlineOperators != null && r.hostingThreshold != null
          ? ` · ${r.onlineOperators}/${app.hostingNodes.length} operators online`
          : '';
      push({
        kind: 'executed',
        label: `${r.verb} executed`,
        detail: `On-ledger AuditRecord · ${r.reference} · quorum ${r.approvals.length}/${app.parties.length}${hosting}`,
        actor: nameOf(r.executor),
      });
    }
  } else if (s.executed) {
    push({
      kind: 'executed',
      label: `${app.action.verb} executed`,
      detail: `Signed via Grofty · quorum ${app.threshold}/${app.parties.length}`,
      actor: 'Grofty',
    });
  } else if (approvalsMet(app, s) && !isAvailable(app, s)) {
    push({
      kind: 'blocked',
      label: 'Execution unavailable',
      detail: `Hosting below ${app.hostingThreshold}/${app.hostingNodes.length} operators`,
    });
  }

  return events;
};
