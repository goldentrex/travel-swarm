# How this engine was built

**The claim, in one sentence:**

> The disruption-recovery engine in this repository was created with **Qoder**
> (Quest mode with experts) in a single window from **19 to 25 August 2026**,
> and **99.61% of it originated inside that window**.

Not 80% of a codebase. 99.61% of *this* engine, measured by a line census that
re-runs from the git history, at a fixed commit that does not move.

---

## 1. What is being claimed, and what is not

GlobePlanner — the trip planner this engine plugs into — predates the hackathon
by three months and was built with other tools. **No claim is made about it.**

The claim is about the closure in this repository: the graph, the agents, the
sanity rails, the Trust Layer, the providers, the Worker, and the iOS surfaces
that drive them. That closure is what the census measures, and nothing else.

The user's phrasing is worth keeping: *the engine as it was made*, not the
refinements that came after. That distinction is exactly what the two
measurements below separate.

## 2. The census — measured, not asserted

```bash
node scripts/evidence/core-attribution.mjs --at 64375e98   # last commit of the window
node scripts/evidence/core-attribution.mjs                 # today
```

`git blame -w -M -C` credits every surviving line to the commit that last wrote
it — ignoring whitespace, following code that moved within and between files.
A line rewritten in September is credited to September, never to August. The
Qoder share this produces is therefore a **floor**, never a flattering figure.

### At the end of the Quest window — *the engine as it was made*

| Group | Files | Lines | Before | **Qoder window** | After | Share |
|---|---:|---:|---:|---:|---:|---:|
| DAG, agents, sanity rails | 12 | 4,182 | 0 | 4,182 | 0 | **100%** |
| Swarm API + Worker | 5 | 4,202 | 0 | 4,202 | 0 | **100%** |
| Providers | 11 | 2,389 | 0 | 2,389 | 0 | **100%** |
| iOS surfaces | 5 | 3,865 | 57 | 3,808 | 0 | **98.53%** |
| **Total** | **33** | **14,638** | 57 | **14,581** | 0 | **99.61%** |

### At HEAD today — *after a month of hardening*

| Group | Files | Lines | **Qoder window** | After | Share |
|---|---:|---:|---:|---:|---:|
| DAG, agents, sanity rails | 24 | 12,973 | 3,967 | 9,006 | 30.58% |
| Swarm API + Worker | 8 | 9,061 | 3,896 | 5,165 | 43.00% |
| Providers | 12 | 3,504 | 2,251 | 1,253 | 64.24% |
| iOS surfaces | 9 | 7,768 | 3,651 | 4,036 | 47.00% |
| **Total** | **53** | **33,306** | **13,765** | 19,460 | **41.33%** |

**Read the second table as the honest companion to the first.** The engine more
than doubled after the window — real provider integrations, honesty rails,
budget guards, a settlement gate. All of that is credited to September, as it
should be. This number also **drifts downward with every commit**: if a judge
re-runs it and gets a little less than 41.33%, that is the census working.

The figure that answers the 80% question is the first one. It is measured at a
fixed commit and it does not move.

Both reports list every commit that touched the core, with its date and
surviving-line count, so the window boundary can be moved and recomputed rather
than taken on trust: [`docs/evidence/`](evidence/).

## 3. The tool was demonstrably running on this repository

From `.qoder/repowiki/en/meta/repowiki-metadata.json`, the index Qoder writes
when it maps a codebase — copied to
[`docs/evidence/qoder-session-2026-08-19.json`](evidence/qoder-session-2026-08-19.json):

| Field | Value |
|---|---|
| Session id | `5f12d794-a983-4dd1-ac06-8e44c601b786` |
| Repository | `AIGlobePlanner` |
| Created | **2026-08-19 17:22:13 +08:00** |
| Completed | **2026-08-19 19:43:38 +08:00** |
| Status | `completed` / `wiki_generation_completed` |
| Generated | **194 wiki items**, 194 catalogs, **183 knowledge relations** |

The first core commit — the DAG engine, orchestrator, Flight agent, Trust Layer
and Atlas provider — is timestamped **19 August, 19:17 +08:00**.

That is *inside* the session, not merely on the same day. The tool was indexing
and generating against this repository during the exact hours the engine first
appeared.

## 4. On Qwen — what the repository can and cannot show

Qoder is Alibaba's agentic IDE, and the owner attests that these sessions ran
**Qoder in Quest mode with experts, on Qwen**.

**The repository does not record a model name.** The Qoder session metadata
carries session identity, timing, status and index counts — no model field. We
looked; it is not there.

So this document draws the line explicitly rather than blurring it:

| Statement | Basis |
|---|---|
| 99.61% of the engine originated in the 19–25 August window | **Measured** — blame census, re-runnable |
| Qoder was running on this repository during the hours the engine appeared | **Measured** — session metadata, committed |
| 43,047 insertions in 7 days, 19,035 in a single commit, tests included | **Circumstantial** — commit statistics |
| Specification and implementation landed in the same commit | **Circumstantial** — the Quest working pattern |
| Those sessions ran Qoder in Quest mode with experts, on Qwen | **Attested by the owner** |

Anyone who wants the last row moved into the first two needs a Quest session
export from Qoder that names the model. Until such an export exists, it is an
attestation, and calling it anything else would be dishonest — and would hand a
skeptical reviewer the one thread that unravels the rest.

Everything above that last row is checkable by a reviewer in under five minutes.

## 5. The volume, and the shape of it

| Commit | When | Files | Insertions |
|---|---|---:|---:|
| `2ecd4a1a` | 08-19 19:17 | 13 | 1,317 |
| `98621ca7` | 08-22 00:49 | **86** | **19,035** |
| `79adf106` | 08-22 02:09 | 25 | 3,967 |
| `f8ab79ec` | 08-23 16:04 | 19 | 1,166 |
| `b1b2fe28` | 08-24 21:26 | 28 | 9,109 |
| `71633aed` | 08-24 21:50 | 2 | 86 |
| `0a3c6e4a` | 08-25 09:22 | 21 | 4,182 |
| `4dda1127` | 08-25 18:41 | 30 | 3,844 |
| `64375e98` | 08-25 20:01 | 9 | 341 |
| **Total** | **7 days** | | **43,047** |

One commit carries 19,035 insertions across 86 files — a complete subsystem,
typed, with its tests. The next lands eighty minutes later with 3,967 more.
Alongside the implementation, in the same commits: **5,354 lines of tests**,
written *with* the code rather than bolted on after.

This is consistent with agentic generation and hard to reconcile with hand
authoring at that rate. It is circumstantial, and it is presented as such.

## 6. What the census cannot separate

Git records **one author** across the whole window. It can prove the engine was
*created* there; it cannot separate lines a tool generated from lines typed by
hand inside that same window. Only a Quest session export closes that gap.

We would rather state the boundary than claim past it.

---

## How to say it in thirty seconds

> "The claim is about the engine, not the codebase — 33 files at the time: the
> graph, the agents, the Trust Layer, the providers, the worker, the iOS
> surfaces. A blame census puts **99.6%** of it inside the Qoder Quest window,
> and the session metadata shows the tool indexing this repository during the
> hours the first core commit landed. Today the same census reads 41%, because
> a month of hardening followed and every rewritten line is credited to the
> rewrite. That the sessions ran on Qwen is my attestation — the repository
> records the tool, not the model, and I would rather say so than overclaim."
