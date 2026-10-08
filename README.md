# Canton Resilience

Decentralized control infrastructure for Canton applications.

Canton Resilience is a **reusable control layer** for Canton apps. Instead of shipping one
treasury product, it lets any application define who can act, how many parties must approve,
which operators host the Decentralized Party, what happens when an operator disappears, and how
every decision is audited. The treasury is the reference implementation, not the product.

The core question it answers: **what happens when the people or infrastructure responsible for a
Canton application become unavailable?**

## Four primitives

- **Policy** — define approval thresholds per application.
- **Governance** — multiple parties must approve a privileged action (shared control).
- **Resilience** — hosting operators report their own node status on-ledger, and an application
  below its hosting threshold cannot execute (distributed hosting, enforced by the contract).
- **Audit** — every request, approval, hosting change and execution is traceable.

## Switchable reference applications

The same decentralization layer protects different actions. The demo switches between:

| Application            | Privileged action              | Quorum |
| ---------------------- | ------------------------------ | ------ |
| Treasury               | Send 50,000 CC                 | 2 / 3  |
| Token Administration   | Mint 1,000,000 units           | 3 / 4  |
| Trading Administration | Change fee 10 bps → 25 bps     | 2 / 3  |
| Protocol Governance    | Pause application              | 3 / 5  |

## Architecture

```
Grofty                → user interaction, wallet, signing
Canton Resilience     → policy · approval · hosting · audit engines   (this project)
Decentralization Mgr  → Decentralized Party · operators               (BitSafe)
Canton Network        → settlement · privacy
```

Canton Resilience owns application policy and workflow. It models the *status* of the hosting
operator set on-ledger (who hosts an application, how many must be online, who is down) and
enforces the availability gate in `Execute`. The Decentralized Party and the real distributed
node topology are the Decentralization Manager's; this project does **not** reimplement them.

## Project layout

```
app/            Next.js app router — layout (fonts), page, Tailwind globals
components/     Console (state + ledger), Hero, ApplicationSwitcher, SharedControl,
                DistributedHosting, AuditTrail, Architecture, icons, ui (primitives)
lib/            types.ts (domain), applications.ts (the four apps),
                engine.ts (pure policy/hosting/audit), ledger.ts (ledger client),
                wallet.ts (wallet adapter over the Canton dApp SDK)
daml/           daml.yaml + reusable Policy / ActionRequest / AuditRecord contracts
                and HostingGroup (operator status), Test.daml (acceptance tests),
                Init.daml (LocalNet bootstrap)
app/api/ledger/ server route that bridges the browser to the Daml JSON Ledger API v2
scripts/        localnet.sh — one-command LocalNet bring-up
docs/           ARCHITECTURE.md, LOCALNET.md, SUBMISSION.md, PITCH.md,
                JOURNAL.md (build log), VIDEO.md (demo script)
```

The UI is built with **Tailwind CSS v4** (CSS-first config in `app/globals.css`, no
`tailwind.config.js`). It talks to the ledger only through `lib/ledger.ts`:

- **`InMemoryLedger`** (default) reproduces the exact guards of the Daml choices, so the demo
  runs with no external dependency.
- **`HttpLedger`** proxies the same operations through the same-origin server route
  `app/api/ledger/route.ts`, which submits real Daml commands to a Canton participant over the
  **Daml JSON Ledger API v2** (Canton 3.x). The browser holds no token and there is no CORS to
  configure. Activate it by running against LocalNet (`npm run ledger:up`), which sets
  `NEXT_PUBLIC_LEDGER_MODE`.

`lib/engine.ts` mirrors the Daml choices in `daml/Main.daml`, so the same policy/hosting/audit
logic maps onto a real ledger. In live mode the audit trail is **read back from the on-ledger
`AuditRecord` contracts** (via the `audit` op) and the hosting panel is **read back from the
application's `HostingGroup`** (via the `hosting` op) — neither is reconstructed in the UI. See
**[docs/SUBMISSION.md](docs/SUBMISSION.md)** for what is on-ledger vs. an intentional seam.

