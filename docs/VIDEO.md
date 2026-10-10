# Demo video — script and shot list

**Target: 2:30 (range 2:00–3:00). Landscape 1920×1080.**
Everything on screen is the real application against a live Canton ledger — live
mode (`NEXT_PUBLIC_LEDGER_MODE=json-api`, header reads `json-api`), with
`npm run ledger:up` running. Nothing is staged or mocked; the failures shown are the
ledger refusing.

## Two ways to produce it

**Automated, with narration.** `npm run demo:video` records a captioned
screencast of the real console driving the live ledger — it clicks the same
buttons the shot list below describes, injects the captions into the page, and
encodes with ffmpeg, giving `brag-output/demo.mp4` (~2:58) plus a `.jpg` poster,
a `.srt` caption track and a `.srt` of the voice-over's own timings.

Every beat is asserted before its caption is allowed to appear: the recorder
waits for the ledger's own state to show up on screen (`1 of 2 required`, then
`Quorum met`, then `Application unavailable`, then `no signature (demo)`) and
**stops** if it never does. A caption is a claim, so a beat that does not land is
a failed recording rather than a video that quietly describes something else.

The narration is *generated from the captions*, because the captions are already
the script: one sentence per beat, on screen at the moment the beat happens.
`scripts/voiceover.mjs` speaks each one at its caption's time and the score is
mixed under it, so editing a caption edits the narration — there is no second
script to keep in sync. The voice is `edge-tts` (free, no account, no key):

```bash
uv tool install edge-tts      # or: pipx install edge-tts
VOICE=en-US-AndrewNeural npm run demo:video   # pick a different voice
```

If `edge-tts` is missing or offline, the run still produces the video — it warns
and scores it with music and cues only, rather than failing on its soundtrack.
`--no-vo` asks for that deliberately.

Requirements and caveats are in the script header (`scripts/demo-video.mjs`); it
needs a live ledger, the app running in live mode on `:3200`, and a Chromium
(`CHROME_BIN` overrides the default).

**Your own voice.** Read the shot list below over the same recording — play the
automated cut and speak the lines under each caption. A human take is warmer than
a synthesised one, and worth it if you have the time; the captioned version is
already a complete artifact if you do not.

The strongest version of the shared-control shot is the two-window approval
described below: the point lands better when the two approvals visibly come from
two separate browsers than when they come from one page talking to itself.

## Before recording

```bash
npm run ledger:stop && npm run ledger:up   # fresh sandbox, parties, policies — writes .env.local
npm run dev                                # http://localhost:3000 — header must read "json-api"
```

**Start from a fresh ledger.** `executed` is read from the presence of an
`AuditRecord` (`app/api/ledger/route.ts`), and audit records are immutable and
never archived — so an application that has been executed once on a ledger
reports executed forever. Record against that state and you get a video whose
captions describe a flow the screen is not showing: no Execute button to click,
the approval and node controls locked, a "quorum met" caption over an untouched
request. `npm run demo:video` checks for exactly this before it starts and
refuses to record on a used ledger.

For the same reason, restart the app after `ledger:up`: the party map is read
once at startup, and a fresh ledger allocates new parties.

Two browser windows side by side is the cheapest way to show that approvals are
independent operators, not one page talking to itself. Window A approves as **Alice**;
Window B (a second, separate browser profile) approves as **Bob**. Both read the same
on-ledger `ActionRequest`, and neither can see the other's local state — because
there is no local state.

Leave the **Network** tab of devtools open in one window for the shot at 1:55.

---

## Shot list

### 0:00–0:15 — The question

*Screen: the console at rest, Treasury selected.*

> "Every institutional application has privileged actions — a treasury transfer, a
> token mint, a fee change. On Canton, almost all of them are guarded by one signer
> or one operator. That's decentralized settlement with centralized control. So: what
> happens when that operator disappears?"

### 0:15–0:35 — What this is

*Screen: scroll the four reference applications in the switcher.*

> "Resilix is a reusable control layer for Canton applications: policy,
> multi-party approval, resilient hosting, and audit. The treasury is the reference
> app — the layer is the product. The same contracts protect all four of these, and
> switching applications switches the on-ledger policy it drives."

