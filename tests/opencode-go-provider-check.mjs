import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-opencode-go-"));

// Mirrors omp's bundled opencode-go catalog
const DIALECT_MODELS = ["beam-free", "grok-4.6", "claude-haiku-5-5", "gemini-4-argon"];
const MODEL_COUNT = 55;
const ACCOUNT_INDICES = [1, 2];

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
	assert.equal(bootstrap.error, undefined, bootstrap.error?.message);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);

	const db = new DatabaseSync(join(agentDir, "agent.db"));
	const insert = db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'api_key', ?, NULL)",
	);
	for (const index of ACCOUNT_INDICES) {
		insert.run(`opencode-go-${index}`, JSON.stringify({ key: "test-key" }));
	}
	db.close();

	writeFileSync(
		join(agentDir, "multi-auth.json"),
		JSON.stringify({
			subscriptions: ACCOUNT_INDICES.map((index) => ({ provider: "opencode-go", index })),
			presets: [],
		}),
	);

	const child = spawn(
		"omp",
		[
			"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules",
			"--no-lsp", "--no-session", "--extension", join(root, "extensions", "multi-auth.ts"),
		],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			timeout: 30_000,
		},
	);
	const stdout = [];
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	let resolveModels;
	const modelsResponse = new Promise((resolve) => (resolveModels = resolve));
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		stdout.push(line);
		try {
			const event = JSON.parse(line);
			if (event.id === "models") resolveModels(event);
		} catch {}
	});
	child.stdin.write('{"id":"models","type":"get_available_models"}\n');
	const response = await modelsResponse;
	child.stdin.end();
	const exitCode = await new Promise((resolve) => child.once("close", resolve));
	const rawStdout = stdout.join("\n");
	const rawStderr = Buffer.concat(stderr).toString();
	assert.equal(exitCode, 0, rawStderr);
	assert.doesNotMatch(rawStdout, /"type":"extension_error"/, rawStdout);
	assert.equal(response.success, true);

	const models = response.data.models;
	for (const index of ACCOUNT_INDICES) {
		const provider = `opencode-go-${index}`;
		const providerModels = models.filter((model) => model.provider === provider);
		assert.equal(providerModels.length, MODEL_COUNT, `${provider} model count`);
		assert.ok(providerModels.every((model) => model.api === "opencode-go-mp"), `${provider} routes through the wrapper`);
		for (const id of DIALECT_MODELS) {
			assert.ok(providerModels.some((model) => model.id === id), `${provider} exposes ${id}`);
		}
		console.log(`${provider} models: ${providerModels.length}`);
	}
	console.log("OpenCode Go provider check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
