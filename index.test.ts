import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
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
	const ctx = { sessionManager: { getArtifactsDir: () => dir }, setInterval: (fn: () => void) => { tick = fn; }, ui: { setStatus: () => {} } };
	const pi = {
		on: (_ev: string, h: (e: unknown, c: unknown) => void) => h({}, ctx),
		sendMessage: (m: { content: string }) => sent.push(m.content),
		registerMessageRenderer: () => {},
		registerCommand: () => {},
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

test("收工判定：最终回复、取消、session_exit；收工后再被唤醒算在岗", () => {
	for (const s of ["stop", "aborted"]) expect(rollCall([final(0, s)]).finished).toBe(true);
	expect(rollCall([result(0, "a"), JSON.stringify({ type: "custom", customType: "session_exit", timestamp: iso(1) })]).finished).toBe(true);
	const woke = JSON.stringify({ type: "message", timestamp: iso(2), message: { role: "user" } });
	expect(rollCall([final(0, "stop"), woke]).finished).toBe(false);
});

test("单次模型报错后没有后续：不算收工，满闲置阈值报卡住并说明是模型请求出错", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-error-hang-"));
	const failed = JSON.stringify({ type: "message", timestamp: iso(now - 22 * MIN), message: { role: "assistant", stopReason: "error", errorMessage: "The socket connection was closed unexpectedly.", content: [] } });
	writeFileSync(join(dir, "Worker.jsonl"), [call(now - 23 * MIN, "a"), result(now - 23 * MIN, "a"), failed].join("\n") + "\n");
	// 真正结束的小工会留下结果文件，不应报
	writeFileSync(join(dir, "Ended.jsonl"), [call(now - 23 * MIN, "a"), result(now - 23 * MIN, "a"), failed].join("\n") + "\n");
	writeFileSync(join(dir, "Ended.md"), "failed");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toHaveLength(1);
	expect(p.sent[0]).toContain("小工 Worker ");
	expect(p.sent[0]).toContain("socket connection was closed");
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

test("施工超过一小时仍只有观察操作：SubQ 不可用也提醒核对，补充消息不重置任务", async () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-delivery-"));
	const task = JSON.stringify({ type: "message", timestamp: iso(now - 71 * MIN), message: { role: "user", content: "# Target\nCoral worktree，出站媒体。\n# Change\n实现文件发送并补测试。\n# Acceptance\n提交实现与验证结果。" } });
	const update = JSON.stringify({ type: "message", timestamp: iso(now - 5 * MIN), message: { role: "user", content: "[Wait interrupted by message] <irc>补充：核对图片回调为什么丢失。</irc>" } });
	const logs = [task, call(now - 6 * MIN, "read", { command: "cat runtime/adapter.mjs" }), result(now - 6 * MIN, "read"), final(now - 5.5 * MIN, "error"), update, call(now, "more", { command: "sed -n '1,100p' tests/media.test.mjs" }), result(now, "more")];
	writeFileSync(join(dir, "Builder.jsonl"), logs.join("\n"));
	globalThis.fetch = (() => Promise.reject(new Error("SubQ unavailable"))) as unknown as typeof fetch;
	const p = patrol(dir);
	p.tick();
	await settle();
	expect(p.sent).toHaveLength(1);
	p.tick();
	expect(p.sent).toHaveLength(1);
	expect(rollCall(logs).goal).toContain("出站媒体");
});

test("施工核对不把只读任务、刚成功修改和仍在截止期内的长工具报成缺少修改", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-delivery-boundaries-"));
	const task = (target: string, change = "") => JSON.stringify({ type: "message", timestamp: iso(now - 71 * MIN), message: { role: "user", content: `# Target\n${target}${change}` } });
	writeFileSync(join(dir, "Research.jsonl"), [task("只读审查媒体协议，返回根因。", "\n# Change\n核对文件，不做实现。"), call(now, "r", { path: "adapter.mjs" }, "read"), result(now, "r")].join("\n"));
	writeFileSync(join(dir, "Changed.jsonl"), [task("施工媒体协议", "\n# Change\n实现文件发送。"), call(now - 20 * MIN, "w", { path: "adapter.mjs", content: "fixed" }, "write"), result(now - 20 * MIN, "w"), call(now, "r", { path: "adapter.mjs" }, "read"), result(now, "r")].join("\n"));
	writeFileSync(join(dir, "LongTool.jsonl"), [task("施工媒体协议", "\n# Change\n实现文件发送。"), call(now - 65 * MIN, "long", { command: "build", timeout: 7200 })].join("\n"));
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toEqual([]);
});

