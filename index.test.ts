import { expect, test } from "bun:test";
import { progressProbability, rollCall } from "./index.ts";

const msg = (ts: string, message: object) => JSON.stringify({ type: "message", timestamp: ts, message });
const tool = (ts: string, toolName: string) =>
	JSON.stringify({ type: "custom", customType: "tool_execution_start", timestamp: ts, data: { toolName, intent: "x", args: { path: "a.ts" } } });

test("在岗：最后一条是工具结果，时间取最后一条消息而不是后面的用量记录", () => {
	const r = rollCall([
		msg("2026-10-14T10:00:00Z", { role: "assistant", stopReason: "toolUse" }),
		tool("2026-10-14T10:00:01Z", "bash"),
		msg("2026-10-14T10:00:05Z", { role: "toolResult" }),
		JSON.stringify({ type: "model_usage", timestamp: "2026-10-14T10:30:00Z" }),
	]);
	expect(r.finished).toBe(false);
	expect(r.lastMessageAt).toBe(Date.parse("2026-10-14T10:00:05Z"));
	expect(r.ops.map(o => o.text.split(":")[0])).toEqual(["bash"]);
});

test("收工：交了最终回复、被取消、报错、或有 session_exit", () => {
	for (const stopReason of ["stop", "aborted", "error"]) {
		expect(rollCall([msg("2026-10-14T10:00:00Z", { role: "assistant", stopReason })]).finished).toBe(true);
	}
	const exited = rollCall([
		msg("2026-10-14T10:00:00Z", { role: "toolResult" }),
		JSON.stringify({ type: "custom", customType: "session_exit", timestamp: "2026-10-14T10:00:01Z" }),
	]);
	expect(exited.finished).toBe(true);
});

test("收工后又被唤醒继续干活，重新算在岗；坏行跳过", () => {
	const r = rollCall([
		msg("2026-10-14T10:00:00Z", { role: "assistant", stopReason: "stop" }),
		"{半行",
		msg("2026-10-14T10:05:00Z", { role: "user" }),
	]);
	expect(r.finished).toBe(false);
});

test("SubQ 返回的概率原样取出，非数字返回 undefined", async () => {
	process.env.SUBQ_API_KEY = "k";
	const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
	expect(await progressProbability("a", [], reply({ answers: { progress: { noul: 0.1 } } }))).toBe(0.1);
	expect(await progressProbability("a", [], reply({ answers: {} }))).toBeUndefined();
	const fail = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
	await expect(progressProbability("a", [], fail)).rejects.toThrow("SubQ HTTP 500");
});
