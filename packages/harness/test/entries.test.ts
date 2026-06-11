import { describe, it, expect } from "vitest";
import {
  buildLlmContext,
  buildDisplaySnapshot,
  getPendingSubagentResults,
  type ConversationEntry,
} from "../src/storage/entries.js";
import type { Message } from "@poncho-ai/sdk";

const msg = (role: Message["role"], content: string): Message => ({ role, content });

let seq = 0;
const reset = () => { seq = 0; };
const next = () => ++seq;

const harness = (content: string, turnId = "t1"): ConversationEntry => ({
  type: "harness_message", id: `h${seq + 1}`, seq: next(), createdAt: 0,
  message: msg("assistant", content), turnId,
});
const user = (content: string, opts: { hidden?: boolean } = {}): ConversationEntry => ({
  type: "user_message", id: `u${seq + 1}`, seq: next(), createdAt: 0,
  message: msg("user", content), turnId: "t1", hidden: opts.hidden,
});
const assistant = (id: string, content: string): ConversationEntry => ({
  type: "assistant_message", id, seq: next(), createdAt: 0,
  message: msg("assistant", content), turnId: "t1", runId: "r1",
});

describe("buildLlmContext", () => {
  it("returns all harness messages in order with no compaction", () => {
    reset();
    const entries = [harness("a"), harness("b"), harness("c")];
    expect(buildLlmContext(entries).map((m) => m.content)).toEqual(["a", "b", "c"]);
  });

  it("applies a compaction overlay: summary + messages from firstKeptSeq", () => {
    reset();
    const h1 = harness("old1"); // seq 1
    const h2 = harness("old2"); // seq 2
    const h3 = harness("kept3"); // seq 3
    const h4 = harness("kept4"); // seq 4
    const compaction: ConversationEntry = {
      type: "compaction", id: "c1", seq: next(), createdAt: 0,
      summaryMessage: msg("user", "[summary]"), firstKeptSeq: 3,
    };
    const ctx = buildLlmContext([h1, h2, h3, h4, compaction]);
    expect(ctx.map((m) => m.content)).toEqual(["[summary]", "kept3", "kept4"]);
  });

  it("uses the LATEST compaction when several exist (layered)", () => {
    reset();
    const h1 = harness("a");
    const c1: ConversationEntry = { type: "compaction", id: "c1", seq: next(), createdAt: 0, summaryMessage: msg("user", "[sum1]"), firstKeptSeq: 1 };
    const h2 = harness("b"); // seq 3
    const c2: ConversationEntry = { type: "compaction", id: "c2", seq: next(), createdAt: 0, summaryMessage: msg("user", "[sum2]"), firstKeptSeq: 3 };
    const ctx = buildLlmContext([h1, c1, h2, c2]);
    expect(ctx.map((m) => m.content)).toEqual(["[sum2]", "b"]);
  });
});

describe("buildDisplaySnapshot", () => {
  it("drops hidden user messages and returns the tail", () => {
    reset();
    const entries = [
      user("hidden-framed", { hidden: true }),
      user("hello"),
      assistant("a1", "hi"),
      user("again"),
      assistant("a2", "yo"),
    ];
    const snap = buildDisplaySnapshot(entries, 10);
    expect(snap.messages.map((m) => m.content)).toEqual(["hello", "hi", "again", "yo"]);
    expect(snap.totalMessages).toBe(4);
  });

  it("folds amendments into their target assistant message", () => {
    reset();
    const a = assistant("a1", "part1");
    const amend: ConversationEntry = {
      type: "assistant_amendment", id: "am1", seq: next(), createdAt: 0,
      targetEntryId: "a1", appendText: " + part2",
    };
    const snap = buildDisplaySnapshot([user("q"), a, amend], 10);
    expect(snap.messages.map((m) => m.content)).toEqual(["q", "part1 + part2"]);
  });

  it("returns only the trailing tailN messages", () => {
    reset();
    const entries = [user("1"), assistant("a", "2"), user("3"), assistant("b", "4")];
    const snap = buildDisplaySnapshot(entries, 2);
    expect(snap.messages.map((m) => m.content)).toEqual(["3", "4"]);
    expect(snap.totalMessages).toBe(4);
  });
});

describe("getPendingSubagentResults", () => {
  const result = (subagentId: string): ConversationEntry => ({
    type: "subagent_result", id: `sr-${subagentId}`, seq: next(), createdAt: 0,
    result: { subagentId, task: "t", status: "completed", timestamp: 0 },
  });

  it("returns results not yet consumed by a callback", () => {
    reset();
    const r1 = result("s1"); // seq 1
    const r2 = result("s2"); // seq 2
    const callback: ConversationEntry = {
      type: "callback_started", id: "cb1", seq: next(), createdAt: 0,
      consumedSeqs: [1],
    };
    const r3 = result("s3"); // seq 4
    const pending = getPendingSubagentResults([r1, r2, callback, r3]);
    // s1 consumed; s2 + s3 still pending
    expect(pending.map((p) => p.subagentId)).toEqual(["s2", "s3"]);
  });

  it("returns empty when all consumed", () => {
    reset();
    const r1 = result("s1");
    const callback: ConversationEntry = {
      type: "callback_started", id: "cb1", seq: next(), createdAt: 0,
      consumedSeqs: [1],
    };
    expect(getPendingSubagentResults([r1, callback])).toEqual([]);
  });
});