test("失败的修改不算施工成果；成功修改后重新计时，重新派工不沿用旧成果", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-delivery-restart-"));
	const file = join(dir, "Builder.jsonl");
	const task = (at: number) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content: "# Target\n施工媒体协议\n# Change\n实现文件发送。" } });
	writeFileSync(file, [task(now - 71 * MIN), call(now - MIN, "bad", { path: "adapter.mjs" }, "edit"), result(now, "bad", true)].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toHaveLength(1);
	appendFileSync(file, [call(now + MIN, "good", { path: "adapter.mjs" }, "edit"), result(now + MIN, "good")].join("\n") + "\n");
	setSystemTime(now + MIN);
	p.tick();
	expect(p.sent).toHaveLength(1);
	appendFileSync(file, task(now + 2 * MIN) + "\n");
	setSystemTime(now + 63 * MIN);
	appendFileSync(file, [call(now + 63 * MIN, "r", { path: "adapter.mjs" }, "read"), result(now + 63 * MIN, "r")].join("\n") + "\n");
	p.tick();
	expect(p.sent).toHaveLength(2);
});

test("大日志跨块和跨轮工具配对：返回前遵守长超时，返回后恢复正常闲置计时", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-incremental-tool-"));
	const file = join(dir, "Worker.jsonl");
	writeFileSync(file, [call(now - 65 * MIN, "long", { command: "build", timeout: 7200 }), JSON.stringify({ type: "custom", data: "x".repeat(600_000) })].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toEqual([]);
	appendFileSync(file, result(now, "long") + "\n");
	p.tick();
	expect(p.sent).toEqual([]);
	setSystemTime(now + 21 * MIN);
	p.tick();
	expect(p.sent).toHaveLength(1);
});

test("增量读取保留半写入 JSON 与分块 UTF-8，成功修改会重置施工提醒", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-partial-"));
	const file = join(dir, "Worker.jsonl");
	const task = JSON.stringify({ type: "message", timestamp: iso(now - 71 * MIN), message: { role: "user", content: "# Target\n实现媒体协议\n# Change\n实现文件发送。" } });
	const output = Buffer.from(result(now, "write", false, "改好😀") + "\n");
	const cut = output.indexOf(Buffer.from("😀")) + 2;
	writeFileSync(file, Buffer.concat([Buffer.from([task, call(now, "write", { path: "adapter.mjs" }, "write"), ""].join("\n")), output.subarray(0, cut)]));
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toHaveLength(1);
	appendFileSync(file, output.subarray(cut));
	p.tick();
	expect(p.sent).toHaveLength(1);
	setSystemTime(now + 61 * MIN);
	appendFileSync(file, [call(now + 61 * MIN, "r", { path: "adapter.mjs" }, "read"), result(now + 61 * MIN, "r")].join("\n") + "\n");
	p.tick();
	expect(p.sent).toHaveLength(2);
});

test("同名记录被覆盖且变大时，不能把旧任务的成功修改沿用给新任务", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-rewrite-"));
	const file = join(dir, "Worker.jsonl");
	const task = (at: number) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content: "# Target\n实现媒体协议\n# Change\n实现文件发送。" } });
	writeFileSync(file, [task(now - 100 * MIN), call(now - MIN, "w", { path: "adapter.mjs" }, "write"), result(now - MIN, "w")].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toEqual([]);
	writeFileSync(file, [task(now - 71 * MIN), JSON.stringify({ type: "custom", data: "x".repeat(1000) }), call(now, "r", { path: "adapter.mjs" }, "read"), result(now, "r")].join("\n") + "\n");
	p.tick();
	expect(p.sent).toHaveLength(1);
});

test("收工后同名小工接到无标题的只读新任务，不继承旧施工任务的超时", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-new-round-"));
	const user = (at: number, content: string) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content } });
	writeFileSync(join(dir, "Worker.jsonl"), [
		user(now - 100 * MIN, "# Target\n实现媒体协议\n# Change\n实现文件发送。"),
		call(now - 90 * MIN, "w", { path: "adapter.mjs" }, "write"), result(now - 90 * MIN, "w"),
		final(now - 80 * MIN, "stop"),
		user(now - 70 * MIN, "只读审查文件发送，返回风险。"),
		call(now, "r", { path: "adapter.mjs" }, "read"), result(now, "r"),
	].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toEqual([]);
});

