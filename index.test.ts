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
const call = (at: number, id: string, args: Record<string, unknown> = { command: "make" }, name = "bash", intent = "跑构建") =>
	JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, intent, arguments: args }] } });
const result = (at: number, id: string, isError = false, text = "", details: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text }], details } });
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

test("连续报错是 harness 在重试：算在岗，闲置从第一次报错算起", () => {
	const t = Date.parse("2026-10-14T10:00:00Z");
	const retrying = rollCall([call(t, "a"), result(t + MIN, "a"), final(t + 2 * MIN, "error"), final(t + 7 * MIN, "error"), final(t + 12 * MIN, "error")]);
	expect(retrying.finished).toBe(false);
	expect(retrying.lastMessageAt).toBe(t + 2 * MIN);
	// 重试成功后恢复正常计时
	expect(rollCall([final(t, "error"), final(t + 5 * MIN, "error"), call(t + 6 * MIN, "b")]).lastMessageAt).toBe(t + 6 * MIN);
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
		return new Response(JSON.stringify({ answers: { progress: { noul: 0.3 }, sufficient_evidence: { noul: 0.95 } } }));
	}) as unknown as typeof fetch;
	const ops = rollCall([call(0, "a", { command: "cat ~/.secret-token" }), call(1, "b", { command: "cat ~/.secret-token" })]).ops;
	expect(await progressProbability({ goal: "核对权限", ops }, fake)).toBe(0.3);
	expect(body).not.toContain("secret-token");
	expect(ops[0].argsHash).toBe(ops[1].argsHash);
	const fail = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
	await expect(progressProbability({ goal: "核对权限", ops }, fail)).rejects.toThrow("SubQ HTTP 500");
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
	writeFileSync(file, JSON.stringify({ type: "message", timestamp: iso(t0), message: { role: "user", content: [{ type: "text", text: "修复测试失败并验证结果" }] } }));
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
	globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { progress: { noul: 0.05 }, sufficient_evidence: { noul: 0.95 } } }))) as unknown as typeof fetch;
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
	reply.resolve(new Response(JSON.stringify({ answers: { progress: { noul: 0.01 }, sufficient_evidence: { noul: 0.95 } } })));
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

const quotaError = (at: number, errorStatus = 503, errorMessage = "503 [codebuddy-cn/hy4-preview] [429]: 额度已用尽") =>
	JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "assistant", stopReason: "error", content: [], model: "cbcn/hy4-preview", errorStatus, errorMessage } });

test("巡检：503 包装的连续 429 在五分钟后报警，同轮重试不重复，恢复后可再报警", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const file = join(dir, "Reviewer.jsonl");
	const now = Date.now();
	writeFileSync(file, [quotaError(now - 6 * MIN), quotaError(now - 3 * MIN), quotaError(now)].join("\n"));
	const { sent, tick } = patrol(dir);
	tick();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("cbcn/hy4-preview");
	expect(sent[0]).toContain("429");
	appendFileSync(file, "\n" + quotaError(now + MIN));
	tick();
	expect(sent).toHaveLength(1);
	appendFileSync(file, "\n" + [
		call(now + 2 * MIN, "recovered"),
		quotaError(now + 3 * MIN), quotaError(now + 6 * MIN), quotaError(now + 9 * MIN),
	].join("\n"));
	setSystemTime(now + 9 * MIN);
	tick();
	expect(sent).toHaveLength(2);
});

test("巡检：短暂限流、次数不足、普通 503、成功恢复、取消和退出均不报额度重试", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const now = Date.now();
	const run = [quotaError(now - 6 * MIN), quotaError(now - 3 * MIN), quotaError(now)];
	const cases = {
		Brief: [quotaError(now - MIN), quotaError(now - MIN / 2), quotaError(now)],
		TwoErrors: [quotaError(now - 6 * MIN), quotaError(now)],
		ServerErrors: [-6, -3, 0].map(m => quotaError(now + m * MIN, 503, "Service unavailable")),
		Recovered: [...run, call(now, "ok")],
		Cancelled: [...run, final(now, "aborted")],
		Exited: [...run, JSON.stringify({ type: "custom", customType: "session_exit", timestamp: iso(now) })],
		ToolOutput: [...run, JSON.stringify({ type: "message", timestamp: iso(now), message: { role: "toolResult", content: [{ type: "text", text: "HTTP 429 额度已用尽" }] } })],
	};
	for (const [name, lines] of Object.entries(cases)) writeFileSync(join(dir, `${name}.jsonl`), lines.join("\n"));
	const { sent, tick } = patrol(dir);
	tick();
	expect(sent).toEqual([]);
});

test("巡检：识别直接 429 与额度错误正文", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-"));
	const now = Date.now();
	for (const [name, status, text] of [
		["Direct429", 429, "Too Many Requests"],
		["Quota", 403, "insufficient_quota"],
	] as const) {
		writeFileSync(join(dir, `${name}.jsonl`), [-6, -3, 0].map(m => quotaError(now + m * MIN, status, text)).join("\n"));
	}
	const { sent, tick } = patrol(dir);
	tick();
	expect(sent).toHaveLength(2);
	expect(sent.some(s => s.includes("Direct429"))).toBe(true);
	expect(sent.some(s => s.includes("Quota"))).toBe(true);
});

