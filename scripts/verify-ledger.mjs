#!/usr/bin/env node
// Canton Resilience — automated end-to-end proof of the on-ledger control
// layer. Drives the SAME Daml HTTP JSON API v1 calls that
// app/api/ledger/route.ts makes, against a live LocalNet sandbox, and asserts
// the control-layer invariants hold ON THE LEDGER (not in the UI):
//
//   • a request under threshold cannot execute
//   • a non-member cannot approve
//   • the same party cannot approve twice
//   • once the quorum is met, Execute emits an immutable AuditRecord
//   • the executed state survives re-reading the ledger (persistence)
//   • RESILIENCE: an application below its hosting threshold cannot execute,
//     and becomes executable again once an operator reports back online
//
// Prereq: `npm run ledger:up` has written .env.local and the sandbox + JSON API
// are running. Run with: `npm run verify:ledger`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, '.env.local'), 'utf8');
  } catch {
    fail('No .env.local — run `npm run ledger:up` first.');
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const LEDGER_URL = env.LEDGER_URL;
const LEDGER_ID = env.LEDGER_ID ?? 'sandbox';
const PKG = env.LEDGER_PACKAGE_ID;
const PARTY_MAP = JSON.parse(env.LEDGER_PARTY_MAP ?? '{}');

if (!LEDGER_URL || !PKG || Object.keys(PARTY_MAP).length === 0) {
  fail('.env.local is missing LEDGER_URL / LEDGER_PACKAGE_ID / LEDGER_PARTY_MAP — re-run `npm run ledger:up`.');
}

const tid = (t) => `${PKG}:Main:${t}`;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const qualify = (slug) => {
  const p = PARTY_MAP[slug];
  if (!p) fail(`No allocated party for "${slug}"`);
  return p;
};
const deQualify = (party) =>
  Object.entries(PARTY_MAP).find(([, p]) => p === party)?.[0] ?? party;

function mintToken(party) {
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    'https://daml.com/ledger-api': {
      ledgerId: LEDGER_ID,
      applicationId: 'canton-resilience',
      actAs: [party],
      readAs: [party],
    },
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

async function api(party, path, body) {
  const res = await fetch(`${LEDGER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mintToken(party)}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!res.ok || parsed?.status >= 400) {
    const msg = Array.isArray(parsed?.errors) ? parsed.errors.join('; ') : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.ledger = true;
    throw err;
  }
  return parsed;
}

const query = async (readerSlug, template, q) =>
  (await api(qualify(readerSlug), '/v1/query', { templateIds: [template], query: q }))?.result ?? [];
const exercise = (actorSlug, templateId, contractId, choice, argument) =>
  api(qualify(actorSlug), '/v1/exercise', { templateId, contractId, choice, argument });

// --- tiny assertion harness ------------------------------------------------
let passed = 0;
function fail(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }
function ok(msg) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
async function expectReject(label, fn, match) {
  try {
    await fn();
  } catch (e) {
    if (!e.ledger) throw e;
    if (match && !match.test(e.message)) fail(`${label}: rejected, but with the wrong message: "${e.message}"`);
    ok(`${label} — rejected on-ledger ("${e.message}")`);
    return;
  }
  fail(`${label}: expected the ledger to reject this, but it succeeded`);
}

// --- the application under test (Treasury, 2-of-3) -------------------------
const APP = {
  application: 'Treasury',
  verb: 'TRANSFER',
  target: 'vendor::party',
  detail: 'Outbound vendor payment from the institutional treasury.',
  reference: 'REQ-1042',
};
const MEMBERS = ['alice', 'bob', 'carol']; // threshold 2
const NON_MEMBER = 'dave'; // allocated, but not a Treasury policy member
const NODES = ['opalpha', 'opbeta', 'opgamma']; // hosting operators, threshold 2

const findReq = async (readerSlug) =>
  (await query(readerSlug, tid('ActionRequest'), { application: APP.application }))[0];
const findHosting = async (readerSlug) =>
  (await query(readerSlug, tid('HostingGroup'), { application: APP.application }))[0];

async function main() {
  console.log(`\nCanton Resilience — on-ledger verification (${LEDGER_URL})\n`);

  // 0. Policy must exist (ledger initialized).
  const policies = await query('alice', tid('Policy'), { application: APP.application });
  if (!policies[0]) fail(`No Policy for "${APP.application}" — run \`npm run ledger:up\`.`);
  ok(`Policy for "${APP.application}" is on the ledger (threshold ${policies[0].payload.threshold})`);

  // 1. Clean slate: withdraw any request left open by a previous run.
  const stale = await findReq('alice');
  if (stale) {
    await exercise('alice', tid('ActionRequest'), stale.contractId, 'Reject', { canceller: qualify('alice') });
    ok('withdrew a stale open request (Reject)');
  }

  // 1b. Clean slate for hosting: bring back any operator a previous run left down.
  //     Each report consumes the old contract and creates a new one, so the
  //     contract id is re-read after every change.
  let hg = await findHosting('alice');
  if (!hg) fail(`No HostingGroup for "${APP.application}" — run \`npm run ledger:up\`.`);
  for (const party of hg.payload.offline ?? []) {
    const slug = deQualify(party);
    const cur = await findHosting('alice');
    await exercise(slug, tid('HostingGroup'), cur.contractId, 'ReportOnline', { node: party });
    ok(`brought a stale offline operator back online (${slug})`);
  }
  hg = await findHosting('alice');

  // The JSON API v1 encodes Int64 as a JSON string, so numeric fields are
  // normalised with Number() before comparing.
  const nodeCount = (hg.payload.nodes ?? []).length;
  const hostingThreshold = Number(hg.payload.threshold);
  if (nodeCount !== NODES.length || hostingThreshold !== 2)
    fail(`HostingGroup expected ${NODES.length} nodes / threshold 2, got ${nodeCount} / ${hostingThreshold}`);
  if ((hg.payload.offline ?? []).length !== 0) fail('expected every operator to be online at the start');
  ok(`HostingGroup is on the ledger (${nodeCount} operators, threshold ${hostingThreshold}, all online)`);

  // 2. Open a fresh request as the requester (alice).
  await exercise('alice', tid('Policy'), policies[0].contractId, 'RequestAction', {
    requester: qualify('alice'),
    verb: APP.verb, target: APP.target, detail: APP.detail, reference: APP.reference,
  });
  ok(`opened a ${APP.verb} request (${APP.reference})`);

  const req0 = await findReq('alice');

  // 3. NEGATIVE: cannot execute under threshold (0 approvals).
  await expectReject('execute with 0/2 approvals',
    () => exercise('alice', tid('ActionRequest'), req0.contractId, 'Execute',
      { executor: qualify('alice'), hostingGroup: hg.contractId }),
    /threshold not met/i);

  // 4. NEGATIVE: a non-member cannot approve. On the ledger the ActionRequest's
  //    observers ARE the policy members (daml/Main.daml), so a true non-member
  //    cannot even see the contract — the ledger blocks them by invisibility
  //    (CONTRACT_NOT_FOUND) before the explicit member-check assertion is
  //    reachable. Either way the approval is impossible for a non-member.
  await expectReject(`approve as non-member (${NON_MEMBER})`,
    () => exercise(NON_MEMBER, tid('ActionRequest'), req0.contractId, 'Approve', { approver: qualify(NON_MEMBER) }),
    /not a policy member|not be found|not found/i);

  // 5. First approval (alice).
  await exercise('alice', tid('ActionRequest'), req0.contractId, 'Approve', { approver: qualify('alice') });
  ok('approved by alice (1/2)');
  const req1 = await findReq('alice');

  // 6. NEGATIVE: the same party cannot approve twice.
  await expectReject('approve twice as alice',
    () => exercise('alice', tid('ActionRequest'), req1.contractId, 'Approve', { approver: qualify('alice') }),
    /already approved/i);

  // 7. NEGATIVE: still under threshold (1/2).
  await expectReject('execute with 1/2 approvals',
    () => exercise('alice', tid('ActionRequest'), req1.contractId, 'Execute',
      { executor: qualify('alice'), hostingGroup: hg.contractId }),
    /threshold not met/i);

  // 8. Second approval (bob) → quorum met.
  await exercise('bob', tid('ActionRequest'), req1.contractId, 'Approve', { approver: qualify('bob') });
  ok('approved by bob (2/2 — quorum met)');
  const req2 = await findReq('alice');

  // --- Resilience: the availability gate is enforced on-ledger -------------

  // The live HostingGroup contract id — re-read every time, because each status
  // report consumes the current contract and creates a new one.
  const liveGroup = async () => (await findHosting('alice')).contractId;
  const readHosting = async () => {
    const g = (await findHosting('alice')).payload;
    return { online: nodeCount - (g.offline ?? []).length, threshold: Number(g.threshold) };
  };
  // A node reports its own status. The submitter IS the node, so the header of
  // this transaction names that operator — no admin acts on its behalf.
  const report = async (slug, choice) =>
    exercise(slug, tid('HostingGroup'), await liveGroup(), choice, { node: qualify(slug) });

  // 9a. Operator Alpha reports its own node down; the ledger accepts it.
  await report('opalpha', 'ReportOffline');
  ok('operator Alpha reported its node offline (on-ledger)');

  // 9b. NEGATIVE: an operator cannot report another operator's node — the
  //     choice is controlled by the node itself.
  await expectReject('report a peer node offline as another operator',
    async () => exercise('opalpha', tid('HostingGroup'), await liveGroup(), 'ReportOffline',
      { node: qualify('opbeta') }),
    /requires authorizers|not a hosting operator|not be found|not found/i);

  // 9c. NEGATIVE: the same node cannot report offline twice.
  await expectReject('report the same node offline twice',
    async () => exercise('opalpha', tid('HostingGroup'), await liveGroup(), 'ReportOffline',
      { node: qualify('opalpha') }),
    /already offline/i);

  // 9d. A second node goes down → 1 of 3 online, below the threshold of 2.
  await report('opbeta', 'ReportOffline');
  let h = await readHosting();
  if (h.online !== 1) fail(`expected 1/${nodeCount} operators online, ledger reports ${h.online}`);
  ok(`2 of ${nodeCount} operators down — now ${h.online}/${nodeCount} online (threshold ${h.threshold})`);

  // 9e. THE invariant: the approval quorum is met, but the application is
  //     under-hosted, so execution is refused by the ledger.
  await expectReject('execute while hosting is below threshold',
    async () => exercise('alice', tid('ActionRequest'), req2.contractId, 'Execute',
      { executor: qualify('alice'), hostingGroup: await liveGroup() }),
    /hosting below threshold/i);

  // 9f. An operator comes back → 2 online, execution is permitted again.
  await report('opbeta', 'ReportOnline');
  h = await readHosting();
  if (h.online !== 2) fail(`expected 2/${nodeCount} operators online after recovery, ledger reports ${h.online}`);
  ok(`operator Beta back online — ${h.online}/${nodeCount} online (threshold ${h.threshold})`);

  // 10. Execute → emits an immutable AuditRecord.
  await exercise('alice', tid('ActionRequest'), req2.contractId, 'Execute',
    { executor: qualify('alice'), hostingGroup: await liveGroup() });
  ok('executed by alice');

  // 11. The AuditRecord is on the ledger with the right content, including the
  //     hosting quorum captured at execution time.
  const audits = await query('alice', tid('AuditRecord'), { application: APP.application });
  const latest = audits.map((a) => a.payload).find((p) => p.reference === APP.reference);
  if (!latest) fail('no AuditRecord with the expected reference was found on the ledger');
  const approvers = (latest.approvals ?? []).map(deQualify).sort();
  if (latest.verb !== APP.verb) fail(`AuditRecord.verb was "${latest.verb}", expected "${APP.verb}"`);
  if (deQualify(latest.executor) !== 'alice') fail(`AuditRecord.executor was "${deQualify(latest.executor)}", expected "alice"`);
  if (approvers.length < 2 || !approvers.includes('alice') || !approvers.includes('bob'))
    fail(`AuditRecord.approvals were [${approvers}], expected to contain alice+bob`);
  if (Number(latest.onlineOperators) !== 2) fail(`AuditRecord.onlineOperators was ${latest.onlineOperators}, expected 2`);
  if (Number(latest.hostingThreshold) !== 2) fail(`AuditRecord.hostingThreshold was ${latest.hostingThreshold}, expected 2`);
  ok(`AuditRecord: ${latest.verb} ${APP.reference}, executor=alice, quorum=${approvers.length}/${MEMBERS.length} [${approvers}], hosting=${latest.onlineOperators}/${nodeCount}`);

  // 12. Persistence: the request is consumed; executed state is re-readable.
  const after = await findReq('alice');
  if (after) fail('the ActionRequest should have been consumed by Execute, but one is still open');
  ok('request consumed; executed state is recoverable by re-reading the ledger');

  console.log(`\n\x1b[32mPASS\x1b[0m — ${passed} on-ledger checks held.\n`);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
