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

## Verified end-to-end (Daml SDK 2.10.6)

- `daml build` + `daml test` — every acceptance case green (`daml/Test.daml`), including the
  hosting cases: an operator reporting itself down, a non-operator being unable to report, and
  **execution refused while under-hosted** then permitted again after recovery.
- `npm run ledger:up` — sandbox + HTTP JSON API v1, parties allocated (members *and* hosting
  operators), one `HostingGroup` and one `Policy` per reference app, `.env.local` written.
- `npm run verify:ledger` — drives the whole flow through the same JSON API v1 calls that
  `app/api/ledger/route.ts` makes: request → approve → approve → **two operators report down →
  execute rejected on-ledger ("Hosting below threshold") → operator reports back online →
  execute → `AuditRecord`**, with under-threshold execute, double-approve, double-offline and
  non-member actions all rejected **on-ledger** and shown as readable messages. See
  `docs/LOCALNET.md`.

## Reusable, not treasury-specific

One generic contract set (`verb` + `target` + `detail`) protects four reference
applications — Treasury (2/3), Token Administration (3/4), Trading Administration
(2/3), Protocol Governance (3/5) — defined in `lib/applications.ts`. Switching
apps in the console switches the on-ledger `Policy` it drives.

## Honest seams (intentionally not faked)

These require infrastructure that is not publicly installable; they are wired as
clean seams rather than mocked as "done":

- **Grofty signing** — `lib/wallet.ts` defines the `WalletAdapter` seam. There is
  no public Grofty SDK; a real adapter would wrap it (or the published
  `@canton-network/wallet-sdk`). The demo uses `DemoWallet` (`real = false`), and
  the ledger command is authorized server-side by the acting party's dev token.
- **BitSafe Decentralization Manager / real multi-operator deployment** — the
  `HostingGroup` contract models the *status* of the operator set (who hosts the
  app, how many must be online, who is down) and `Execute` enforces the threshold
  on-ledger. What runs *below* it — the Decentralized Party and the actual
  distributed participant set — is the Decentralization Manager's job and is not
  reimplemented here. Against a single LocalNet participant the operator parties
  are real allocated parties reporting real status, but they are not separate
  nodes; the real topology is a DevNet/MainNet deployment concern
  (`docs/ARCHITECTURE.md`).

## Run it

```bash
# one-time toolchain — see docs/LOCALNET.md §1 (JDK + Daml 2.10.6)
npm install
npm run ledger:up   # live Canton ledger + .env.local
npm run dev         # http://localhost:3000, header shows "json-api"
```

Without `.env.local` the app runs the built-in in-memory ledger, which mirrors
the exact Daml guards — useful for a zero-dependency demo.
