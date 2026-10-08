# Canton Resilience — Submission

**One sentence.** A reusable *decentralized control layer* for Canton
applications — policy, approval, resilience and audit — proven on a live ledger
with an institutional treasury as the reference app.

## What it proves

A critical Canton application action requires **shared authorization** (a k-of-n
approval quorum enforced on-ledger) and stays **operational when a hosting
operator goes offline** (distributed hosting), with every decision captured in an
immutable **audit** trail.

## The four pillars and where each lives

| Pillar | Where it is enforced | Status |
| --- | --- | --- |
| **Policy** | `Policy` template — members, threshold, well-formedness `ensure` | ✅ on-ledger |
| **Approval** | `ActionRequest.Approve` / `Execute`, `length approvals >= threshold` | ✅ on-ledger |
| **Audit** | `AuditRecord` template; UI reads it back via `/api/ledger` `audit` | ✅ on-ledger |
| **Resilience (hosting)** | `HostingGroup` + `ReportOffline`/`ReportOnline`; `Execute` fetches the group and refuses below the hosting threshold | ✅ on-ledger |

All four pillars are enforced by the Daml choices, not the console. Operator status in
particular is not UI state: each hosting operator reports its own node through a choice it
uniquely controls, and an application below its hosting threshold **cannot execute** — the gate
is in `ActionRequest.Execute`, so a console that lied about availability would change nothing.

## Verified end-to-end (Daml SDK 3.5.0-snapshot)

- `daml build` + `daml test` — every acceptance case green (`daml/Test.daml`), including the
  hosting cases: an operator reporting itself down, a non-operator being unable to report, and
  **execution refused while under-hosted** then permitted again after recovery.
- `npm run ledger:up` — a Canton 3.x sandbox serving the **JSON Ledger API v2**, parties
  allocated (members *and* hosting operators), one `HostingGroup` and one `Policy` per reference
  app, `.env.local` written.
- `npm run verify:ledger` — **18 on-ledger checks**, driving the whole flow through the same
  JSON Ledger API v2 calls that `app/api/ledger/route.ts` makes: request → approve → approve →
  **two operators report down → execute rejected on-ledger ("Hosting below threshold") →
  operator reports back online → execute → `AuditRecord`**, with under-threshold execute,
  double-approve, double-offline, a peer operator reporting someone else's node, and non-member
  actions all rejected **on-ledger** and shown as readable messages. See `docs/LOCALNET.md`.
- CI reproduces it: `.github/workflows/ci.yml` has a `ledger` job that runs `npm run
  ledger:up && npm run verify:ledger` on a clean runner — the setup path is one command, not a
  tribal-knowledge ritual.

## Reusable, not treasury-specific

One generic contract set (`verb` + `target` + `detail`) protects four reference
applications — Treasury (2/3), Token Administration (3/4), Trading Administration
(2/3), Protocol Governance (3/5) — defined in `lib/applications.ts`. Switching
apps in the console switches the on-ledger `Policy` it drives.

## The wallet is in the flow, not next to it

`lib/wallet.ts` is an adapter over the browser-side **Canton dApp SDK**
(`@canton-network/dapp-sdk`, CIP-0103) — the standard a Canton wallet such as
**Grofty** implements. It discovers an installed wallet, silently restores an
already-approved session, connects on request, reads the Canton party the wallet
holds, and hands the wallet a command to **sign and submit itself**
(`prepareExecuteAndWait`).

What makes that more than a connect button is `prepare`: `app/api/ledger/route.ts`
can return the *exact command it would otherwise submit*, together with the party
that command must be authorized by — without submitting it. The console then gives
that command to the wallet whenever the connected party is the one holding the
authority (`components/Console.tsx`, `submitViaWallet`). So the approval and the
execution are authorized by the user's own party on the ledger, not by a server
asserting it is that party. The connection state is the SDK's, not a local boolean:
a rejected connection, an expired session and a missing wallet are distinguished
and reported to the user as such.

**The one honest constraint.** A Canton wallet signs against the network *its own
validator* is on. A LocalNet sandbox is not that network, so during the local demo
no installed wallet can submit to it — the authority check above is false and the
server route submits instead, exactly as before. Point the app at a network the
wallet is on and the wallet path takes over with no code change. Where a browser has
no Canton wallet installed at all, the console offers an explicitly-labelled demo
signer (`real = false`, a visible banner, no signature produced) so the demo stays
runnable; nothing about it can be mistaken for real signing.

## Deliberately not here: a treasury balance

The console shows no account balance, and there is no balance anywhere in the
contracts. That is a boundary, not an omission: this layer governs *who may act
and whether the application is reachable to act*, not custody. The reference
treasury action — "Send 50,000 CC" — is a **request the policy authorizes**, not a
transfer out of an escrowed balance, so there is no quantity to hold or display.
Adding custody would mean a second product (a vault) that this control layer would
then protect, which is exactly the post-MVP shape the boundary excludes.

## Honest seams (intentionally not faked)

- **BitSafe Decentralization Manager / real multi-operator deployment** — the
  `HostingGroup` contract models the *status* of the operator set (who hosts the
  app, how many must be online, who is down) and `Execute` enforces the threshold
  on-ledger. What runs *below* it — the Decentralized Party and the actual
  distributed participant set — is the Decentralization Manager's job and is not
  reimplemented here. Against a single LocalNet participant the operator parties
  are real allocated parties reporting real status, but they are not separate
  nodes; the real topology is a DevNet/MainNet deployment concern
  (`docs/ARCHITECTURE.md`).

### On authorization

Because a local sandbox runs without authorization, **no token is minted anywhere**
— not by the browser, not by the server route. Commands name the party they act
as (`actAs`), and the party's *right to perform the action* comes entirely from
the Daml `controller` clauses: `Execute` is controlled by a policy member,
`ReportOffline` by the operator that owns the node. A client that lied about who
it was could not widen its own authority — which is exactly the property the
control layer exists to provide.

## Run it

```bash
# one-time toolchain — see docs/LOCALNET.md §1 (JDK + Daml 3.x SDK)
npm install
npm run ledger:up   # live Canton ledger + .env.local
npm run dev         # http://localhost:3000, header shows "json-api"
```

Without `.env.local` the app runs the built-in in-memory ledger, which mirrors
the exact Daml guards — useful for a zero-dependency demo.

## The rest of the submission

| Document | What it is |
| --- | --- |
| [`PITCH.md`](PITCH.md) | The one-page argument: the question, the answer, the three claims and their evidence |
| [`JOURNAL.md`](JOURNAL.md) | The build log — decisions, the things that turned out to be wrong, and what settled them |
| [`VIDEO.md`](VIDEO.md) | The demo video: shot list, narration, and `npm run demo:video` for the automated screencast |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Where each piece sits, and the code ↔ contract mapping |
| [`LOCALNET.md`](LOCALNET.md) | Reproducible bring-up: toolchain, run, verify, troubleshooting |