*Point at the header: `json-api`.*

> "And this is not a model. The header says `json-api` — every click from here on is a
> real Daml command against a running Canton ledger."

### 0:35–1:00 — Shared control

*Screen: the Shared Control card. Approve as Alice.*

> "The action needs two of three approvals. Alice approves — one of two. Execution is
> still blocked, and that block is on the ledger, not in this UI."

*Switch to the second window. Approve as Bob. Progress reaches 2/2.*

> "Bob is a different operator, on a different browser, holding a different party. He
> approves. Quorum met — and only now does the ledger permit execution."

### 1:00–1:35 — Distributed hosting (the centrepiece)

*Screen: the hosting panel, Nodes A/B/C online.*

> "Independently, the application is hosted by three operators, and two of them must
> stay online. Each operator reports *its own* node — no admin asserts on anyone's
> behalf."

*Take Node A offline.*

> "Node A goes down. Status is now two of three — and the application stays available,
> because the threshold still permits operation. That's the point: one operator
> disappearing is not an incident."

*Take Node B offline.*

> "Now Node B goes too. One of three — below threshold. And execution is refused."

*Click Execute. The error appears.*

> "Not greyed out by the UI — refused by the contract. `Execute` fetches the hosting
> group and will not run below threshold. Bring the operator back..."

*Bring Node B online. The Execute button unlocks.*

> "...and it's permitted again, because the condition is now true on the ledger."

### 1:35–1:55 — The wallet

*Screen: top-right. Connect Grofty.*

> "The approval and the execution are authorized by the user's own Canton party. The
> console asks the server for the exact command it would have submitted — without
> submitting it — and hands it to the wallet, which signs and submits it itself."

*Execute. The button resolves to `Signed via Grofty`.*

> "So the ledger sees the user's authority, not a server claiming to be them."

*If no wallet extension is available on the recording machine, say so plainly rather
than hiding it:* the console offers a demo signer labelled `real = false` with a
visible banner, and the honest line is "no Canton wallet in this browser, so the
server route submits — on a network the wallet is on, the wallet path takes over."

### 1:55–2:20 — Audit, and that it isn't local state

*Screen: the audit trail. Then hard-refresh (Cmd/Ctrl-Shift-R).*

> "Every request, approval, hosting change and execution is an immutable AuditRecord
> contract — including the online-operator count at the moment of execution. Hard
> refresh: approvals, hosting state and the audit trail all come back."

*Open devtools → Network. Trigger one approval. Point at the POST to `/api/ledger`.*

> "The browser holds no ledger token and talks to no participant directly — one
> same-origin call, and the ledger decides."

### 2:20–2:35 — Proof

*Screen: `npm run verify:ledger` output, scrolling to PASS.*

> "And none of this is click-tested. `verify-ledger` drives the whole flow against a
> live ledger and asserts the invariants — including that execution is rejected
> on-ledger while under-hosted, and permitted after recovery. CI runs it on a clean
> runner. A demo that works when you click it is a demo; one that fails a build when
> it breaks is a proof."

### 2:35–2:50 — Close

*Screen: wordmark, or the `/demo` walkthrough running.*

> "Resilix: applications that survive an operator failure and cannot be
> moved by one party. Decentralized control, enforced by the ledger and proven on
> one."

---

## Recording notes

- **Reveal awkwardness early.** The two-window approval and the under-hosted
  rejection are the two moments that carry the argument; if a take is going long, cut
  the application-switcher scroll, not those.
- **Do not narrate the seams away.** If the wallet cannot sign on LocalNet, say why in
  one sentence (a wallet signs on its own validator's network) and move on. Every
  honest "here is the limit" in this video makes the rest of it more credible.
- **One take of the ledger doing the refusing** is worth more than three rehearsed
  clicks: let the error message sit on screen for a beat.
- Suggested capture: OBS at 1920×1080/30, or `ffmpeg -f x11grab` if recording on
  Linux. Terminal font ≥ 16px so `verify-ledger` output is legible at 1080p.