test("同名小工换任务后，SubQ 必须重新积满观察窗口，不能借用上一任务的时间", async () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-spin-round-"));
	const file = join(dir, "Worker.jsonl");
	const task = (at: number, target: string) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content: `# Target\n只读审查 ${target}` } });
	writeFileSync(file, [task(now, "old"), call(now, "old", { path: "old.ts" }, "read"), result(now, "old")].join("\n") + "\n");
	globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { progress: { noul: 0.01 }, sufficient_evidence: { noul: 0.99 } } }))) as unknown as typeof fetch;
	const p = patrol(dir);
	p.tick();
	setSystemTime(now + 31 * MIN);
	const next = [task(now + 30 * MIN, "new")];
	for (let i = 0; i < 12; i++) next.push(call(now + 31 * MIN, `new-${i}`, { path: "new.ts" }, "read"), result(now + 31 * MIN, `new-${i}`));
	appendFileSync(file, next.join("\n") + "\n");
	p.tick();
	await settle();
	expect(p.sent).toEqual([]);
	setSystemTime(now + 61 * MIN);
	appendFileSync(file, [call(now + 61 * MIN, "latest", { path: "new.ts" }, "read"), result(now + 61 * MIN, "latest")].join("\n") + "\n");
	p.tick();
	await settle();
	expect(p.sent).toHaveLength(1);
});

const header = (at: number, id: string, parentSession?: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: iso(at), ...(parentSession ? { parentSession } : {}) });
const irc = (at: number) => JSON.stringify({ type: "custom_message", customType: "irc:incoming", timestamp: iso(at), content: "<irc>继续执行</irc>" });
const buildTask = (at: number) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content: "# Target\n实现媒体协议\n# Change\n实现文件发送。" } });

test("收工后被 IRC 唤醒：休眠时间不计入施工计时，恢复后满一小时无修改再提醒", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-resume-"));
	const file = join(dir, "Worker.jsonl");
	writeFileSync(file, [
		buildTask(now - 300 * MIN),
		call(now - 250 * MIN, "w", { path: "a.ts" }, "edit"), result(now - 250 * MIN, "w"),
		final(now - 245 * MIN, "stop"),
		irc(now - MIN),
		call(now, "r", { path: "a.ts" }, "read"), result(now, "r"),
	].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toEqual([]);
	setSystemTime(now + 60 * MIN);
	appendFileSync(file, [call(now + 60 * MIN, "r2", { path: "a.ts" }, "read"), result(now + 60 * MIN, "r2")].join("\n") + "\n");
	p.tick();
	expect(p.sent).toHaveLength(1);
});

test("复活成新记录：用原小工的名字，不按复制来的旧历史报卡住或缺修改，原记录不再重复报", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-revived-"));
	const history = [buildTask(now - 280 * MIN), call(now - 240 * MIN, "x", { path: "a.ts" }, "read"), result(now - 240 * MIN, "x")];
	writeFileSync(join(dir, "ChannelReviewFixes.jsonl"), [header(now - 280 * MIN, "orig-id"), ...history].join("\n") + "\n");
	writeFileSync(join(dir, "2026-10-17T01-17-38-039Z_01a1476f.jsonl"), [header(now - MIN, "new-id", "orig-id"), ...history, irc(now - MIN), call(now, "y", { path: "a.ts" }, "read"), result(now, "y")].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toEqual([]);
	setSystemTime(now + 60 * MIN);
	appendFileSync(join(dir, "2026-10-17T01-17-38-039Z_01a1476f.jsonl"), [call(now + 60 * MIN, "z", { path: "a.ts" }, "read"), result(now + 60 * MIN, "z")].join("\n") + "\n");
	p.tick();
	expect(p.sent).toHaveLength(1);
	expect(p.sent[0]).toContain("小工 ChannelReviewFixes ");
});

