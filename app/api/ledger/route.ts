import { NextRequest, NextResponse } from 'next/server';
import { getApplication } from '@/lib/applications';
import type { DemoApplication } from '@/lib/types';

// Server-side bridge to a Canton participant's Daml HTTP JSON API v1 (Daml 2.x).
//
// Why this lives on the server, not in the browser:
//  - the JSON API identifies the acting party from a JWT; minting tokens must
//    not happen in client code, and no ledger secret may reach the browser
//    (see the security section of the plan).
//  - it avoids the browser↔participant CORS problem entirely — the client only
//    ever talks same-origin to /api/ledger.
//
// Contracts and choices are defined in daml/Main.daml. Party slugs (alice, bob…)
// used by the UI are mapped to the real allocated Canton parties via
// LEDGER_PARTY_MAP, which scripts/localnet.sh writes after running daml/Init.daml.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEDGER_URL = process.env.LEDGER_URL; // e.g. http://localhost:7575
const APP_ID = process.env.LEDGER_APP_ID ?? 'canton-resilience';
const PARTY_MAP: Record<string, string> = safeJson(process.env.LEDGER_PARTY_MAP) ?? {};

// The Daml 2.x HTTP JSON API requires the acting party's token to carry the
// participant's ledger id, and it resolves template ids only by concrete
// package id (the '#package-name' shorthand is a 3.x feature). scripts/localnet.sh
// discovers both from the running sandbox / built DAR and writes them here.
const LEDGER_ID = process.env.LEDGER_ID ?? 'sandbox';
const PKG = process.env.LEDGER_PACKAGE_ID ?? '#canton-resilience';
const tid = (t: string) => `${PKG}:Main:${t}`;

