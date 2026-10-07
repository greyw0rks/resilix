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

## Honest seams (intentionally not faked)

These require infrastructure that is not publicly installable; they are wired as
clean seams rather than mocked as "done":

- **Grofty signing** — `lib/wallet.ts` defines the `WalletAdapter` seam. There is
  no public Grofty SDK; the real adapter is the browser-side **Canton dApp SDK**
  (`@canton-network/dapp-sdk`, CIP-0103: `connect()` → `listAccounts()` →
  `prepareExecuteAndWait`), which needs a wallet extension installed and a
  reachable validator. The demo uses `DemoWallet` (`real = false`).
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
