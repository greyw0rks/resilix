# Build journal — Canton Resilience

A record of what was built, in what order, and — more usefully — what was
**wrong** along the way and what settled it. Dates are when the work landed.

---

## 2026-09-26 — P0: the threshold workflow on a real ledger

**The framing decision.** The crowded Canton tracks are RWA and investment. Rather
than compete there, this project wraps the split BitSafe itself draws: *shared
control* (who may act) versus *distributed hosting* (what stays up when a node
does not). The product is the **control layer**; the institutional treasury is only
the reference app that shows it working.

**What landed.** `daml/Main.daml` — `Policy`, `ActionRequest` (`Approve` /
`Execute`), `AuditRecord`. One generic contract set (`verb` + `target` + `detail`)
so a single layer protects four different applications. A Next.js console with an
in-memory ledger that mirrors the Daml guards exactly, and `app/api/ledger/route.ts`
as the server-side bridge so the browser never holds a ledger token and there is no
CORS to configure.

**First real gotcha.** Template ids resolved only by concrete package id on JSON API
v1 — the `#package-name` shorthand is a 3.x feature — so the route had to read
`LEDGER_PACKAGE_ID` out of the DAR and thread it through the environment.

**Repo state.** Git-init'd locally, one commit, not pushed.

---

## 2026-09-29 — the live path, and the first thing that was actually wrong

**Drove the whole flow against a live sandbox.** request → approve → approve →
execute, with under-threshold execute, double-approve and non-member actions all
rejected **on-ledger** with readable messages. Two JSON API v1 gotchas fell out:
the auth token must carry `ledgerId` (or `401 ledgerId missing`), and — a real design
smell — a non-member cannot even *see* an `ActionRequest`, because observers equal
members. A non-member's approval therefore fails as `CONTRACT_NOT_FOUND`, not as
"not a policy member". That is the ledger being stricter than the assertion, and it
became a fact the test suite encodes rather than papers over.

**The audit pillar went on-ledger.** `AuditRecord` was being reconstructed in the
UI; it is now read back from the contracts.

**Honest seam, first version.** Grofty was a `WalletAdapter` interface with a
`real = false` demo implementation. Named a seam rather than faked, and documented
as one. (This turns out to have been the wrong conclusion — see 2026-10-07.)

---

## 2026-10-01 — proof, not demonstration

**`npm run verify:ledger`.** A standalone Node script that drives the same JSON API
calls as the route and *asserts the invariants* — 11/11 green on a live LocalNet. A
demo that works when you click it is a demonstration; one that fails a build when it
stops working is a proof. This distinction drove the rest of the project.

**`/demo`.** A narrated, auto-advancing walkthrough of one action through all four
pillars, on the in-memory model so it always plays.

**CI.** `daml build && daml test` plus a Next typecheck and build, on every push.
The repo went public.

---

## 2026-10-07 — the resilience pillar was decorative

**The problem.** Three of four pillars were enforced by Daml choices. Resilience was
not: operator status lived in React state and availability was computed in the
browser. Anyone could flip an operator offline in devtools and the console would
report the application degraded while nothing on the ledger changed — and, worse, an
action could still execute while the application was supposedly unavailable. The
claim was decorative.

**The fix.** A `HostingGroup` contract: who hosts the application, how many must be
online, who is down. Each operator reports **its own** node (`controller = that
node`), so no admin asserts on a node's behalf — and because observers include the
operator set, a non-operator is blocked by invisibility before the membership assert
is even reachable. `ActionRequest.Execute` then takes the group's contract id as an
**argument** and refuses below threshold.

**Why an argument and not a field.** The obvious design pins the group id on the
`ActionRequest` at request time. It is wrong: the report choices are consuming (they
recreate the contract), so a pinned id goes stale on the first toggle and `Execute`
fails with `CONTRACT_NOT_FOUND` instead of the honest hosting message. Passing the
id at execution time is safe because exactly one group is live per application, and
`Execute` re-asserts it belongs to this application.

**Result.** All four pillars enforced by the ledger. `daml test` green,
`verify:ledger` extended to the hosting sequence — two operators down → **execute
rejected on-ledger** → operator back → execute succeeds. The availability gate is
load-bearing.

---

## 2026-10-07 — Daml 2.10.6 was the wrong target, and the reason given for it was false

**What happened.** The project had deliberately pinned Daml 2.10.6, on the recorded
belief that stable 3.x shipped only through DA's enterprise Artifactory. That belief
was **wrong**: `v3.5.0-snapshot.*` tags are public releases on `digital-asset/daml`.
The pin cost real capability — and then a DAR built with the 2.10.6 SDK was rejected
outright by a 3.x participant
(`ALLOWED_LANGUAGE_VERSIONS ... Expected version range is [2.1..2.dev] but got 1.14`).

The argument for reversing was not "newer is better": both the DevNet/MainNet (Gold)
path and any real wallet run Canton 3.x, so the port was the shared prerequisite for
anything that mattered. Half a day was spent verifying a claim that should have been
checked the first time.

**The port.** `/v2/commands/submit-and-wait`, `/v2/state/ledger-end`,
`/v2/state/active-contracts`. Template ids moved to the package-*name* form
(`#canton-resilience:Main:Policy`), so no package id is discovered or threaded
through the environment at all. Two new traps:

- **`/livez` is not readiness.** The 3.x sandbox starts the participant and the
  synchronizer separately; `/livez` goes green first, and party allocation then fails
  with `PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER`. The bring-up script now
  gates on `/v2/state/connected-synchronizers`. This was the difference between a
  LocalNet that always failed and one that works.
