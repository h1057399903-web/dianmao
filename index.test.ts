import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dianmao, { progressProbability, rollCall } from "./index.ts";

process.env.SUBQ_API_KEY = "test-key";
const realFetch = globalThis.fetch;
afterEach(() => {
	setSystemTime();
	globalThis.fetch = realFetch;
});

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const call = (at: number, id: string, args: Record<string, unknown> = { command: "make" }) =>
	JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash", intent: "跑构建", arguments: args }] } });
const result = (at: number, id: string, isError = false) =>
	JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "toolResult", toolCallId: id, isError } });
const final = (at: number, stopReason: string) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "assistant", stopReason, content: [] } });

/** 用真实默认导出跑巡检：返回发出的报警和手动触发一轮的函数。 */
function patrol(dir: string) {
	const sent: string[] = [];
	let tick = () => {};
	const ctx = { sessionManager: { getArtifactsDir: () => dir }, setInterval: (fn: () => void) => { tick = fn; } };
	const pi = {
		on: (_ev: string, h: (e: unknown, c: unknown) => void) => h({}, ctx),
		sendMessage: (m: { content: string }) => sent.push(m.content),
		registerMessageRenderer: () => {},
	};
	dianmao(pi as unknown as Parameters<typeof dianmao>[0]); // 测试替身只实现巡检用到的方法
	return { sent, tick: () => tick() };
}
// SubQ 是后台发出的、不对外暴露 promise；等事件循环跑完这一轮的回调链（不按时长猜）
function settle() {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

test("收工判定：最终回复、取消、报错、session_exit；收工后再被唤醒算在岗", () => {
	for (const s of ["stop", "aborted", "error"]) expect(rollCall([final(0, s)]).finished).toBe(true);
	expect(rollCall([result(0, "a"), JSON.stringify({ type: "custom", customType: "session_exit", timestamp: iso(1) })]).finished).toBe(true);
	const woke = JSON.stringify({ type: "message", timestamp: iso(2), message: { role: "user" } });
	expect(rollCall([final(0, "stop"), woke]).finished).toBe(false);
});

test("超时豁免只对还没返回的调用生效；返回后恢复", () => {
	const t = Date.parse("2026-10-14T10:00:00Z");
	expect(rollCall([call(t, "a", { command: "x", timeout: 7200 })]).toolTimeoutSec).toBe(7200);
	expect(rollCall([call(t, "a", { command: "x", timeout: 7200 }), result(t + MIN, "a")]).toolTimeoutSec).toBe(0);
});

test("坏行（null、半行、content 里的空项）跳过，不抛错", () => {
	const nullPart = JSON.stringify({ type: "message", timestamp: iso(5), message: { role: "assistant", stopReason: "toolUse", content: [null, 3] } });
	const r = rollCall(["null", "{半行", "[]", nullPart, call(10, "a"), result(20, "a", true)]);
	expect(r.ops).toHaveLength(1);
	expect(r.ops[0]).toMatchObject({ name: "bash", status: "error", secs: 0 });
});

test("发给 SubQ 的内容不含原始参数，相同参数指纹相同", async () => {
	let body = "";
	const fake = (async (_u: unknown, init: { body: string }) => {
		body = init.body;
		return new Response(JSON.stringify({ answers: { progress: { noul: 0.3 } } }));
	}) as unknown as typeof fetch;
	const ops = rollCall([call(0, "a", { command: "cat ~/.secret-token" }), call(1, "b", { command: "cat ~/.secret-token" })]).ops;
	expect(await progressProbability(ops, fake)).toBe(0.3);
	expect(body).not.toContain("secret-token");
	expect(ops[0].argsHash).toBe(ops[1].argsHash);
	const fail = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
	await expect(progressProbability(ops, fail)).rejects.toThrow("SubQ HTTP 500");
});

test("巡检：长工具已返回后按默认 20 分钟报卡住；仍在跑的长工具不报", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const now = Date.now();
	writeFileSync(join(dir, "Returned.jsonl"), [call(now - 30 * MIN, "a", { command: "x", timeout: 7200 }), result(now - 25 * MIN, "a")].join("\n"));
	writeFileSync(join(dir, "Running.jsonl"), call(now - 30 * MIN, "a", { command: "x", timeout: 7200 }));
	const { sent, tick } = patrol(dir);
	tick();
	tick();
	expect(sent).toHaveLength(1); // 同一次卡住只报一次
	expect(sent[0]).toContain("Returned");
});