test("进展证据：测试失败逐步减少，后台启动不冒充已成功完成", () => {
	const r = rollCall([
		call(0, "a", { command: "bun test" }),
		result(1000, "a", true, "2 pass\n3 fail\n[10.00ms]", { exitCode: 1 }),
		call(2000, "b", { command: "bun test" }),
		result(3000, "b", false, "5 pass\n0 fail\n[20.00ms]"),
		call(4000, "c", { command: "bun test" }),
		result(5000, "c", false, "background preview", { async: { state: "running", jobId: "bg_1" } }),
	]);
	expect(r.ops.map(o => o.tests)).toEqual([{ passed: 2, failed: 3 }, { passed: 5, failed: 0 }, undefined]);
	expect(r.ops.map(o => o.status)).toEqual(["error", "ok", "running"]);
	expect(r.ops[0].exitCode).toBe(1);
	expect(r.ops[2].resultHash).toBeUndefined();
});

test("进展证据：相同结果忽略耗时噪音，不把阅读正文里的测试数字算成执行结果", () => {
	const r = rollCall([
		call(0, "a", { command: "bun test" }), result(1000, "a", true, "2 pass\n3 fail\n[10.00ms]"),
		call(2000, "b", { command: "bun test" }), result(3000, "b", true, "2 pass\n3 fail\n[30.00ms]"),
		call(4000, "c", { path: "tests.ts" }, "read"), result(5000, "c", false, "const example = '3 pass';"),
	]);
	expect(r.ops[0].resultHash).toBe(r.ops[1].resultHash);
	expect(r.ops[2].tests).toBeUndefined();
	expect(r.ops[2].activity).toBe("read");
});

test("外发范围：保留任务目标与结果摘要，凭据、代码、命令和工具输出正文不外发", async () => {
	const goal = JSON.stringify({ type: "message", timestamp: iso(0), message: { role: "user", content: [{
		type: "text", text: "Complete assignment thoroughly:\n\n# Target\n修复测试失败 password=goal-secret\n```ts\nconst PRIVATE_SOURCE = 1;\n```\n# Acceptance\n验证通过",
	}] } });
	const r = rollCall([
		goal, call(1000, "a", { command: "bun test --token=command-secret" }, "bash", "验证结果 api_key=intent-secret"),
		result(2000, "a", true, "PRIVATE_OUTPUT\n2 passed, 3 failed", { exitCode: 1 }),
	]);
	let body = "";
	const fake = (async (_url: unknown, init: { body: string }) => {
		body = init.body;
		return new Response(JSON.stringify({ answers: { progress: { noul: 0.1 }, sufficient_evidence: { noul: 0.9 } } }));
	}) as unknown as typeof fetch;
	await progressProbability(r, fake);
	expect(body).toContain("修复测试失败");
	expect(body).toContain('"passed":2');
	expect(body).toContain('"failed":3');
	for (const secret of ["goal-secret", "command-secret", "intent-secret", "PRIVATE_SOURCE", "PRIVATE_OUTPUT", "bun test"]) expect(body).not.toContain(secret);
});

test("证据不足或概率不合法时，即使进展概率很低也不返回空转结论", async () => {
	for (const answers of [
		{ progress: { noul: 0.01 }, sufficient_evidence: { noul: 0.2 } },
		{ progress: { noul: 0.01 } },
		{ progress: { noul: -1 }, sufficient_evidence: { noul: 0.9 } },
		{ progress: { noul: 0.01 }, sufficient_evidence: { noul: 2 } },
	]) {
		const fake = (async () => new Response(JSON.stringify({ answers }))) as unknown as typeof fetch;
		expect(await progressProbability({ goal: "", ops: [] }, fake)).toBeUndefined();
	}
});

test("巡检：大日志尾部不含任务目标时，从头部补目标；SubQ 等待期间有新进展则不报旧结论", async () => {
	const reply = Promise.withResolvers<Response>();
	let request = "";
	globalThis.fetch = ((_url: unknown, init: { body: string }) => {
		request = init.body;
		return reply.promise;
	}) as unknown as typeof fetch;
	const { tick, file, sent } = spinner();
	const before = await Bun.file(file).text();
	const [goal, ...tail] = before.split("\n");
	const padding = JSON.stringify({ type: "custom", data: "x".repeat(600 * 1024) });
	writeFileSync(file, [goal, padding, ...tail].join("\n"));
	tick();
	expect(request).toContain("修复测试失败并验证结果");
	appendFileSync(file, "\n" + call(Date.now() + 1000, "new-result"));
	reply.resolve(new Response(JSON.stringify({ answers: { progress: { noul: 0.01 }, sufficient_evidence: { noul: 0.95 } } })));
	await settle();
	expect(sent).toEqual([]);
});

test("结果变化按相同操作比较，重复失败与结果改善不混淆", async () => {
	const r = rollCall([
		call(0, "a", { command: "bun test" }), result(1000, "a", true, "2 pass\n3 fail"),
		call(2000, "b", { command: "bun test" }), result(3000, "b", true, "2 pass\n3 fail"),
		call(4000, "c", { command: "bun test" }), result(5000, "c", false, "5 pass\n0 fail"),
	]);
	let changes: string[] = [];
	const fake = (async (_url: unknown, init: { body: string }) => {
		const request = JSON.parse(init.body) as { state: { operations: { resultChange: string }[] } };
		changes = request.state.operations.map(op => op.resultChange);
		return new Response(JSON.stringify({ answers: { progress: { noul: 0.9 }, sufficient_evidence: { noul: 0.9 } } }));
	}) as unknown as typeof fetch;
	await progressProbability({ goal: "修复测试失败", ops: r.ops }, fake);
	expect(changes).toEqual(["first_observed", "unchanged", "changed"]);
});
