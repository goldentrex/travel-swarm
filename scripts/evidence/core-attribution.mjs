#!/usr/bin/env node
/**
 * Who wrote the swarm core, line by line — reproducible from git alone.
 *
 * WHY THIS EXISTS. The hackathon panel split on attribution: half read the
 * spec-driven history and the XCUITest suite as sufficient evidence, half
 * wanted a clearer record of how much of the CORE the Qoder (Quest) sessions
 * actually produced. An attestation cannot settle that. A blame census can:
 * it is derived from the repository the judges already have, and re-running it
 * reproduces every number here byte for byte.
 *
 * WHAT IS COUNTED. Only the disruption-recovery closure — the DAG, the agents,
 * the Trust Layer, the sanity rails, the swarm API, the providers, the Worker
 * entrypoint and the iOS swarm surfaces. NOT the trip-planner product around
 * it: that predates the hackathon (gpt-engineer / Lovable, May–August) and
 * nobody claimed it.
 *
 * HOW IT COUNTS. `git blame -w -M -C` attributes each SURVIVING line to the
 * commit that last wrote it, ignoring whitespace and following code that moved
 * within or between files. Lines rewritten after the Qoder window are credited
 * to the rewrite, not to the original author — so the Qoder share this reports
 * is a LOWER BOUND on what those sessions produced, never an inflated one.
 *
 * The window boundary is stated, not hidden: every commit that touched the core
 * is listed with its date, author and surviving-line count, so a judge can move
 * the boundary and recompute rather than take our word for where it sits.
 */
/*
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNS IN THE SOURCE REPOSITORY, NOT HERE.
 *
 * This file is shipped so the method can be read and re-run, but a blame census
 * needs the history the code was written in. travel-swarm's history begins at
 * its first sync commit, so running this here would credit every line to a sync
 * and measure nothing.
 *
 * Point it at the monorepo (GlobePlanner) where the paths below exist and the
 * August commits are reachable. The outputs it produced there are committed in
 * docs/evidence/, and docs/PROVENANCE.md reads them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");

/** The swarm closure, as extracted to ../swarm-standalone, plus the iOS surfaces. */
const GROUPS = {
  dag_and_agents: ["src/agents", "src/core/dag", "src/core/sanity"],
  swarm_api: [
    "src/lib/hackathonApi.ts",
    "src/lib/swarmAuth.ts",
    "src/lib/swarmBookingPreview.ts",
    "src/lib/swarmIntent.ts",
    "src/lib/swarmReachability.ts",
    "src/lib/swarmSessionStore.ts",
    "src/lib/swarmTripContext.ts",
    "workers/swarm-demo/src",
  ],
  providers: ["src/providers"],
  ios_surfaces: [
    "ios/GlobePlanner/Features/Trips/NexusSwarmView.swift",
    "ios/GlobePlanner/Features/Trips/SwarmBookingSheet.swift",
    "ios/GlobePlanner/Features/Trips/SwarmEntryPoints.swift",
    "ios/GlobePlanner/Features/Trips/SwarmFormat.swift",
    "ios/GlobePlanner/Features/Trips/SwarmMissionTargets.swift",
    "ios/GlobePlanner/Features/Trips/SwarmService.swift",
    "ios/GlobePlanner/Features/Trips/SwarmSettlementSync.swift",
    "ios/GlobePlanner/Features/Trips/SwarmViewModel.swift",
    "ios/GlobePlanner/Features/Trips/TrustLayerSheet.swift",
  ],
};

/** The Quest sessions the owner attests to, by date. Commits are listed in the
 *  output so the boundary can be checked rather than believed. */
const QODER_WINDOW = { from: "2026-08-19", to: "2026-08-25" };

const git = (args) => execFileSync("git", args, { cwd: repo, maxBuffer: 1 << 28 }).toString();

/**
 * Which revision to take the census at. Default HEAD — the core as it stands
 * today, a month of post-hackathon hardening included. Pass `--at <ref>` to
 * measure it at an earlier point: `--at 64375e98` is the last commit of the
 * Quest window, and answers the different, fairer question "how much of the
 * core had those sessions produced at the moment the core was finished", before
 * later rewrites reassigned lines away from them.
 */
const atFlag = process.argv.indexOf("--at");
const REV = atFlag > -1 ? process.argv[atFlag + 1] : "HEAD";

function filesUnder(spec) {
  const listed = git(["ls-tree", "-r", "--name-only", REV, "--", spec]).trim();
  if (!listed) return [];
  return listed
    .split("\n")
    .filter((f) => /\.(ts|swift)$/.test(f))
    .filter((f) => !/\.test\.ts$|__tests__\/|\.d\.ts$|Tests\.swift$/.test(f));
}