test("巡检：坏记录和消失的文件不影响其他小工", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const now = Date.now();
	writeFileSync(join(dir, "A-Bad.jsonl"), "null\n[1]\n");
	symlinkSync(join(dir, "nowhere"), join(dir, "B-Gone.jsonl"));
	writeFileSync(join(dir, "C-Stuck.jsonl"), call(now - 25 * MIN, "a"));
	writeFileSync(join(dir, "D-Done.jsonl"), call(now - 25 * MIN, "a"));
	writeFileSync(join(dir, "D-Done.md"), "ok");
	const { sent, tick } = patrol(dir);
	tick();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("C-Stuck");
});

function spinner() {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const file = join(dir, "Spinner.jsonl");
	const t0 = Date.parse("2026-10-14T10:00:00Z");
	setSystemTime(t0);
	// 刚开工：只有任务消息，尾部还没有任何操作
	writeFileSync(file, JSON.stringify({ type: "message", timestamp: iso(t0), message: { role: "user" } }));
	const p = patrol(dir);
	p.tick(); // 第一次看到：开始计时
	// 日志很忙：尾部只有最后 2 分钟的操作；窗口仍要从第一次看到算起
	const t1 = t0 + 31 * MIN;
	setSystemTime(t1);
	const lines = Array.from({ length: 12 }, (_, i) => [call(t1 - 2 * MIN + i, `r${i}`, { path: "a.ts" }), result(t1 - 2 * MIN + i, `r${i}`)]).flat();
	appendFileSync(file, "\n" + lines.join("\n"));
	return { dir, file, ...p };
}

test("巡检：观察窗口固定，忙碌日志照样送 SubQ；概率低就报空转", async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { progress: { noul: 0.05 } } }))) as unknown as typeof fetch;
	const { sent, tick } = spinner();
	tick();
	await settle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("Spinner");
	expect(sent[0]).toContain("5%");
});

test("巡检：SubQ 回答前小工已收工，旧结论丢弃", async () => {
	const reply = Promise.withResolvers<Response>();
	globalThis.fetch = (() => reply.promise) as unknown as typeof fetch;
	const { sent, tick, dir } = spinner();
	tick();
	writeFileSync(join(dir, "Spinner.md"), "done");
	reply.resolve(new Response(JSON.stringify({ answers: { progress: { noul: 0.01 } } })));
	await settle();
	expect(sent).toHaveLength(0);
});

test("巡检：SubQ 超时或报错不报警、不抛出，卡住检查照常", async () => {
	globalThis.fetch = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
	const { sent, tick, dir } = spinner();
	writeFileSync(join(dir, "Stuck.jsonl"), call(Date.now() - 25 * MIN, "a"));
	tick();
	await settle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("Stuck");
});

test("巡检：旧交卷文件不能遮住重新开工的小工", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const now = Date.now();
	for (const name of ["Revived", "Delivered"]) {
		writeFileSync(join(dir, `${name}.jsonl`), call(now - 25 * MIN, "new-call"));
		const md = join(dir, `${name}.md`);
		writeFileSync(md, "上次的结果");
		const at = new Date(now - (name === "Revived" ? 60 : 10) * MIN);
		utimesSync(md, at, at);
	}
	const { sent, tick } = patrol(dir);
	tick();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("Revived");
});