function safeJson(s: string | undefined): any {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

// Unsigned (alg:none) dev token carrying the acting party. Accepted only by a
// JSON API started with `--allow-insecure-tokens` against a LocalNet sandbox.
// There is deliberately no secret here — this is a local development bridge.
function mintToken(party: string): string {
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    'https://daml.com/ledger-api': {
      ledgerId: LEDGER_ID,
      applicationId: APP_ID,
      actAs: [party],
      readAs: [party],
    },
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

function qualify(slug: string): string {
  const party = PARTY_MAP[slug];
  if (!party) throw new Error(`No allocated party for "${slug}" — run scripts/localnet.sh`);
  return party;
}
function deQualify(party: string): string {
  const hit = Object.entries(PARTY_MAP).find(([, p]) => p === party);
  return hit ? hit[0] : party;
}

// Map an allocated hosting-operator party back to the UI node id ('a', 'b', …).
function nodeIdOf(app: DemoApplication, party: string): string {
  const slug = deQualify(party);
  return app.hostingNodes.find((n) => n.slug === slug)?.id ?? slug;
}

async function jsonApi(party: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${LEDGER_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${mintToken(party)}`,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok || parsed?.status >= 400) {
    throw new Error(ledgerError(parsed) ?? `Ledger ${path} failed (${res.status})`);
  }
  return parsed;
}

// Turn a JSON API error body into a human-readable, demo-safe message.
function ledgerError(body: any): string | undefined {
  const raw = Array.isArray(body?.errors) ? body.errors.join('; ') : undefined;
  if (!raw) return undefined;
  if (/not a policy member|not an? .*member/i.test(raw)) return 'Not an authorized approver for this policy';
  if (/already approved/i.test(raw)) return 'This party has already approved';
  if (/threshold not met/i.test(raw)) return 'Approval threshold not met';
  if (/requester must be/i.test(raw)) return 'Requester is not a policy member';
  if (/hosting below threshold/i.test(raw)) return 'Application unavailable — hosting below threshold';
  if (/hosting contract belongs to a different/i.test(raw)) return 'Hosting contract belongs to a different application';
  if (/not a hosting operator/i.test(raw)) return 'Not a hosting operator for this application';
  if (/already offline/i.test(raw)) return 'Operator is already offline';
  if (/already online/i.test(raw)) return 'Operator is already online';
  return raw;
}

async function query(reader: string, template: string, q: Record<string, unknown>) {
  const r = await jsonApi(reader, '/v1/query', { templateIds: [template], query: q });
  return (r?.result ?? []) as Array<{ contractId: string; payload: any }>;
}

async function findRequest(appName: string, reader: string) {
  const rows = await query(reader, tid('ActionRequest'), { application: appName });
  return rows[0];
}

async function viewApp(app: DemoApplication) {
  const reader = qualify(app.parties[0].id);
  const [reqs, audits] = await Promise.all([
    query(reader, tid('ActionRequest'), { application: app.name }),
    query(reader, tid('AuditRecord'), { application: app.name }),
  ]);
  const req = reqs[0]?.payload;
  return {
    approvals: ((req?.approvals ?? []) as string[]).map(deQualify),
    executed: audits.length > 0,
  };
}

// Read the immutable AuditRecord contracts back from the ledger. Party fields
// are de-qualified to UI slugs. Approvals are recorded newest-first on-ledger
// (cons onto the head), so reverse to present them in approval order.
async function auditApp(app: DemoApplication) {
  const reader = qualify(app.parties[0].id);
  const rows = await query(reader, tid('AuditRecord'), { application: app.name });
  return rows.map(({ payload: p }) => ({
    verb: p.verb,
    target: deQualify(p.target),
    detail: p.detail,
    reference: p.reference,
    approvals: ((p.approvals ?? []) as string[]).slice().reverse().map(deQualify),
    executor: deQualify(p.executor),
    // The JSON API v1 encodes Int64 as a JSON *string*; convert back to number.
    onlineOperators: p.onlineOperators == null ? undefined : Number(p.onlineOperators),
    hostingThreshold: p.hostingThreshold == null ? undefined : Number(p.hostingThreshold),
  }));
}

// Read the application's HostingGroup: which operators are down, whether the
// application is still available. Availability is a property of the ledger
// contract (Execute enforces the same computation), not of the UI.
async function findHosting(appName: string, reader: string) {
  const rows = await query(reader, tid('HostingGroup'), { application: appName });
  return rows[0];
}

async function hostingApp(app: DemoApplication) {
  const reader = qualify(app.parties[0].id);
  const group = await findHosting(app.name, reader);
  if (!group)
    throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh to initialize`);
  const offline = ((group.payload.offline ?? []) as string[]).map((p) => nodeIdOf(app, p));
  // Int64 arrives as a JSON string over JSON API v1.
  const threshold = Number(group.payload.threshold);
  const online = app.hostingNodes.length - offline.length;
  return { offline, online, threshold, available: online >= threshold };
}

// Report an operator's own node state. Submitted as that operator's party —
// the ledger's ReportOffline/ReportOnline choices are controlled by the node
// itself, so no admin asserts on a node's behalf.
async function setNodeHosting(app: DemoApplication, nodeId: string, online: boolean) {
  const node = app.hostingNodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('Not a hosting operator for this application');
  const nodeParty = qualify(node.slug);
  const group = await findHosting(app.name, node.slug);
  if (!group)
    throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh to initialize`);
  await jsonApi(nodeParty, '/v1/exercise', {
    templateId: tid('HostingGroup'),
    contractId: group.contractId,
    choice: online ? 'ReportOnline' : 'ReportOffline',
    argument: { node: nodeParty },
  });
}

// Ensure a pending ActionRequest exists for the app; create one from the
// app's Policy via RequestAction if not. Idempotent — never resets state.
async function openRequest(app: DemoApplication) {
  const requester = qualify(app.parties[0].id);
  if (await findRequest(app.name, requester)) return;
  const policies = await query(requester, tid('Policy'), { application: app.name });
  const policy = policies[0];
  if (!policy)
    throw new Error(`No Policy on the ledger for "${app.name}" — run scripts/localnet.sh to initialize`);
  await jsonApi(requester, '/v1/exercise', {
    templateId: tid('Policy'),
    contractId: policy.contractId,
    choice: 'RequestAction',
    argument: {
      requester,
      verb: app.action.verb,
      target: app.action.to ?? app.action.from ?? app.name,
      detail: app.action.detail,
      reference: app.action.reference,
    },
  });
}

async function exerciseOnRequest(app: DemoApplication, actorSlug: string, choice: 'Approve' | 'Execute') {
  const actor = qualify(actorSlug);
  const req = await findRequest(app.name, actor);
  if (!req) throw new Error(`No open request for "${app.name}"`);
  // Execute must name the application's live HostingGroup; the choice checks
  // that it belongs to this application and that enough operators are online.
  let argument: Record<string, unknown>;
  if (choice === 'Approve') {
    argument = { approver: actor };
  } else {
    const group = await findHosting(app.name, actor);
    if (!group) throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh`);
    argument = { executor: actor, hostingGroup: group.contractId };
  }
  await jsonApi(actor, '/v1/exercise', {
    templateId: tid('ActionRequest'),
    contractId: req.contractId,
    choice,
    argument,
  });
}

export async function POST(req: NextRequest) {
  if (!LEDGER_URL) {
    return NextResponse.json({ error: 'LEDGER_URL is not configured on the server' }, { status: 503 });
  }
  let body: { op?: string; appId?: string; partyId?: string; nodeId?: string; online?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const app = getApplication(body.appId ?? 'treasury');
  try {
    switch (body.op) {
      case 'openRequest':
        await openRequest(app);
        return NextResponse.json({ ok: true });
      case 'approve':
        await exerciseOnRequest(app, body.partyId ?? '', 'Approve');
        return NextResponse.json({ ok: true });
      case 'execute':
        await exerciseOnRequest(app, body.partyId ?? app.parties[0].id, 'Execute');
        return NextResponse.json({ ok: true });
      case 'view':
        return NextResponse.json({ ok: true, view: await viewApp(app) });
      case 'audit':
        return NextResponse.json({ ok: true, records: await auditApp(app) });
      case 'hosting':
        return NextResponse.json({ ok: true, hosting: await hostingApp(app) });
      case 'hostingSet':
        await setNodeHosting(app, body.nodeId ?? '', body.online === true);
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: `Unknown op "${body.op}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ledger error' }, { status: 400 });
  }
}
