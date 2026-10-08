# Pitch — Canton Resilience

## The question

**What happens when the people or the infrastructure responsible for a Canton
application become unavailable?**

Every institutional application on Canton has privileged actions — a treasury
transfer, a token mint, a fee change, a protocol pause. Almost all of them are
guarded the same way in practice: one signer, or one operator, or one server that
holds the key. That is a single point of control, wearing decentralization as a
costume. The ledger is decentralized; the *authority over it* is not.

## The answer

A **reusable decentralized control layer** for Canton applications: policy,
multi-party approval, resilient hosting, and audit — enforced by Daml, not by a
dashboard. The institutional treasury is the reference app, not the product.

Two independent guarantees, both enforced on-ledger:

- **Shared control.** A privileged action does not execute until a configured quorum
  of parties approves it. If the quorum is not met, the ledger refuses — no server
  can override it, and no console can fake it.
- **Distributed hosting.** Each hosting operator reports *its own* node status. Take
  one offline and the application keeps running, because the threshold still permits
  it. Drop below the threshold and **execution is refused by the contract** — not by
  a UI deciding to grey out a button.

## Why it is not another dashboard

Three claims, and how each is backed:

**It is enforced, not displayed.** All four pillars live in Daml choices
(`daml/Main.daml`). The availability gate is inside `ActionRequest.Execute`: it
refuses while online operators are below threshold. A console that lied about
availability would change nothing.

**It is proven, not demonstrated.** `npm run verify:ledger` drives the entire
flow against a live Canton ledger and asserts the invariants — including that
execution is **rejected on-ledger** while under-hosted and permitted again after
recovery. CI runs the full bring-up and that suite on a clean runner. A demo that
works when you click it is a demo; one that fails a build when it breaks is a proof.

**The wallet is in the flow, not beside it.** The privileged action is authorized by
the user's own Canton party. The console asks the server route for the exact command
it *would* have submitted — unsubmitted — and hands it to the wallet when the wallet
holds the acting party, so the ledger sees the user's authority rather than a
server's claim to it. Built on the published Canton dApp SDK (CIP-0103), the standard
a wallet like Grofty implements.

## Why it matters to BitSafe

BitSafe's own challenge draws a line between **shared control** (who may act) and
**distributed hosting** (what stays up). This project is that line, made executable
and reusable. It does not reimplement the Decentralization Manager — it *depends* on
it. The `HostingGroup` contract models the operator set's status and enforces the
threshold; the Decentralized Party and the real distributed node topology underneath
are the Decentralization Manager's to provide. The interface between the two is a
contract, not an integration project.

That is also the upgrade path: point this layer at a real Decentralized Party on
DevNet/MainNet and the modelled operator set becomes a genuinely distributed one,
with no change to the application logic.

## What is honestly not here

- **Custody.** The reference treasury action is a *request the policy authorizes*,
  not a transfer out of an escrowed balance — so there is no balance to display. This
  layer governs who may act, not who holds funds.
- **The real multi-participant topology.** Against a single LocalNet participant the
  operator parties are real allocated parties reporting real status, but they are not
  separate nodes. Calling them one would be a lie; providing them is the
  Decentralization Manager's job.

## The one-liner

**Canton applications get decentralized authority and survive an operator failure —
enforced by the ledger, proven on a live one, reusable by any application.**
