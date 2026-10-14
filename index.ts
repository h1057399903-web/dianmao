// 点卯：主会话定时清点小工（task 子代理），两种情况报到主会话：
// 1. 卡住：最后一条对话消息 STALL_MIN 分钟没更新（通常是命令挂住或模型不回）。
// 2. 空转：一直在动但没进展；每 SPIN_MIN 分钟把新增操作摘要交给 SubQ 判断。
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";

const MIN = 60_000;
const num = (k: string, d: number) => Number(process.env[k]) || d;
const STALL_MIN = num("DIANMAO_STALL_MIN", 20);
const WINDOW_MIN = num("DIANMAO_WINDOW_MIN", 360);
const SPIN_MIN = num("DIANMAO_SPIN_MIN", 30);
const SPIN_MIN_OPS = num("DIANMAO_SPIN_MIN_OPS", 10);
const SPIN_THRESHOLD = num("DIANMAO_SPIN_THRESHOLD", 0.2);
const POLL_MS = num("DIANMAO_POLL_SEC", 60) * 1000;
const TAIL_BYTES = 512 * 1024;
const SUBQ_ENDPOINT = "https://api.subq.ai/v1/systemone";

export type Op = { at: number; text: string };
export type Roll = { lastMessageAt: number; finished: boolean; ops: Op[] };
// 只读可选字段并按值比较，形状不对的条目自然被忽略
type Entry = {
	type?: string;
	customType?: string;
	timestamp?: string;
	data?: { toolName?: string; intent?: string; args?: unknown };
	message?: { role?: string; stopReason?: string };
};

/** 解析对话记录尾部：最后一条消息时间、是否已收工、工具操作摘要。 */
export function rollCall(lines: string[]): Roll {
	let lastMessageAt = 0;
	let finished = false;
	const ops: Op[] = [];
	for (const line of lines) {
		let e: Entry;
		try { e = JSON.parse(line) as Entry; } catch { continue; }
		const at = Date.parse(String(e.timestamp)) || 0;
		if (e.type === "custom" && e.customType === "session_exit") finished = true;
		if (e.type === "custom" && e.customType === "tool_execution_start") {
			const d = e.data ?? {};
			ops.push({ at, text: `${d.toolName}: ${d.intent ?? ""} ${JSON.stringify(d.args ?? {}).slice(0, 160)}` });
		}
		if (e.type !== "message") continue;
		lastMessageAt = at;
		const m = e.message ?? {};
		// 交了最终回复、被取消或报错停下的，都不算在岗
		finished = m.role === "assistant" && ["stop", "aborted", "error"].includes(String(m.stopReason));
	}
	return { lastMessageAt, finished, ops };
}

function tailLines(file: string): string[] {
	const size = statSync(file).size;
	const len = Math.min(size, TAIL_BYTES);
	const buf = Buffer.alloc(len);
	const fd = openSync(file, "r");
	try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
	const lines = buf.toString("utf8").split("\n");
	if (len < size) lines.shift(); // 截断出来的半行
	return lines.filter(Boolean);
}

let cachedKey: string | undefined;
function subqKey(): string {
	if (cachedKey !== undefined) return cachedKey;
	cachedKey = process.env.SUBQ_API_KEY?.trim() ?? "";
	if (!cachedKey) {
		// 跟 subq-snap MCP 共用同一个钥匙串条目
		const r = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-a", userInfo().username, "-s", "omp-subq-snap", "-w"]);
		cachedKey = r.exitCode === 0 ? r.stdout.toString().trim() : "";
	}
	return cachedKey;
}

/** SubQ 给出“有可核对进展”的概率；拿不到返回 undefined。 */
export async function progressProbability(name: string, ops: Op[], fetchImpl = fetch): Promise<number | undefined> {
	const key = subqKey();
	if (!key) return undefined;
	const res = await fetchImpl(SUBQ_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "subq-snap-preview",
			state: `Coding sub-agent "${name}", its last ${ops.length} tool operations in order:\n${ops.map(o => o.text).join("\n")}`,
			questions: {
				progress: {
					type: "noul",
					instructions:
						"Do these operations show verifiable forward progress (new edits, new files, tests run with changing results, new findings) rather than spinning (re-reading the same files, repeating near-identical searches or commands)?",
				},
			},
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`SubQ HTTP ${res.status}`);
	const body = (await res.json()) as { answers?: { progress?: { noul?: unknown } } };
	const p = body.answers?.progress?.noul;
	return typeof p === "number" ? p : undefined;
}

export default function dianmao(pi: ExtensionAPI) {
	const reported = new Map<string, number>(); // 名字 -> 已报过的最后消息时间，同一次卡住只报一次
	const spunAt = new Map<string, number>(); // 名字 -> 上次交给 SubQ 时的时间点
	let busy = false;

	async function tick(dir: string) {
		const now = Date.now();
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl") || f.startsWith("__")) continue;
			const name = f.slice(0, -6);
			const file = join(dir, f);
			if (existsSync(join(dir, `${name}.md`))) continue;
			if (now - statSync(file).mtimeMs > WINDOW_MIN * MIN) continue;
			const roll = rollCall(tailLines(file));
			if (roll.finished || !roll.lastMessageAt) continue;

			const idle = Math.floor((now - roll.lastMessageAt) / MIN);
			if (idle >= STALL_MIN) {
				if (reported.get(name) !== roll.lastMessageAt) {
					reported.set(name, roll.lastMessageAt);
					pi.sendMessage(
						{ customType: "dianmao", content: `[点卯] 小工 ${name} 已 ${idle} 分钟没有新消息，可能卡住了。对话记录：${file}`, display: true },
						{ deliverAs: "aside" },
					);
				}
				continue;
			}

			const since = spunAt.get(name) ?? roll.ops[0]?.at ?? now;
			if (now - since < SPIN_MIN * MIN) continue;
			const fresh = roll.ops.filter(o => o.at >= since);
			if (fresh.length < SPIN_MIN_OPS) continue;
			spunAt.set(name, now);
			// SubQ 失败不影响下一次卡住检查；本窗口不重试
			const p = await progressProbability(name, fresh.slice(-40)).catch(() => undefined);
			if (p !== undefined && p < SPIN_THRESHOLD) {
				const mins = Math.round((now - since) / MIN);
				pi.sendMessage(
					{ customType: "dianmao", content: `[点卯] 小工 ${name} 最近 ${mins} 分钟做了 ${fresh.length} 次操作，SubQ 判断有进展的概率只有 ${(p * 100).toFixed(0)}%，可能在空转。对话记录：${file}`, display: true },
					{ deliverAs: "aside" },
				);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.setInterval(async () => {
			const dir = ctx.sessionManager.getArtifactsDir();
			if (busy || !dir || !existsSync(dir)) return;
			busy = true;
			try { await tick(dir); } finally { busy = false; }
		}, POLL_MS);
	});
}