test("子代理会话不巡检，避免每个小工各报一遍并被报警唤醒", () => {
	const dir = mkdtempSync(join(tmpdir(), "dianmao-sub-"));
	let scheduled = false;
	const ctx = { agent: { kind: "sub" }, sessionManager: { getArtifactsDir: () => dir }, setInterval: () => { scheduled = true; }, ui: { setStatus: () => {} } };
	const pi = { on: (_ev: string, h: (e: unknown, c: unknown) => void) => h({}, ctx), sendMessage: () => {}, registerMessageRenderer: () => {}, registerCommand: () => {} };
	dianmao(pi as unknown as Parameters<typeof dianmao>[0]);
	expect(scheduled).toBe(false);
});

test("成功的 git commit 算施工成果；提交失败不算", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-commit-"));
	writeFileSync(join(dir, "Committed.jsonl"), [buildTask(now - 71 * MIN), call(now - 5 * MIN, "c", { command: "cd /w && git commit -qam fix && git status --short" }), result(now - 5 * MIN, "c", false, "", { exitCode: 0 }), call(now, "r", { path: "a.ts" }, "read"), result(now, "r")].join("\n") + "\n");
	writeFileSync(join(dir, "Failed.jsonl"), [buildTask(now - 71 * MIN), call(now - 5 * MIN, "c", { command: "git commit -m fix" }), result(now - 5 * MIN, "c", true, "nothing to commit", { exitCode: 1 }), call(now, "r", { path: "a.ts" }, "read"), result(now, "r")].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toHaveLength(1);
	expect(p.sent[0]).toContain("小工 Failed ");
});

test("孙代理的记录在子目录里：照样清点和报卡住，名字按 父>子 显示，结果文件按同目录判断", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-nested-"));
	const parentFile = join(dir, "Parent.jsonl");
	writeFileSync(parentFile, [header(now - 30 * MIN, "parent-id", `${dir}.jsonl`), call(now, "w", { command: "x" }, "wait")].join("\n") + "\n");
	mkdirSync(join(dir, "Parent"));
	// 文件头 parentSession 是父代理文件路径，不能让父代理被当成“已被复活取代”
	writeFileSync(join(dir, "Parent", "Parent.Child.jsonl"), [header(now - 25 * MIN, "child-id", parentFile), call(now - 22 * MIN, "a"), result(now - 22 * MIN, "a")].join("\n") + "\n");
	writeFileSync(join(dir, "Parent", "Parent.Done.jsonl"), [header(now - 25 * MIN, "done-id", parentFile), call(now - 22 * MIN, "a"), result(now - 22 * MIN, "a")].join("\n") + "\n");
	writeFileSync(join(dir, "Parent", "Parent.Done.md"), "ok");
	const statuses: string[] = [];
	let tick = () => {};
	const ctx = { agent: { kind: "main" }, sessionManager: { getArtifactsDir: () => dir }, setInterval: (fn: () => void) => { tick = fn; }, ui: { setStatus: (_k: string, v: string) => statuses.push(v) } };
	const sent: string[] = [];
	const pi = { on: (_ev: string, h: (e: unknown, c: unknown) => void) => h({}, ctx), sendMessage: (m: { content: string }) => sent.push(m.content), registerMessageRenderer: () => {}, registerCommand: () => {} };
	dianmao(pi as unknown as Parameters<typeof dianmao>[0]);
	tick();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("小工 Parent>Child ");
	expect(statuses.at(-1)).toContain("2 在岗");
});

test("工具已返回、模型不再回话：卡片写明已返回时间，不能读成“还在等”", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-returned-"));
	const back = now - 21 * MIN;
	writeFileSync(join(dir, "Returned.jsonl"), [call(now - 30 * MIN, "w", {}, "wait", "等审查结果"), result(back, "w")].join("\n") + "\n");
	writeFileSync(join(dir, "Running.jsonl"), [call(now - 21 * MIN, "w", {}, "wait", "等审查结果")].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toHaveLength(2);
	const hhmm = new Date(back).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
	expect(p.sent.find(s => s.includes("Returned"))).toContain(`已于 ${hhmm} 返回，之后模型没有回应`);
	expect(p.sent.find(s => s.includes("Running"))).toContain("仍在运行");
});

