import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "tests", "opencode-go-usage-harness.ts");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-opencode-usage-"));
const outputPath = join(agentDir, "usage.json");

let child;
let childClosed;
try {
	child = spawn(
		"omp",
		[
			"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session",
			"--extension", harness,
		],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MP_USAGE_OUT: outputPath },
		},
	);
	childClosed = new Promise((resolve) => child.once("close", resolve));
	const stdout = [];
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk));

	let timer;
	try {
		const outcome = await Promise.race([
			childClosed.then(() => "closed"),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve("timeout"), 30_000);
			}),
		]);
		assert.equal(outcome, "closed", `usage harness did not exit\nstdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`);
	} finally {
		clearTimeout(timer);
	}

	const rawStderr = Buffer.concat(stderr).toString();
	assert.equal(child.exitCode, 0, rawStderr);
	assert.doesNotMatch(rawStderr, /Failed to load extension/, rawStderr);
	assert.equal(existsSync(outputPath), true, `usage harness wrote no output\nstdout: ${Buffer.concat(stdout).toString()}\nstderr: ${rawStderr}`);

	const data = JSON.parse(readFileSync(outputPath, "utf8"));

	const request = data.requests[0];
	assert.equal(request.url, "https://opencode.ai/inference/go/v1/usage");
	assert.equal(request.headers.authorization, "Bearer oc_sk_test");
	assert.equal(request.headers.accept, "application/json");
	assert.equal(request.headers["user-agent"], "omp-multi-auth");
	assert.match(request.headers["x-opencode-session"], /\S+/);

	// percent is used, so the reported remainder is inverted.
	assert.equal(data.snapshot.rolling.usedPercent, 6);

	assert.equal(data.ok.kind, "low");
	assert.equal(data.ok.summary, "5h 94% | 7d 46% | mo 14% | low");
	assert.equal(data.ok.score, 14);
	assert.deepEqual(data.ok.details.slice(0, 3), [
		"account: work",
		"provider: opencode-go-1",
		"status: low",
	]);
	assert.match(data.ok.details[3], /^5-hour window: 94% left, resets /);
	assert.match(data.ok.details[4], /^7-day window: 46% left, resets /);
	assert.match(data.ok.details[5], /^monthly window: 14% left, resets .+ \(anniversary anchor\)$/);
	assert.equal(data.ok.details[6], "endpoint: https://opencode.ai/inference/go/v1/usage");
	assert.equal(data.ok.opencodeSnapshot.monthly.usedPercent, 86);

	// Status line shows the worst window, using the short "mo" label.
	assert.match(data.statusLine, /^mo 14% /);

	// The fixture's malformed windows are dropped instead of crashing the parser.
	assert.equal("rolling" in data.malformed, false);
	assert.equal("monthly" in data.malformed, false);
	assert.equal(data.malformed.weekly.usedPercent, 54);

	// A rate-limited window blocks even with room left, and it must be the one displayed.
	assert.equal(data.limited.kind, "blocked");
	assert.equal(data.limited.summary, "7d 60% | mo 99% | blocked");
	assert.match(data.limitedStatusLine, /^mo 99% .* limited$/);
	const monthlyDetail = data.limited.details.find((detail) => detail.startsWith("monthly window:"));
	assert.match(monthlyDetail, /^monthly window: 99% left \(rate limited\), resets .+ \(anniversary anchor\)$/);

	// An exhausted window without a percent is fully used, not silently dropped.
	assert.equal(data.limitedNoPercent.kind, "blocked");
	assert.equal(data.limitedNoPercent.summary, "mo 0% | blocked");
	const sparseDetail = data.limitedNoPercent.details.find((detail) => detail.startsWith("monthly window:"));
	assert.match(sparseDetail, /^monthly window: 0% left \(rate limited\), resets /);

	assert.equal(data.denied.kind, "error");
	assert.equal(data.denied.summary, "Unauthorized - log in again");
	assert.equal(data.denied.score, 0);
	assert.equal(data.empty.kind, "error");
	assert.equal(data.empty.summary, "OpenCode Go usage response contained no quota windows");
	assert.equal(data.missing.kind, "missing-auth");
	assert.equal(data.missing.summary, "not logged in");

	console.log("OpenCode Go usage checks passed");
} finally {
	if (child && child.exitCode === null) child.kill("SIGTERM");
	if (childClosed) await childClosed;
	rmSync(agentDir, { recursive: true, force: true });
}
