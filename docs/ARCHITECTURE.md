# Architecture

```text
Grofty Wallet
     |  sign / transact
     v
Resilix (this project)
     |  +-- Policy Engine      : who may act, how many must approve
     |  +-- Approval Workflow  : per-party approvals, quorum
     |  +-- Hosting Registry   : operator parties, self-reported node status
     |  +-- Audit Engine       : ordered, traceable record of every decision
     v
Daml Application Contracts
     |  Policy / ActionRequest (+ Approve/Execute choices) / AuditRecord
     |  HostingGroup (+ ReportOffline/ReportOnline)
     v
BitSafe Decentralization Manager
     |  +-- Decentralized Party
     |  +-- Operator A / B / C (...)  ← the real node topology lives here
     v
Canton Network (settlement · privacy)
```

## Where the wallet sits

The browser side of the top arrow is `lib/wallet.ts`, an adapter over the **Canton dApp SDK**
(`@canton-network/dapp-sdk`, CIP-0103) — the interface a Canton wallet like Grofty implements:

```
connect()              →  discovers the wallet, restores an approved session, connects
listAccounts()         →  the Canton party the wallet actually holds
prepare (server route) →  the command the route would have submitted, returned unsubmitted
prepareExecuteAndWait  →  the wallet signs and submits that command itself
```

The console takes the wallet path only when the party the command must be authorized by is the
one the wallet holds, so the approval and the execution carry the user's own authority instead of
the server's claim to it. A wallet signs against the network its own validator is on, which a
LocalNet sandbox is not — there the check is false and the server route submits, and a browser
with no Canton wallet at all can opt into an explicitly-labelled demo signer.

## Reusable, not treasury-specific

The control layer is application-agnostic. Every protected application is the same shape —
parties, an approval threshold, a set of hosting operators, and one generic privileged action
(`verb` + `target` + `detail`). Treasury, token administration, trading administration and
protocol governance are all instances of that shape, defined in `lib/applications.ts`.

## Code ↔ contract mapping

`lib/engine.ts` keeps the policy/hosting/audit logic as pure functions; in live mode the same
facts are read from, and enforced by, the Daml choices in `daml/Main.daml`:

| UI concept (`lib/engine.ts`) | Daml equivalent (`daml/Main.daml`)          |
| ---------------------------- | ------------------------------------------- |
| `approvalsMet`               | `Execute` guard: `length approvals >= threshold` |
| approval toggle              | `ActionRequest.Approve`                     |
| execute action               | `ActionRequest.Execute` → `AuditRecord`     |
| audit trail                  | `AuditRecord` contract (incl. hosting quorum at execution) |
| `isAvailable` / `onlineCount`| `HostingGroup.offline`, enforced by `Execute` |
| operator online/offline      | `HostingGroup.ReportOffline` / `ReportOnline` |

## Hosting is on-ledger, the node topology is not

`HostingGroup` records which operator parties host an application, the minimum number that must
stay online, and which are currently down. Each operator reports **its own** status
(`ReportOffline` / `ReportOnline`, controller = that node), so no admin asserts on a node's
behalf. `ActionRequest.Execute` fetches the group and refuses to run below threshold — the
availability gate is enforced by the ledger, not the console.

What `HostingGroup` deliberately does **not** do is run a real multi-participant deployment.
The Decentralized Party and the actual distributed node set are BitSafe's Decentralization
Manager's job; this contract models the *status* of those operators, and the seam is documented
rather than faked.

## Design rule

Resilix does not recreate the Decentralization Manager. It owns application policy and
workflow. The Decentralization Manager owns the decentralized-party / operator infrastructure.

## Failure test

The demo must prove two independent properties:

- **Shared control** — a protected action does not execute until the configured approval
  threshold is reached.
- **Distributed hosting** — taking one configured hosting operator offline does not make the
  application unavailable while the hosting threshold still permits operation, and dropping
  below the threshold *does* block execution.

These are independent: approvals govern *whether* an action is authorized; hosting governs
*whether the application is reachable to execute it*. The audit trail records both, and the
`AuditRecord` captures the online-operator count at the moment of execution.
