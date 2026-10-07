// Core domain model for Canton Resilience.
// The decentralization layer is application-agnostic: every protected
// application is described by the same shape — parties, an approval
// threshold, a set of hosting operators, and a single privileged action.

export type IconKey =
  | 'treasury'
  | 'token'
  | 'trading'
  | 'governance'
  | 'shield'
  | 'server'
  | 'audit'
  | 'wallet';

export interface PartyRef {
  id: string;
  name: string;
  role: string;
}

export interface HostingNode {
  id: string;
  label: string;
  operator: string;
  // Slug of the allocated Canton party that hosts this node (see
  // daml/Init.daml + LEDGER_PARTY_MAP). Each operator reports its own status.
  slug: string;
}

export interface ProtectedAction {
  verb: string; // e.g. "TRANSFER", "MINT", "SET FEE", "PAUSE"
  title: string; // e.g. "Send 50,000 CC"
  primary: string; // large headline value, e.g. "50,000 CC"
  from?: string;
  to?: string;
  detail: string; // human explanation of the effect
  reference: string; // request id shown in the audit trail
}

export interface DemoApplication {
  id: string;
  name: string; // "Treasury"
  icon: IconKey;
  summary: string; // one line describing what the app does
  parties: PartyRef[];
  threshold: number; // approvals required to execute
  hostingNodes: HostingNode[];
  hostingThreshold: number; // minimum online operators to stay available
  action: ProtectedAction;
}

export type AuditKind =
  | 'requested'
  | 'approved'
  | 'node-offline'
  | 'node-online'
  | 'blocked'
  | 'executed';

export interface AuditEvent {
  id: string;
  kind: AuditKind;
  label: string;
  detail?: string;
  actor?: string;
  at: number; // sequence index; deterministic, not wall-clock
  // The ledger's own timestamp for this event (ISO-8601), present only when the
  // entry comes from a real ledger event rather than being derived in the UI.
  ledgerTime?: string;
}

// A real, immutable AuditRecord contract read back from the ledger (the shape
// of daml/Main.daml's AuditRecord). Party fields are de-qualified to UI slugs.
export interface LedgerAuditRecord {
  verb: string;
  target: string;
  detail: string;
  reference: string;
  approvals: string[]; // approver slugs, in the order recorded on-ledger
  executor: string; // slug of the party that executed
  onlineOperators?: number; // online operators at execution time
  hostingThreshold?: number; // hosting threshold at execution time
  timestamp?: string; // ledger time the record was created (ISO-8601)
}
