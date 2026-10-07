import { NextRequest, NextResponse } from 'next/server';
import { getApplication } from '@/lib/applications';
import type { DemoApplication } from '@/lib/types';

// Server-side bridge to a Canton participant's Daml JSON Ledger API **v2**
// (Canton/Daml 3.x). Verified against a live 3.x sandbox — see docs/LOCALNET.md.
//
// Why this lives on the server, not in the browser:
//  - it avoids the browser↔participant CORS problem entirely — the client only
//    ever talks same-origin to /api/ledger.
//  - it keeps the ledger endpoint (and, on a real network, the access token)
//    out of client code. A local sandbox runs without authorization, so there is
//    no secret here; a DevNet/MainNet deployment would add a bearer token in
//    `jsonApi` and nothing else would change.
//
// Contracts and choices are defined in daml/Main.daml. Party slugs (alice, bob…)
// used by the UI are mapped to the real allocated Canton parties via
// LEDGER_PARTY_MAP, which scripts/localnet.sh writes after running daml/Init.daml.
//
// v2 differences from the old v1 bridge worth knowing:
//  - template ids use the **package-name** reference (`#canton-resilience:Main:Policy`).
//    The package-id format v1 required is deprecated as of Canton 3.4, so no
//    package id needs to be discovered or threaded through the environment.
//  - reads go through /v2/state/active-contracts and need an explicit ledger
//    offset (/v2/state/ledger-end). There is no server-side field filter, so the
//    application filter is applied in JS (see `forApp`).
//  - Int64 values are still encoded as JSON **strings** over the wire.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEDGER_URL = process.env.LEDGER_URL; // e.g. http://localhost:7575
// The package NAME from daml/daml.yaml, used for the `#name:Module:Template`
// reference. Unlike the package id it is stable across rebuilds.
const PKG_NAME = process.env.LEDGER_PACKAGE_NAME ?? 'canton-resilience';
// v2 requires a user-id on every command submission; a sandbox without
// authorization cannot default it from a token, so it is supplied explicitly.
const USER_ID = process.env.LEDGER_USER_ID ?? 'ledger-api-user';
const PARTY_MAP: Record<string, string> = safeJson(process.env.LEDGER_PARTY_MAP) ?? {};

const tid = (t: string) => `#${PKG_NAME}:Main:${t}`;

