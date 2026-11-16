// Harness loaded inside omp: stubs fetch and exercises the OpenCode Go quota checker.
import { writeFileSync } from "node:fs";
import {
	formatCurrentModelQuota,
	opencodeGoQuotaChecker,
	parseOpenCodeUsageSnapshot,
} from "../extensions/lib/quota.ts";

// Captured from GET https://opencode.ai/inference/go/v1/usage. percent is used, not remaining.
const FIXTURE = {
	usage: {
		rolling: { status: "ok", percent: 6, resetsAt: "2026-11-16T02:09:48.000Z" },
		weekly: { status: "ok", percent: 54, resetsAt: "2026-11-16T00:00:00.000Z" },
		monthly: { status: "ok", percent: 86, resetsAt: "2026-11-29T10:08:51.000Z" },
	},
};

// Only the weekly window has a usable percent, so the malformed siblings must drop out.
const MALFORMED = {
	usage: {
		rolling: { status: "ok" },
		weekly: { status: "ok", percent: 54, resetsAt: "2026-11-22T00:00:00.000Z" },
		monthly: { status: "ok", percent: "n/a" },
	},
};

const RATE_LIMITED = {
	usage: {
		weekly: { status: "ok", percent: 40, resetsAt: "2026-11-22T00:00:00.000Z" },
		monthly: { status: "rate-limited", percent: 1, resetsAt: "2026-11-29T10:08:51.000Z" },
	},
};

// An exhausted window may arrive without a percent; it must still count as blocked.
const RATE_LIMITED_NO_PERCENT = {
	usage: { monthly: { status: "rate-limited", resetsAt: "2026-11-29T10:08:51.000Z" } },
};

// An unrecognized status must drop the window rather than report false headroom.
const UNKNOWN_STATUS = {
	usage: { weekly: { status: "exhausted", percent: 99, resetsAt: "2026-11-22T00:00:00.000Z" } },
};

const EMPTY = { usage: {} };

const account = {
	providerName: "opencode-go-1",
	baseProvider: "opencode-go",
	displayName: "work",
	auth: { type: "api_key", key: "oc_sk_test" },
};

const model = { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "opencode-go-1" };

export default async function () {
	const responses = [
		{ status: 200, body: FIXTURE },
		{ status: 401, body: { error: { message: "invalid key" } } },
		{ status: 200, body: EMPTY },
		{ status: 200, body: RATE_LIMITED },
		{ status: 200, body: RATE_LIMITED_NO_PERCENT },
	];
	const requests = [];
	globalThis.fetch = async (input, init) => {
		requests.push({
			url: String(input),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
		});
		const next = responses.shift() ?? { status: 500, body: {} };
		return new Response(JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	};
	const check = () => opencodeGoQuotaChecker.check(account, {} as never);

	const snapshot = parseOpenCodeUsageSnapshot(FIXTURE);
	const ok = await check();
	const denied = await check();
	const empty = await check();
	const limited = await check();
	const limitedNoPercent = await check();
	const missing = await opencodeGoQuotaChecker.check({ ...account, auth: undefined }, {} as never);

	writeFileSync(
		process.env.MP_USAGE_OUT ?? "",
		JSON.stringify({
			requests,
			snapshot,
			malformed: parseOpenCodeUsageSnapshot(MALFORMED),
			unknownStatus: parseOpenCodeUsageSnapshot(UNKNOWN_STATUS),
			ok,
			statusLine: formatCurrentModelQuota(ok, model),
			denied,
			empty,
			limited,
			limitedStatusLine: formatCurrentModelQuota(limited, model),
			limitedNoPercent,
			missing,
		}),
	);
	setTimeout(() => process.exit(0), 0);
}
