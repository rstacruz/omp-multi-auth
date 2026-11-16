import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "multi-auth.ts");

async function runCapture(model) {
	const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-opencode-go-"));
	const capturePath = join(agentDir, "capture.json");
	const captureExtension = join(agentDir, "capture.ts");
	let child;
	let childClosed;
	try {
		const bootstrap = spawnSync(
			"omp",
			["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"],
			{
				cwd: root,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				input: '{"id":"bootstrap","type":"get_available_models"}\n',
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				timeout: 30_000,
			},
		);
		assert.equal(bootstrap.status, 0, bootstrap.stderr);

		const db = new DatabaseSync(join(agentDir, "agent.db"));
		db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'api_key', ?, NULL)",
		).run("opencode-go-1", JSON.stringify({ key: "oc_sk_test_key" }));
		db.close();

		writeFileSync(
			join(agentDir, "multi-auth.json"),
			JSON.stringify({ subscriptions: [{ provider: "opencode-go", index: 1 }], presets: [] }),
		);
		writeFileSync(
			captureExtension,
			`import { writeFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = init?.headers ?? {};
  const headers = raw instanceof Headers ? Object.fromEntries(raw.entries()) : raw;
  writeFileSync(process.env.MP_CAPTURE, JSON.stringify({ url: String(input), headers }));
  setTimeout(() => process.exit(0), 25);
  return originalFetch("data:,", { headers: { "content-type": "text/event-stream" } });
};
export default function capture() {}
`,
		);
		child = spawn(
			"omp",
			[
				"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session",
				"--model", model,
				"--extension", extension,
				"--extension", captureExtension,
			],
			{ cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MP_CAPTURE: capturePath } },
		);
		childClosed = new Promise((resolve) => child.once("close", resolve));
		const stdout = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		const stderr = [];
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.stdin.write('{"id":"capture","type":"prompt","message":"say hi"}\n');
		for (let i = 0; i < 300 && !existsSync(capturePath); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (!existsSync(capturePath)) {
			throw new Error(`request hook did not fire\nstdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`);
		}
		return JSON.parse(readFileSync(capturePath, "utf8"));
	} finally {
		if (child && child.exitCode === null) child.kill("SIGTERM");
		if (childClosed) await childClosed;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const KEY = "oc_sk_test_key";
const ORIGIN = "https://opencode.ai";

// Anthropic swaps bearer auth for X-Api-Key
const CASES = [
	{ model: "claude-haiku-5-5", pathname: "/inference/go/v1/messages", apiKeyHeader: "x-api-key" },
	{ model: "deepseek-v4.1-flash", pathname: "/inference/go/v1/chat/completions", bearer: true },
	{ model: "grok-4.6", pathname: "/inference/go/v1/responses", bearer: true },
	{ model: "gemini-4-argon", pathname: "/inference/go/v1/models/gemini-4-argon:streamGenerateContent", apiKeyHeader: "x-goog-api-key" },
];

for (const testCase of CASES) {
	const capture = await runCapture(`opencode-go-1/${testCase.model}`);
	const url = new URL(capture.url);
	assert.equal(url.origin, ORIGIN, testCase.model);
	assert.equal(url.pathname, testCase.pathname, testCase.model);

	const headers = {};
	for (const [name, value] of Object.entries(capture.headers)) headers[name.toLowerCase()] = value;
	assert.ok(headers["x-opencode-session"], "x-opencode-session present");
	if (testCase.bearer) {
		assert.equal(headers.authorization, `Bearer ${KEY}`, testCase.model);
	} else {
		assert.equal(headers[testCase.apiKeyHeader], KEY, testCase.model);
		assert.equal(headers.authorization, undefined, "no bearer auth on api-key dialects");
	}
	console.log(`${testCase.model} -> ${url.pathname}`);
}
console.log("OpenCode Go routing check passed");