## Daml package + LocalNet

The threshold workflow runs on a real Canton ledger — see **[docs/LOCALNET.md](docs/LOCALNET.md)**
for the one-time toolchain install and details. In short:

```bash
cd daml && daml build && daml test   # compile contracts + run acceptance tests
npm run ledger:up                     # sandbox + JSON Ledger API v2 + parties + policies, writes .env.local
npm run verify:ledger                 # drive request→approve→execute on the live ledger, assert invariants
npm run dev                           # http://localhost:3000, now backed by the ledger
```

> Targets the **Daml 3.x / Canton 3.x** SDK, whose sandbox serves the **Daml JSON Ledger API
> v2** itself (the 2.x `daml json-api` process no longer exists, and a 2.x-built DAR cannot be
> hosted by a 3.x participant).

## Run the UI

```bash
npm install
npm run dev      # http://localhost:3000 (in-memory ledger by default)
npm run build    # production build + typecheck
```

A narrated, hands-free walkthrough of a single protected action moving through all four
pillars is at **`/demo`** (runs on the in-memory model, so it always plays).

A recorded screencast of the console driving the live ledger is produced by
`npm run demo:video` (needs the ledger up and the app on `:3200`) — captioned and
narrated, with the voice-over generated from the captions themselves. The shot
list and the alternatives are in **[docs/VIDEO.md](docs/VIDEO.md)**.

The reasoning behind the design, and the things that turned out to be wrong, are in
**[docs/JOURNAL.md](docs/JOURNAL.md)**; the one-page argument is
**[docs/PITCH.md](docs/PITCH.md)**.

## Demo flow (≈90s)

1. Pick a reference application. Every privileged action sits behind the same layer.
2. Approve as parties until the quorum is met (shared control).
3. Take a hosting operator offline — it reports itself down on-ledger, and the application
   stays available while the hosting threshold still permits operation. Drop below the
   threshold and Execute is refused *by the ledger*, not by the console.
4. Connect a Canton wallet (Grofty). The console reads the party it holds and routes the
   approval and the execution through the wallet to sign — whenever the wallet is on a network
   the app is pointed at. See *The wallet* below.
5. Read the audit trail: request → approvals → hosting change → execution.

## The wallet

`lib/wallet.ts` adapts the browser-side **Canton dApp SDK** (`@canton-network/dapp-sdk`,
CIP-0103) — the standard a wallet like Grofty implements — so the privileged action is
authorized by the user's own Canton party rather than by a server claiming to be it:

```
connect()  →  listAccounts()  →  the Canton party the wallet holds
prepare    →  the exact command the server route would have submitted, unsubmitted
submit     →  prepareExecuteAndWait(): the wallet signs and submits it
```

The console only takes the wallet path when the party the command must be authorized by is the
party the wallet actually holds; otherwise the server route runs as before. A browser with no
Canton wallet installed can opt into an explicitly-labelled demo signer (`real = false`, banner
shown, no signature produced) so the demo stays runnable.

One honest constraint: a Canton wallet signs against the network **its own validator** is on, so
against a LocalNet sandbox no installed wallet can submit to it — that is the authority check
being false, and the server route submitting instead, not a broken integration.

## Integration status

| Layer | State |
| ----- | ----- |
| Daml package + LocalNet | ✅ built, deployed to a live sandbox, acceptance tests green |
| Console reads/submits | ✅ every approval, hosting report and execution is a real Daml command |
| Shared-control + node-failure demonstrations | ✅ reproduced on LocalNet by `npm run verify:ledger` |
| Grofty wallet | ✅ adapter over the Canton dApp SDK — connect, read the party, sign and submit through the wallet (`prepareExecuteAndWait`); needs a network the wallet is on |
| Decentralization Manager (Decentralized Party, real node topology) | 🔌 BitSafe infrastructure, not self-serve |

**For Gold:** move the working application onto DevNet/MainNet and complete the BitSafe
Decentralized Party deployment, which is what turns the hosting layer from a modelled operator
set into a genuinely distributed one.