function safeJson(s: string | undefined): any {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
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

async function jsonApi(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${LEDGER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  // v2 reports failures in the body as { code, cause } with a 4xx status.
  if (!res.ok || parsed?.code) {
    throw new Error(ledgerError(parsed) ?? `Ledger ${path} failed (${res.status})`);
  }
  return parsed;
}

// Turn a JSON Ledger API v2 error body into a human-readable, demo-safe message.
function ledgerError(body: any): string | undefined {
  const raw: string | undefined = body?.cause ?? body?.message;
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

// The current ledger end offset — the reading point for an active-contracts query.
async function ledgerEnd(): Promise<number> {
  const res = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, { cache: 'no-store' });
  const j = await res.json();
  return Number(j.offset);
}

interface Row {
  contractId: string;
  payload: any;
  // Ledger timestamp of the event that created the contract (v2 CreatedEvent).
  createdAt?: string;
}

// Active contracts of one template, as seen by `reader`. v2 has no server-side
// field filter, so callers narrow by payload field via `forApp`.
async function query(reader: string, template: string): Promise<Row[]> {
  const activeAtOffset = await ledgerEnd();
  const rows = await jsonApi('/v2/state/active-contracts', {
    activeAtOffset,
    eventFormat: {
      filtersByParty: {
        [reader]: {
          cumulative: [
            { identifierFilter: { TemplateFilter: { value: { templateId: tid(template) } } } },
          ],
        },
      },
      verbose: false,
    },
    verbose: false,
  });
  const out: Row[] = [];
  for (const r of (rows ?? []) as any[]) {
    const c = r?.contractEntry?.JsActiveContract?.createdEvent;
    if (c) out.push({ contractId: c.contractId, payload: c.createArgument, createdAt: c.createdAt });
  }
  return out;
}

async function forApp(reader: string, template: string, appName: string): Promise<Row | undefined> {
  const rows = await query(reader, template);
  return rows.find((r) => r.payload?.application === appName);
}

// The arguments of an exercise, wrapped in the v2 command envelope.
const exCmd = (template: string, contractId: string, choice: string, choiceArgument: unknown) => ({
  ExerciseCommand: { templateId: tid(template), contractId, choice, choiceArgument },
});

// Submit a command as `party` and wait for it to commit. Returns the resulting
// update id — the ledger's transaction identifier, surfaced to the UI.
async function submit(party: string, commands: unknown[]): Promise<{ updateId: string }> {
  const r = await jsonApi('/v2/commands/submit-and-wait', {
    commands,
    commandId: crypto.randomUUID(),
    actAs: [party],
    readAs: [party],
    userId: USER_ID,
  });
  return { updateId: r.updateId };
}

async function viewApp(app: DemoApplication) {
  const reader = qualify(app.parties[0].id);
  const [reqs, audits] = await Promise.all([
    forApp(reader, 'ActionRequest', app.name),
    query(reader, 'AuditRecord'),
  ]);
  const req = reqs?.payload;
  return {
    approvals: ((req?.approvals ?? []) as string[]).map(deQualify),
    executed: audits.some((a) => a.payload?.application === app.name),
  };
}

// Read the immutable AuditRecord contracts back from the ledger. Party fields
// are de-qualified to UI slugs. Approvals are recorded newest-first on-ledger
// (cons onto the head), so reverse to present them in approval order.
async function auditApp(app: DemoApplication) {
  const reader = qualify(app.parties[0].id);
  const rows = await query(reader, 'AuditRecord');
  return rows
    .filter((r) => r.payload?.application === app.name)
    .map(({ payload: p, createdAt }) => ({
      verb: p.verb,
      target: deQualify(p.target),
      detail: p.detail,
      reference: p.reference,
      approvals: ((p.approvals ?? []) as string[]).slice().reverse().map(deQualify),
      executor: deQualify(p.executor),
      // The JSON Ledger API encodes Int64 as a JSON *string*; convert back.
      onlineOperators: p.onlineOperators == null ? undefined : Number(p.onlineOperators),
      hostingThreshold: p.hostingThreshold == null ? undefined : Number(p.hostingThreshold),
      // The ledger timestamp the record was created at (from the CreatedEvent).
      timestamp: createdAt === undefined ? undefined : String(createdAt),
    }));
}

// Read the application's HostingGroup: which operators are down, whether the
// application is still available. Availability is a property of the ledger
// contract (Execute enforces the same computation), not of the UI.
async function hostingApp(app: DemoApplication) {
  const reader = qualify(app.parties[0].id);
  const group = await forApp(reader, 'HostingGroup', app.name);
  if (!group)
    throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh to initialize`);
  const offline = ((group.payload.offline ?? []) as string[]).map((p) => nodeIdOf(app, p));
  // Int64 arrives as a JSON string over the JSON Ledger API.
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
  const group = await forApp(node.slug, 'HostingGroup', app.name);
  if (!group)
    throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh to initialize`);
  await submit(nodeParty, [
    exCmd('HostingGroup', group.contractId, online ? 'ReportOnline' : 'ReportOffline', { node: nodeParty }),
  ]);
}

// Ensure a pending ActionRequest exists for the app; create one from the
// app's Policy via RequestAction if not. Idempotent — never resets state.
async function openRequest(app: DemoApplication) {
  const requester = qualify(app.parties[0].id);
  if (await forApp(requester, 'ActionRequest', app.name)) return;
  const policy = await forApp(requester, 'Policy', app.name);
  if (!policy)
    throw new Error(`No Policy on the ledger for "${app.name}" — run scripts/localnet.sh to initialize`);
  await submit(requester, [
    exCmd('Policy', policy.contractId, 'RequestAction', {
      requester,
      verb: app.action.verb,
      target: app.action.to ?? app.action.from ?? app.name,
      detail: app.action.detail,
      reference: app.action.reference,
    }),
  ]);
}

async function exerciseOnRequest(app: DemoApplication, actorSlug: string, choice: 'Approve' | 'Execute') {
  const actor = qualify(actorSlug);
  const req = await forApp(actor, 'ActionRequest', app.name);
  if (!req) throw new Error(`No open request for "${app.name}"`);
  // Execute must name the application's live HostingGroup; the choice checks
  // that it belongs to this application and that enough operators are online.
  let choiceArgument: Record<string, unknown>;
  if (choice === 'Approve') {
    choiceArgument = { approver: actor };
  } else {
    const group = await forApp(actor, 'HostingGroup', app.name);
    if (!group) throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh`);
    choiceArgument = { executor: actor, hostingGroup: group.contractId };
  }
  return submit(actor, [exCmd('ActionRequest', req.contractId, choice, choiceArgument)]);
}

// The exact command this route would submit, handed back to the caller instead.
// A connected Canton wallet uses this to sign and submit the action *itself* —
// the participant then authorizes it from the wallet's party rather than from a
// server that merely claims to be that party. The acting party is returned so
// the caller can check the wallet actually holds it before trying.
async function prepareFor(app: DemoApplication, action: string, partyId: string) {
  const actor = qualify(partyId);
  const req = await forApp(actor, 'ActionRequest', app.name);
  if (!req) throw new Error(`No open request for "${app.name}"`);
  if (action === 'approve')
    return { commands: [exCmd('ActionRequest', req.contractId, 'Approve', { approver: actor })], actAs: [actor] };
  if (action === 'execute') {
    const group = await forApp(actor, 'HostingGroup', app.name);
    if (!group) throw new Error(`No HostingGroup on the ledger for "${app.name}" — run scripts/localnet.sh`);
    return {
      commands: [
        exCmd('ActionRequest', req.contractId, 'Execute', { executor: actor, hostingGroup: group.contractId }),
      ],
      actAs: [actor],
    };
  }
  throw new Error(`Cannot prepare "${action}"`);
}

export async function POST(req: NextRequest) {
  if (!LEDGER_URL) {
    return NextResponse.json({ error: 'LEDGER_URL is not configured on the server' }, { status: 503 });
  }
  let body: { op?: string; appId?: string; partyId?: string; nodeId?: string; online?: boolean; action?: string };
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
      case 'execute': {
        const { updateId } = await exerciseOnRequest(app, body.partyId ?? app.parties[0].id, 'Execute');
        return NextResponse.json({ ok: true, updateId });
      }
      case 'view':
        return NextResponse.json({ ok: true, view: await viewApp(app) });
      case 'prepare': {
        const prep = await prepareFor(app, body.action ?? '', body.partyId ?? '');
        return NextResponse.json({ ok: true, ...prep });
      }
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
