// 点卯：主会话定时清点小工（task 子代理），两种情况报到主会话：
// 1. 卡住：最后一条对话消息 STALL_MIN 分钟没更新（通常是命令挂住或模型不回）。
// 2. 空转：一直在动但没进展；每 SPIN_MIN 分钟把这段时间的操作摘要交给 SubQ 判断。
// 只观察和报告；重试、催办、换人由主会话决定。
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { basename, join } from "node:path";
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

// 发给 SubQ 的只有这些：不含原始命令、路径、正文。argsHash 只用来看出"参数是否相同"。
export type Op = { at: number; name: string; intent: string; argsHash: string; status?: "ok" | "error"; secs?: number };
// toolTimeoutSec：还没返回的工具调用里最长的显式 timeout（0 = 没有）
export type Roll = { lastMessageAt: number; finished: boolean; ops: Op[]; toolTimeoutSec: number };
type Part = { type?: unknown; id?: unknown; name?: unknown; intent?: unknown; arguments?: { timeout?: unknown; i?: unknown } };
// 只读可选字段并按值比较，形状不对的条目被跳过
type Entry = {
	type?: unknown;
	customType?: unknown;
	timestamp?: unknown;
	message?: { role?: unknown; stopReason?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
};

/** 解析对话记录尾部：最后一条消息时间、是否已收工、操作摘要、未返回工具的超时豁免。 */
export function rollCall(lines: string[]): Roll {
	let lastMessageAt = 0;
	let finished = false;
	const ops: Op[] = [];
	const pending = new Map<string, { op: Op; timeout: number }>();
	for (const line of lines) {
		let e: Entry | null;
		try { e = JSON.parse(line) as Entry | null; } catch { continue; }
		if (!e || typeof e !== "object") continue;
		const at = Date.parse(String(e.timestamp)) || 0;
		if (e.type === "custom" && e.customType === "session_exit") finished = true;
		const m = e.message;
		if (e.type !== "message" || !m || typeof m !== "object") continue;
		lastMessageAt = at;
		// 交了最终回复、被取消或报错停下的，都不算在岗
		finished = m.role === "assistant" && ["stop", "aborted", "error"].includes(String(m.stopReason));
		if (m.role === "toolResult") {
			const p = pending.get(String(m.toolCallId));
			pending.delete(String(m.toolCallId));
			if (p) {
				p.op.status = m.isError === true ? "error" : "ok";
				p.op.secs = Math.round((at - p.op.at) / 1000);
			}
			continue;
		}
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content as (Part | null)[]) {
			if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
			const { i: _intent, ...args } = part.arguments ?? {};
			const op: Op = {
				at,
				name: String(part.name),
				intent: String(part.intent ?? "").slice(0, 60),
				argsHash: Bun.hash(JSON.stringify(args)).toString(36).slice(0, 6),
			};
			ops.push(op);
			pending.set(String(part.id), { op, timeout: Number(part.arguments?.timeout) || 0 });
		}
	}
	const toolTimeoutSec = Math.max(0, ...[...pending.values()].map(p => p.timeout));
	return { lastMessageAt, finished, ops, toolTimeoutSec };
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
export async function progressProbability(ops: Op[], fetchImpl = fetch): Promise<number | undefined> {
	const key = subqKey();
	if (!key) return undefined;
	const lines = ops.map(o => `${o.name} args#${o.argsHash} ${o.status ?? "running"}${o.secs === undefined ? "" : ` ${o.secs}s`} — ${o.intent}`);
	const res = await fetchImpl(SUBQ_ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "subq-snap-preview",
			state: `A coding sub-agent's last ${ops.length} tool calls in order. Format: tool args#<fingerprint, equal fingerprint = identical arguments> <ok|error|running> <duration> — <agent's stated intent>\n${lines.join("\n")}`,
			questions: {
				progress: {
					type: "noul",
					instructions:
						"Do these calls show verifiable forward progress (varied edits, errors turning into successes, new findings) rather than spinning (same fingerprints repeated, the same call failing again and again, re-reading without acting)?",
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

type AlertCard = {
	kind: "stall" | "spin";
	name: string;
	evidence: string;
	lastStep?: string;
	file: string;
};

export default function dianmao(pi: ExtensionAPI) {
	pi.registerMessageRenderer<AlertCard>("dianmao", (message, { expanded }, theme) => {
		const alert = message.details;
		if (!alert || !["stall", "spin"].includes(alert.kind)) return undefined;
		const title = alert.kind === "stall" ? "疑似卡住" : "疑似空转";
		const suggestion = alert.kind === "stall"
			? "查看小工状态与最后一次工具调用，确认是否正在等待长任务。"
			: "核对最近操作是否有新结果，再决定是否调整任务。";
		const lines = [
			theme.fg("warning", `点卯 · ${title}`),
			`${alert.name} · ${alert.evidence}`,
		];
		if (alert.lastStep) lines.push(`最后操作  ${alert.lastStep}`);
		lines.push("", `建议  ${suggestion}`, theme.fg("dim", `记录  ${expanded ? alert.file : basename(alert.file)}`));
		if (!expanded) lines.push(theme.fg("dim", "展开详情可查看完整路径"));
		return new Text(lines.join("\n"), 0, 0);
	});
	const reported = new Map<string, number>(); // 名字 -> 已报过的最后消息时间，同一次卡住只报一次
	// 名字 -> 当前空转观察窗口的起点。第一次看到就开始计时，不跟着日志尾部滑动
	const windowStart = new Map<string, number>();

	function tick(dir: string, currentDir: () => string | null) {
		const now = Date.now();
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl") || f.startsWith("__")) continue;
			const name = f.slice(0, -6);
			const file = join(dir, f);
			const done = join(dir, `${name}.md`);
			let roll: Roll;
			// 单个记录读失败（刚被移走、权限）只跳过它，下一轮再看
			try {
				if (now - statSync(file).mtimeMs > WINDOW_MIN * MIN) continue;
				roll = rollCall(tailLines(file));
				if (existsSync(done) && statSync(done).mtimeMs >= roll.lastMessageAt) continue;
			} catch { continue; }
			if (roll.finished || !roll.lastMessageAt) continue;

			const idle = Math.floor((now - roll.lastMessageAt) / MIN);
			// 正在跑显式设了长 timeout 的命令，等它自己的截止时间过了再算卡住
			const limit = Math.max(STALL_MIN, roll.toolTimeoutSec > 0 ? Math.ceil(roll.toolTimeoutSec / 60) + 2 : 0);
			if (idle >= limit) {
				if (reported.get(name) !== roll.lastMessageAt) {
					reported.set(name, roll.lastMessageAt);
					const last = roll.ops.at(-1);
					const step = last ? `${last.name}（${last.intent || "无说明"}）` : "（无工具调用，可能是模型没回）";
					pi.sendMessage(
						{
							customType: "dianmao",
							content: `[点卯] 小工 ${name} 已 ${idle} 分钟没有新消息，可能卡住了。最后一步：${step}。对话记录：${file}`,
							display: true,
							details: { kind: "stall", name, evidence: `${idle} 分钟无新消息`, lastStep: step, file } satisfies AlertCard,
						},
						{ deliverAs: "aside" },
					);
				}
				continue;
			}

			const since = windowStart.get(name) ?? now;
			windowStart.set(name, since);
			if (now - since < SPIN_MIN * MIN) continue;
			const fresh = roll.ops.filter(o => o.at >= since);
			if (fresh.length < SPIN_MIN_OPS) continue;
			windowStart.set(name, now);
			const mins = Math.round((now - since) / MIN);
			// 后台问 SubQ，不拖住其他小工的卡住检查；失败本窗口不重试
			progressProbability(fresh.slice(-40))
				.then(p => {
					if (p === undefined || p >= SPIN_THRESHOLD) return;
					// 等回答期间可能换了会话、小工收工、或已开始下一个窗口：旧结论作废
					if (currentDir() !== dir || windowStart.get(name) !== now) return;
					const latest = rollCall(tailLines(file));
					if (latest.finished || (existsSync(done) && statSync(done).mtimeMs >= latest.lastMessageAt)) return;
					pi.sendMessage(
						{
							customType: "dianmao",
							content: `[点卯] 小工 ${name} 最近 ${mins} 分钟做了 ${fresh.length} 次操作，SubQ 判断有进展的概率只有 ${(p * 100).toFixed(0)}%，可能在空转。对话记录：${file}`,
							display: true,
							details: { kind: "spin", name, evidence: `${mins} 分钟 · ${fresh.length} 次操作 · SubQ 估计进展概率 ${(p * 100).toFixed(0)}%`, file } satisfies AlertCard,
						},
						{ deliverAs: "aside" },
					);
				})
				.catch(() => {});
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const currentDir = () => ctx.sessionManager.getArtifactsDir();
		ctx.setInterval(() => {
			const dir = currentDir();
			if (dir && existsSync(dir)) tick(dir, currentDir);
		}, POLL_MS);
	});
}