- **A daemonised sandbox that inherits stdout breaks the script.** `npm run
  ledger:up | tail` never saw EOF, and a *failed* bring-up was indistinguishable from
  a slow one. The sandbox now logs to `.localnet-sandbox.log`.

**Also learned:** the JSON Ledger API still encodes `Int64` as a JSON **string**
(`"threshold":"2"`), and `allocatePartyByHint` is unary — no display-name argument.

**Clean-slate proof.** `daml build` + `daml test` green, `ledger:up` clean and
self-terminating, `verify:ledger` **18/18**, typecheck and production build clean. CI
gained a `ledger` job that runs the whole bring-up and verification on a clean
runner — the setup path is one command, not tribal knowledge.

---

## 2026-10-07 — the wallet, and why "documented seam" was a cop-out

**The correction.** The earlier note said "no public Grofty SDK" and stopped there.
But the standard Grofty implements — **CIP-0103**, the Canton dApp SDK
(`@canton-network/dapp-sdk`) — is published on npm. The seam existed because nobody
had looked properly.

**What replaced it.** `lib/wallet.ts` is a real adapter: it discovers an installed
wallet, silently restores an approved session, connects on request, reads the Canton
party the wallet actually holds, and can hand the wallet a command to sign and submit
itself. The enabling piece is a new `prepare` operation on the server route: it
returns the **exact command the route would have submitted**, plus the party that
command must be authorized by, *without submitting it*. The console then routes the
approval and the execution through the wallet whenever the connected party is the one
holding the authority — so the action carries the user's own authority rather than a
server's claim to it. The connection state is the SDK's, not a local boolean; a
rejected connection, an expired session and a missing wallet are distinguished and
reported as such.

**One constraint, stated rather than hidden.** A Canton wallet signs against the
network *its own validator* is on. A LocalNet sandbox is not that network, so during
the local demo no installed wallet can submit to it — the authority check is false
and the server route submits, exactly as before. Point the app at a network the
wallet is on and the wallet path takes over with no code change. Where no wallet is
installed at all, the console offers an explicitly-labelled demo signer
(`real = false`, visible banner, no signature produced) so the demo stays runnable,
and nothing about it can be mistaken for real signing.

**A build trap worth recording.** The dApp SDK *statically* imports
`@walletconnect/sign-client` despite declaring it an optional peer, so no bundler
build resolves after installing the SDK alone. Two packages fixed it.

---

## 2026-10-08 — the mix that undid itself

The demo video needed a voice-over, and the obvious way to write one is a second
document: a script, with timecodes, kept in sync with the picture by hand. That is
a promise to break. The captions were already the script — one sentence per beat,
injected at the moment the beat happens — so the narration is generated *from*
them. There is one source of truth, and editing a caption edits the voice.

**The mistake was the loudness normaliser.** The first narrated mix measured
-16 LUFS, hit its target exactly, and was wrong: the voice sat about 3 dB above the
music in the speech band, which is not narration, it is two things talking at once.
The cause was the `loudnorm` at the end of the chain. A single-pass loudness
normaliser applies *dynamic* gain — it lifts quiet passages and pulls down loud ones
— and the music had been deliberately ducked under the voice. So the normaliser
lifted the music back up, in exactly the moments the voice was speaking, undoing the
duck that had just been applied. Two correct stages, one incoherent result.

What settled it was isolating the duck: a 60 Hz tone ducked by a 1 kHz burst, which
showed 9.8 dB of gain reduction. The compressor worked. That meant the loss had to
be happening downstream, and there was only one thing downstream.

The fix is duller and better: normalise the *voice* on its own to a known level,
place the bed at a fixed level beneath it, duck the bed, sum, and then apply **one
static gain** — measured from a first render and used in a second — plus a peak
guard. Nothing in the chain moves once the balance is set. Separation went from 3 dB
to 9 dB, and the loudness range went from 4.2 LU to 9.6 LU: the mix breathes now,
because nothing is levelling it.

**Two smaller things, both caught by measuring rather than by looking.** `-shortest`
silently dropped the video's last 8 frames, because the limiter's lookahead makes the
audio marginally shorter than the picture — the audio is now padded and trimmed to
exactly the video's length. And the first honest measurement of the voice band was
misleading in the other direction: measuring below 60 Hz to isolate the music, the
narrator's own fundamental sits in the band, so the number moved the wrong way and
looked like a broken duck.

The pattern held: **what was wrong was not the parts, it was the composition** — and
only measuring the whole could show it.

---

## What is deliberately not here

- **A treasury balance.** The console has no account balance and neither do the
  contracts. That is a boundary, not an omission: this layer governs *who may act and
  whether the application is reachable to act*, not custody. The reference action —
  "Send 50,000 CC" — is a request the policy authorizes, not a transfer out of an
  escrowed balance, so there is no quantity to hold or display.
- **A real multi-participant topology.** `HostingGroup` models the *status* of the
  operator set and `Execute` enforces the threshold on-ledger. What runs *below* it —
  BitSafe's Decentralized Party and an actual distributed participant set — is the
  Decentralization Manager's job and is not reimplemented here. Against a single
  LocalNet participant the operator parties are real allocated parties reporting real
  status, but they are not separate nodes, and calling them one would be a lie. This
  is the remaining seam, and it is infrastructure, not code.

## What the ledger taught us

Three times the honest finding was *stricter than the assumption*: a non-member
cannot see the contract at all; a stale pinned contract id would fail with the wrong
error; the participant refuses commands before it has joined a synchronizer. Each was
found by running the thing rather than reading about it. The habit that made this
project work is the one worth keeping: **assert it on a live ledger, in CI, or it is
not proven.**
