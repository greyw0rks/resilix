# LocalNet

Run the full Canton Resilience threshold workflow against a real Canton ledger
on your machine. This replaces the built-in in-memory ledger with live Daml
contracts: approvals, operator status reports and executions change on-ledger
contract state and survive a browser refresh.

> **SDK note.** This project targets the **Daml 3.x / Canton 3.x** SDK. The 3.x
> sandbox serves the **Daml JSON Ledger API v2** itself, so there is no separate
> `daml json-api` process (that command was removed in 3.x) and — on a local
> sandbox — no authorization and therefore no token to mint. Snapshot builds of
> the 3.x SDK are published as public releases on `digital-asset/daml`, so the
> toolchain installs without any commercial access. Two consequences worth
> knowing: a DAR built with a 2.x SDK cannot be hosted by a 3.x participant (the
> Daml-LF language version is not in range), which is why `daml/daml.yaml` pins a
> 3.x `sdk-version`; and the app talks to the ledger only through
> `app/api/ledger/route.ts`, so the browser never holds a token and there is no
> CORS to configure.

## 1. One-time toolchain install

Requires a JDK 11+ and the Daml SDK.

```bash
# JDK (Amazon Corretto 17, no root needed) — skip if you already have Java 11+
mkdir -p ~/.local/jdk
curl -sL https://corretto.aws/downloads/latest/amazon-corretto-17-x64-linux-jdk.tar.gz \
  | tar -xz -C ~/.local/jdk
export JAVA_HOME="$(ls -d ~/.local/jdk/*/ | head -1)"
export PATH="$JAVA_HOME/bin:$PATH"
java -version   # expect 17.x

# Daml SDK 3.x (installs to ~/.daml). The version must match `sdk-version` in
# daml/daml.yaml, otherwise `daml build` and the sandbox disagree about Daml-LF.
curl -sSL https://get.daml.com | sh -s 3.5.0-snapshot.20260403.0
export PATH="$HOME/.daml/bin:$PATH"
daml version    # expect 3.5.0-snapshot.20260403.0
```

Add the two `export PATH=...` lines to your shell profile so new shells find
`java` and `daml`.

## 2. Bring up the ledger

From the repo root:

```bash
npm run ledger:up
```

This runs `scripts/localnet.sh`, which:

1. `daml build` → `daml/.daml/dist/canton-resilience-0.1.0.dar`
2. starts a Canton sandbox on `localhost:6865`, hosting the DAR and serving the
   **JSON Ledger API v2** on `localhost:7575`,
3. waits for `/livez` **and then** for the participant to actually join its
   synchronizer (`/v2/state/connected-synchronizers`) — `/livez` alone only proves
   the HTTP server is listening, and party allocation still fails until the
   participant is connected,
4. runs `daml/Init.daml` (`Init:initialize`) to allocate the parties — the five
   policy members (Alice/Bob/Carol/Dave/Erin), the control-plane Operator, and the
   five hosting-operator parties (OperatorAlpha…OperatorEpsilon) — and creates one
   `HostingGroup` and one `Policy` per reference application,
5. writes `.env.local` with `NEXT_PUBLIC_LEDGER_MODE=json-api`, `LEDGER_URL`,
   `LEDGER_PACKAGE_NAME`, `LEDGER_USER_ID` and `LEDGER_PARTY_MAP` (UI slug →
   allocated Canton party).

The sandbox's own output goes to `.localnet-sandbox.log` (it outlives the script,
so it does not hold the script's stdout open). Stop everything with
`npm run ledger:stop`; free ports are 6865 (gRPC) and 7575 (JSON API v2).

> **Verified 2026-10-07** against Daml SDK 3.5.0-snapshot.20260403.0 (JDK 17,
> Corretto): `daml build` + `daml test` green, `npm run ledger:up` clean, and
> `npm run verify:ledger` → **18 on-ledger checks** passing, including the ledger
> itself rejecting an under-threshold execute, a double approval, a non-member
> action, a peer operator reporting someone else's node down, and an execute while
> the application is below its hosting threshold.

## 3. Run the app against the ledger

```bash
npm run dev      # http://localhost:3000
```

The header status now reads **json-api**. Every approval, operator status report
and execution is a real `ActionRequest.Approve` / `HostingGroup.ReportOffline` /
`ActionRequest.Execute` choice on the ledger.

## 4. Verify the workflow

Automated — the whole control layer, asserted against the live ledger:

```bash
npm run verify:ledger
```

By hand, in the UI:

1. Approve as **Alice** → progress shows **1 / 2**, execution stays blocked.
2. Approve as **Bob** → **2 / 2**, execution unlocks.
3. Take **Node A** offline → the operator reports itself down on-ledger; the panel
   shows 2 / 3 and the application stays available.
4. Take **Node B** offline too → 1 / 3, below the threshold. **Execute is now
   refused by the ledger**, not by the console.
5. Bring **Node B** back → execution is permitted again.
6. **Execute** → creates an `AuditRecord` contract on the ledger carrying the
   approvals, the executor, the online/required operator counts, and the ledger
   timestamp.
7. **Hard-refresh the browser** → approvals, hosting state and the audit trail all
   reload from the ledger, proving none of it is local UI state.
8. Negative checks (surface as readable errors, not `Error: undefined`):
   approving as a non-member, approving twice, and reporting a peer's node offline
   are all rejected by the ledger.

## 5. Run the Daml acceptance tests

```bash
cd daml && daml test
```

Covers: 2-of-3 executes; 1-of-3 cannot; non-member cannot approve/request; no
double approval; no double execution; an operator reports its own node offline; a
non-node cannot; no double-offline report; **execute blocked below the hosting
threshold and permitted again after a node reports back online**; invalid
threshold rejected; empty/duplicate member list rejected; policy owner cannot
bypass the threshold. See `daml/Test.daml`.

## Troubleshooting

- **`daml: command not found`** — re-run the `export PATH="$HOME/.daml/bin:$PATH"` line.
- **`PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER`** — the Init script ran
  before the sandbox's participant joined its synchronizer. `scripts/localnet.sh`
  gates on `/v2/state/connected-synchronizers` for exactly this reason; if you see
  it, the gate was skipped (`daml script` run by hand immediately after `daml
  sandbox`). Wait for the synchronizer to appear at
  `http://localhost:7575/v2/state/connected-synchronizers` and retry.
- **`The submitted request is missing a user-id`** — JSON Ledger API v2 requires
  an explicit `userId` on every command submission; a sandbox without authorization
  cannot default it from a token. It comes from `LEDGER_USER_ID` in `.env.local`.
- **`Cannot resolve template id`** — v2 template ids are written
  `#<package-name>:<Module>:<Template>`. `LEDGER_PACKAGE_NAME` in `.env.local` must
  match `name` in `daml/daml.yaml` (it is *not* the package id).
- **DAR rejected on upload: language version** — the DAR was built with a 2.x SDK
  and the participant is 3.x (or vice versa). `sdk-version` in `daml/daml.yaml` must
  match the installed SDK.
- **`No Policy on the ledger for "…"`** — the Init script didn't run; re-run
  `npm run ledger:up`.
- **Ports busy** — stop a previous run with `npm run ledger:stop` (frees 6865/7575).