test("同一次卡住持续：每满 60 分钟再提醒一次并标明第几次；恢复后重新计", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-remind-"));
	const file = join(dir, "Worker.jsonl");
	writeFileSync(file, [call(now - 25 * MIN, "w", {}, "wait"), result(now - 20 * MIN, "w")].join("\n") + "\n");
	const p = patrol(dir);
	p.tick();
	expect(p.sent).toHaveLength(1);
	setSystemTime(now + 59 * MIN);
	p.tick();
	expect(p.sent).toHaveLength(1);
	setSystemTime(now + 60 * MIN);
	p.tick();
	expect(p.sent).toHaveLength(2);
	expect(p.sent[1]).toContain("第 2 次提醒");
	appendFileSync(file, [call(now + 61 * MIN, "x", {}, "read"), result(now + 61 * MIN, "x")].join("\n") + "\n");
	setSystemTime(now + 81 * MIN);
	p.tick();
	expect(p.sent).toHaveLength(3);
	expect(p.sent[2]).not.toContain("次提醒");
});

test("在 wait 上等同一支里还在干活的审查员：不报；审查员卡了只报审查员；全家都在等或等的是后台命令照常报", () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-family-"));
	const waiting = [call(now - 22 * MIN, "w", {}, "wait", "等独立审查")].join("\n") + "\n";
	// 父与兄弟都在等，审查员在干活
	writeFileSync(join(dir, "Migrate.jsonl"), waiting);
	mkdirSync(join(dir, "Migrate"));
	writeFileSync(join(dir, "Migrate", "Migrate.Rebase.jsonl"), waiting);
	const reviewer = join(dir, "Migrate", "Migrate.Review.jsonl");
	writeFileSync(reviewer, [call(now - MIN, "r", { path: "a.ts" }, "read"), result(now - MIN, "r")].join("\n") + "\n");
	// 另一支：全家都在等（互相等）
	writeFileSync(join(dir, "Deadlock.jsonl"), waiting);
	mkdirSync(join(dir, "Deadlock"));
	writeFileSync(join(dir, "Deadlock", "Deadlock.Child.jsonl"), waiting);
	// 单独一个在 wait 后台命令
	writeFileSync(join(dir, "Watcher.jsonl"), waiting);
	const p = patrol(dir);
	p.tick();
	expect(p.sent.map(s => s.match(/小工 (\S+) /)?.[1]).sort()).toEqual(["Deadlock", "Deadlock>Child", "Watcher"]);
	// 审查员也卡住：只报审查员，等它的两个仍不报
	setSystemTime(now + 20 * MIN);
	p.tick();
	expect(p.sent.slice(3).map(s => s.match(/小工 (\S+) /)?.[1])).toEqual(["Migrate>Review"]);
});

test("原地打转：连续 20 次以上只差数字的快速相同调用，不靠 SubQ 也报；翻页读和慢轮询不算", async () => {
	const now = Date.now();
	setSystemTime(now);
	const dir = mkdtempSync(join(tmpdir(), "dianmao-loop-"));
	const series = (name: string, n: number, step: number, make: (i: number) => [Record<string, unknown>, string, string]) => {
		const lines = [JSON.stringify({ type: "message", timestamp: iso(now - n * step - MIN), message: { role: "user", content: "# Target\n只读审查 #1911" } })];
		for (let i = 0; i < n; i++) {
			const [args, tool, text] = make(i);
			const at = now - (n - i) * step;
			lines.push(call(at, `${name}${i}`, args, tool, `Distinct marker ${i}`), result(at + Math.min(step - 1000, 60_000), `${name}${i}`, false, text));
		}
		writeFileSync(join(dir, `${name}.jsonl`), lines.join("\n") + "\n");
	};
	series("Looper", 25, 4000, i => [{ command: `echo z${1100 + i}` }, "bash", `z${1100 + i}`]);
	series("Pager", 25, 4000, i => [{ path: `a.ts:${i * 50 + 1}-${i * 50 + 50}` }, "read", `line ${i}: const v${"x".repeat(i)} = ${i};`]);
	series("Poller", 25, 70_000, () => [{}, "wait", "Nothing finished yet"]);
	globalThis.fetch = (() => Promise.reject(new Error("SubQ unavailable"))) as unknown as typeof fetch;
	const p = patrol(dir);
	p.tick();
	await settle();
	expect(p.sent).toHaveLength(1);
	expect(p.sent[0]).toContain("小工 Looper ");
	expect(p.sent[0]).toContain("连续 25 次");
	p.tick();
	await settle();
	expect(p.sent).toHaveLength(1);
});
