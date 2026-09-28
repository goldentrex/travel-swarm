# Swarm core — line attribution census

Census taken at `26daa9f9` (HEAD).
Re-run with `node scripts/evidence/core-attribution.mjs`.

## Method

git blame -w -M -C over the swarm closure; each surviving line credited to the commit that last wrote it. Lines rewritten after the window count AGAINST the window, so the Qoder share is a lower bound.

Qoder Quest window: **2026-08-19 → 2026-08-25**. Every commit that touched
the core is listed below with its date, so the boundary can be moved and the numbers recomputed.

## Result

| Group | Files | Surviving lines | Before window | Qoder window | After window | Qoder share |
|---|---:|---:|---:|---:|---:|---:|
| dag_and_agents | 24 | 12973 | 0 | 3967 | 9006 | **30.58%** |
| swarm_api | 8 | 9061 | 0 | 3896 | 5165 | **43%** |
| providers | 12 | 3504 | 0 | 2251 | 1253 | **64.24%** |
| ios_surfaces | 9 | 7768 | 81 | 3651 | 4036 | **47%** |
| **core total** | **53** | **33306** | 81 | 13765 | 19460 | **41.33%** |

## Commits touching the core

| Commit | Date | Author | Surviving lines | Share | Bucket |
|---|---|---|---:|---:|---|
| `98621ca7` | 2026-08-22 | VictorGAYA | 7172 | 21.53% | qoder_window |
| `c7bc6646` | 2026-09-02 | VictorGAYA | 3244 | 9.74% | after |
| `ddd49539` | 2026-08-29 | VictorGAYA | 3057 | 9.18% | after |
| `cdc05774` | 2026-09-17 | VictorGAYA | 2911 | 8.74% | after |
| `0a3c6e4a` | 2026-08-25 | VictorGAYA | 1833 | 5.50% | qoder_window |
| `79adf106` | 2026-08-22 | VictorGAYA | 1791 | 5.38% | qoder_window |
| `54c2ba89` | 2026-09-17 | VictorGAYA | 1342 | 4.03% | after |
| `2ecd4a1a` | 2026-08-19 | VictorGAYA | 1262 | 3.79% | qoder_window |
| `4dda1127` | 2026-08-25 | VictorGAYA | 1095 | 3.29% | qoder_window |
| `bd35c271` | 2026-08-30 | VictorGAYA | 559 | 1.68% | after |
| `cde640d8` | 2026-09-18 | VictorGAYA | 483 | 1.45% | after |
| `2bb79e18` | 2026-08-26 | VictorGAYA | 456 | 1.37% | after |
| `b1b2fe28` | 2026-08-24 | VictorGAYA | 443 | 1.33% | qoder_window |
| `a73ac5d3` | 2026-08-28 | VictorGAYA | 440 | 1.32% | after |
| `aad1880f` | 2026-09-18 | VictorGAYA | 415 | 1.25% | after |
| `21e5cf54` | 2026-08-26 | VictorGAYA | 372 | 1.12% | after |
| `fb6634cb` | 2026-08-26 | VictorGAYA | 371 | 1.11% | after |
| `6dd8a44d` | 2026-08-27 | VictorGAYA | 346 | 1.04% | after |
| `90a81227` | 2026-09-18 | VictorGAYA | 336 | 1.01% | after |
| `d71dcc59` | 2026-09-18 | VictorGAYA | 326 | 0.98% | after |
| `d7170317` | 2026-08-28 | VictorGAYA | 299 | 0.90% | after |
| `24a378a6` | 2026-08-27 | Claude | 297 | 0.89% | after |
| `439f3e10` | 2026-08-27 | Claude | 286 | 0.86% | after |
| `a1e9a00d` | 2026-09-18 | VictorGAYA | 262 | 0.79% | after |
| `161ff162` | 2026-09-19 | VictorGAYA | 233 | 0.70% | after |
| `f5efcfc0` | 2026-09-19 | VictorGAYA | 231 | 0.69% | after |
| `4f1e4765` | 2026-09-19 | VictorGAYA | 191 | 0.57% | after |
| `975f4754` | 2026-09-18 | VictorGAYA | 184 | 0.55% | after |
| `92a0dba2` | 2026-09-18 | VictorGAYA | 176 | 0.53% | after |
| `cdef5b68` | 2026-09-19 | VictorGAYA | 167 | 0.50% | after |
| `f64530e9` | 2026-09-18 | VictorGAYA | 166 | 0.50% | after |
| `c44b25fc` | 2026-09-18 | VictorGAYA | 166 | 0.50% | after |
| `418c34ba` | 2026-09-20 | VictorGAYA | 145 | 0.44% | after |
| `f41cf6a8` | 2026-09-02 | VictorGAYA | 127 | 0.38% | after |
| `47738424` | 2026-08-27 | Claude | 120 | 0.36% | after |
| `37a842ac` | 2026-09-02 | VictorGAYA | 104 | 0.31% | after |
| `3e1231f8` | 2026-08-29 | VictorGAYA | 103 | 0.31% | after |
| `64375e98` | 2026-08-25 | VictorGAYA | 97 | 0.29% | qoder_window |
| `763502d4` | 2026-09-18 | VictorGAYA | 89 | 0.27% | after |
| `0a5e9955` | 2026-09-18 | VictorGAYA | 87 | 0.26% | after |
| `af41d907` | 2026-09-18 | VictorGAYA | 86 | 0.26% | after |
| `945728d8` | 2026-08-28 | VictorGAYA | 81 | 0.24% | after |
| `68fde48b` | 2026-09-18 | VictorGAYA | 79 | 0.24% | after |
| `f567dde3` | 2026-06-27 | VictorGAYA | 76 | 0.23% | before |
| `3f54fc3c` | 2026-09-20 | VictorGAYA | 73 | 0.22% | after |
| `1ba627b9` | 2026-09-19 | VictorGAYA | 66 | 0.20% | after |
| `c040df0e` | 2026-09-18 | VictorGAYA | 60 | 0.18% | after |
| `f9093445` | 2026-09-18 | VictorGAYA | 60 | 0.18% | after |
| `f8d582da` | 2026-09-18 | VictorGAYA | 58 | 0.17% | after |
| `1e3bfca6` | 2026-08-27 | Claude | 57 | 0.17% | after |
| `6cf92363` | 2026-09-18 | VictorGAYA | 56 | 0.17% | after |
| `47bad3b1` | 2026-09-18 | VictorGAYA | 53 | 0.16% | after |
| `71633aed` | 2026-08-24 | VictorGAYA | 51 | 0.15% | qoder_window |
| `a89c11ed` | 2026-09-18 | VictorGAYA | 49 | 0.15% | after |
| `2ac69e32` | 2026-09-18 | VictorGAYA | 44 | 0.13% | after |
| `86adce7d` | 2026-09-20 | VictorGAYA | 42 | 0.13% | after |
| `6decee43` | 2026-09-18 | VictorGAYA | 38 | 0.11% | after |
| `ecf0d648` | 2026-09-19 | VictorGAYA | 35 | 0.11% | after |
| `e7d335a2` | 2026-09-18 | VictorGAYA | 31 | 0.09% | after |
| `a24165f4` | 2026-09-18 | VictorGAYA | 30 | 0.09% | after |
| `ef9aafe0` | 2026-09-19 | VictorGAYA | 29 | 0.09% | after |
| `a7c0ca7a` | 2026-09-18 | VictorGAYA | 28 | 0.08% | after |
| `f61b99e0` | 2026-08-28 | VictorGAYA | 28 | 0.08% | after |
| `4551f05b` | 2026-09-18 | VictorGAYA | 24 | 0.07% | after |
| `268126b0` | 2026-09-18 | VictorGAYA | 22 | 0.07% | after |
| `aa026dae` | 2026-09-18 | VictorGAYA | 22 | 0.07% | after |
| `8a06c25f` | 2026-09-19 | VictorGAYA | 22 | 0.07% | after |
| `f8ab79ec` | 2026-08-23 | VictorGAYA | 21 | 0.06% | qoder_window |
| `0a32a70c` | 2026-09-19 | VictorGAYA | 21 | 0.06% | after |
| `840b1990` | 2026-09-19 | VictorGAYA | 19 | 0.06% | after |
| `73127437` | 2026-09-26 | VictorGAYA | 19 | 0.06% | after |
| `1a1d48a5` | 2026-09-18 | VictorGAYA | 19 | 0.06% | after |
| `d3b7a162` | 2026-09-02 | VictorGAYA | 18 | 0.05% | after |
| `c96086c6` | 2026-09-20 | VictorGAYA | 15 | 0.05% | after |
| `ace906a3` | 2026-09-19 | VictorGAYA | 14 | 0.04% | after |
| `e386b280` | 2026-09-20 | VictorGAYA | 12 | 0.04% | after |
| `2988cde6` | 2026-09-18 | VictorGAYA | 9 | 0.03% | after |
| `9d01c976` | 2026-08-27 | Claude | 9 | 0.03% | after |
| `0188e708` | 2026-09-18 | VictorGAYA | 8 | 0.02% | after |
| `27affa37` | 2026-09-18 | VictorGAYA | 8 | 0.02% | after |
| `b76ec7cc` | 2026-09-26 | VictorGAYA | 7 | 0.02% | after |
| `54655022` | 2026-09-18 | VictorGAYA | 7 | 0.02% | after |
| `faa4c603` | 2026-08-27 | Claude | 5 | 0.02% | after |
| `a7a166e6` | 2026-09-20 | VictorGAYA | 3 | 0.01% | after |
| `a4ec3c74` | 2026-07-03 | VictorGAYA | 2 | 0.01% | before |
| `a15db091` | 2026-07-05 | VictorGAYA | 2 | 0.01% | before |
| `00d3b652` | 2026-09-18 | VictorGAYA | 1 | 0.00% | after |
| `c531c266` | 2026-09-19 | VictorGAYA | 1 | 0.00% | after |
| `479370cf` | 2026-07-12 | VictorGAYA | 1 | 0.00% | before |
| `df160fd9` | 2026-09-20 | VictorGAYA | 1 | 0.00% | after |
