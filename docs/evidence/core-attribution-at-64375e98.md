# Swarm core — line attribution census

Census taken at `64375e98` (64375e98).
Re-run with `node scripts/evidence/core-attribution.mjs`.

## Method

git blame -w -M -C over the swarm closure; each surviving line credited to the commit that last wrote it. Lines rewritten after the window count AGAINST the window, so the Qoder share is a lower bound.

Qoder Quest window: **2026-08-19 → 2026-08-25**. Every commit that touched
the core is listed below with its date, so the boundary can be moved and the numbers recomputed.

## Result

| Group | Files | Surviving lines | Before window | Qoder window | After window | Qoder share |
|---|---:|---:|---:|---:|---:|---:|
| dag_and_agents | 12 | 4182 | 0 | 4182 | 0 | **100%** |
| swarm_api | 5 | 4202 | 0 | 4202 | 0 | **100%** |
| providers | 11 | 2389 | 0 | 2389 | 0 | **100%** |
| ios_surfaces | 5 | 3865 | 57 | 3808 | 0 | **98.53%** |
| **core total** | **33** | **14638** | 57 | 14581 | 0 | **99.61%** |

## Commits touching the core

| Commit | Date | Author | Surviving lines | Share | Bucket |
|---|---|---|---:|---:|---|
| `98621ca7` | 2026-08-22 | VictorGAYA | 7509 | 51.30% | qoder_window |
| `0a3c6e4a` | 2026-08-25 | VictorGAYA | 2037 | 13.92% | qoder_window |
| `79adf106` | 2026-08-22 | VictorGAYA | 1903 | 13.00% | qoder_window |
| `2ecd4a1a` | 2026-08-19 | VictorGAYA | 1242 | 8.48% | qoder_window |
| `4dda1127` | 2026-08-25 | VictorGAYA | 1156 | 7.90% | qoder_window |
| `b1b2fe28` | 2026-08-24 | VictorGAYA | 527 | 3.60% | qoder_window |
| `64375e98` | 2026-08-25 | VictorGAYA | 101 | 0.69% | qoder_window |
| `71633aed` | 2026-08-24 | VictorGAYA | 85 | 0.58% | qoder_window |
| `f567dde3` | 2026-06-27 | VictorGAYA | 57 | 0.39% | before |
| `f8ab79ec` | 2026-08-23 | VictorGAYA | 21 | 0.14% | qoder_window |