/** commit → {date, author, subject}; filled lazily as blame reports hashes. */
const commitMeta = new Map();
function metaFor(sha) {
  if (!commitMeta.has(sha)) {
    const [date, author, subject] = git(["show", "-s", "--format=%ad%n%an%n%s", "--date=short", sha])
      .trim()
      .split("\n");
    commitMeta.set(sha, { date, author, subject });
  }
  return commitMeta.get(sha);
}

/** Surviving lines per commit for one file. */
function blameCounts(file) {
  const out = git(["blame", "-w", "-M", "-C", "--line-porcelain", REV, "--", file]);
  const counts = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

const bucketOf = (date) =>
  date < QODER_WINDOW.from ? "before" : date <= QODER_WINDOW.to ? "qoder_window" : "after";

const groups = {};
const perCommit = new Map();
let files = 0;

for (const [group, specs] of Object.entries(GROUPS)) {
  const tally = { files: 0, lines: 0, before: 0, qoder_window: 0, after: 0 };
  for (const spec of specs) {
    for (const file of filesUnder(spec)) {
      tally.files += 1;
      files += 1;
      for (const [sha, n] of blameCounts(file)) {
        const meta = metaFor(sha);
        const bucket = bucketOf(meta.date);
        tally.lines += n;
        tally[bucket] += n;
        const seen = perCommit.get(sha) ?? { ...meta, sha: sha.slice(0, 8), bucket, lines: 0 };
        seen.lines += n;
        perCommit.set(sha, seen);
      }
    }
  }
  tally.qoder_pct = tally.lines ? +((tally.qoder_window / tally.lines) * 100).toFixed(2) : 0;
  groups[group] = tally;
}

const total = ["lines", "before", "qoder_window", "after"].reduce(
  (acc, k) => ({ ...acc, [k]: Object.values(groups).reduce((s, g) => s + g[k], 0) }),
  {},
);
total.files = files;
total.qoder_pct = +((total.qoder_window / total.lines) * 100).toFixed(2);

const report = {
  schema_version: 1,
  revision: REV,
  generated_from_commit: git(["rev-parse", REV]).trim(),
  working_tree_modified: git(["status", "--porcelain"]).trim().length > 0,
  method:
    "git blame -w -M -C over the swarm closure; each surviving line credited to the commit that last wrote it. Lines rewritten after the window count AGAINST the window, so the Qoder share is a lower bound.",
  qoder_window: QODER_WINDOW,
  total,
  groups,
  commits: [...perCommit.values()].sort((a, b) => b.lines - a.lines),
};

mkdirSync(path.join(repo, "docs/evidence"), { recursive: true });
const suffix = REV === "HEAD" ? "" : `-at-${report.generated_from_commit.slice(0, 8)}`;
const jsonPath = path.join(repo, `docs/evidence/core-attribution${suffix}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(2) : "0.00");
const md = [
  "# Swarm core — line attribution census",
  "",
  `Census taken at \`${report.generated_from_commit.slice(0, 8)}\`${REV === "HEAD" ? " (HEAD)" : ` (${REV})`}.`,
  `Re-run with \`node scripts/evidence/core-attribution.mjs\`.`,
  "",
  "## Method",
  "",
  report.method,
  "",
  `Qoder Quest window: **${QODER_WINDOW.from} → ${QODER_WINDOW.to}**. Every commit that touched`,
  "the core is listed below with its date, so the boundary can be moved and the numbers recomputed.",
  "",
  "## Result",
  "",
  "| Group | Files | Surviving lines | Before window | Qoder window | After window | Qoder share |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...Object.entries(groups).map(
    ([g, t]) =>
      `| ${g} | ${t.files} | ${t.lines} | ${t.before} | ${t.qoder_window} | ${t.after} | **${t.qoder_pct}%** |`,
  ),
  `| **core total** | **${total.files}** | **${total.lines}** | ${total.before} | ${total.qoder_window} | ${total.after} | **${total.qoder_pct}%** |`,
  "",
  "## Commits touching the core",
  "",
  "| Commit | Date | Author | Surviving lines | Share | Bucket |",
  "|---|---|---|---:|---:|---|",
  ...report.commits.map(
    (c) =>
      `| \`${c.sha}\` | ${c.date} | ${c.author} | ${c.lines} | ${pct(c.lines, total.lines)}% | ${c.bucket} |`,
  ),
  "",
].join("\n");
writeFileSync(path.join(repo, `docs/evidence/core-attribution${suffix}.md`), md);

console.log(md.split("## Commits touching the core")[0]);
console.log(`Wrote docs/evidence/core-attribution${suffix}.{json,md}`);
