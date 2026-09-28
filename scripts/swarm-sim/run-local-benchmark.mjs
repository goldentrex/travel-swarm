/** Reproducible fixture regression benchmark. No live providers or local env files. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporary = mkdtempSync(join(tmpdir(), "swarm-benchmark-"));
const rawPath = join(temporary, "vitest.json");
const started = Date.now();
const execution = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.benchmark.config.ts",
    "--reporter=json",
    `--outputFile=${rawPath}`,
  ],
  { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
);
let raw;
try {
  raw = JSON.parse(readFileSync(rawPath, "utf8"));
} catch {
  console.error("Benchmark did not produce a result. Inspect the local runner output:");
  console.error(execution.error?.message ?? execution.stderr ?? "Unknown runner failure");
  process.exit(1);
}
const cases = raw.testResults.flatMap((suite) =>
  suite.assertionResults.map((test) => ({
    suite: relative(root, suite.name),
    name: test.fullName,
    status: test.status,
    duration_ms: test.duration ?? null,
    failures: test.failureMessages,
  })),
);
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim();
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  environment: "offline fixtures",
  source_commit: git("rev-parse", "HEAD") || null,
  working_tree_modified: Boolean(git("status", "--porcelain")),
  passed: execution.status === 0 && raw.success === true && cases.length > 0,
  elapsed_ms: Date.now() - started,
  counts: {
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    other: cases.filter((c) => !["passed", "failed"].includes(c.status)).length,
  },
  measurements_not_collected: [
    "live supplier latency",
    "live token consumption",
    "monetary model cost",
    "user preference satisfaction",
  ],
  limitations: [
    "Durations measure local fixture tests, not production mission latency.",
    "Model responses and supplier responses are controlled fixtures.",
    "Passing assertions establish their named invariants, not universal recovery quality.",
    "This is regression evidence, not Qoder authorship evidence.",
  ],
  cases,
};
const destination = join(root, "docs/evidence");
mkdirSync(destination, { recursive: true });
writeFileSync(
  join(destination, "local-benchmark-latest.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const lines = [
  "# Local Swarm regression benchmark",
  "",
  `Generated: ${report.generated_at}`,
  "",
  `Environment: **${report.environment}**. Source: ${report.source_commit}; modified working tree: ${report.working_tree_modified}.`,
  "",
  `Result: **${report.passed ? "PASS" : "FAIL"}** — ${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.other} other.`,
  "",
  "Run again: `npm run benchmark:swarm`.",
  "",
  "## Scope and limits",
  "",
  ...report.limitations.map((text) => `- ${text}`),
  "- Live costs and model savings are not measured by this run.",
  "",
  "## Cases",
  "",
  ...cases.map(
    (test) =>
      `- ${test.status === "passed" ? "PASS" : test.status.toUpperCase()}: ${test.name.replaceAll("\n", " ")}`,
  ),
  "",
];
writeFileSync(join(destination, "local-benchmark-latest.md"), lines.join("\n"));
console.log(
  `${report.passed ? "PASS" : "FAIL"}: ${report.counts.passed}/${cases.length} local fixture checks.`,
);
console.log("Reports: docs/evidence/local-benchmark-latest.{json,md}");
process.exit(report.passed ? 0 : 1);
