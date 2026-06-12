import { describe, it, expect } from "vitest";
import {
  getPendingSubagentResults,
  type ConversationEntry,
} from "../src/storage/entries.js";

const result = (seq: number, subagentId: string): ConversationEntry => ({
  type: "subagent_result",
  id: `r${seq}`,
  seq,
  createdAt: seq,
  result: { subagentId, task: "t", status: "completed", timestamp: seq },
});

const consumed = (seq: number, consumedSeqs: number[]): ConversationEntry => ({
  type: "callback_started",
  id: `cb${seq}`,
  seq,
  createdAt: seq,
  consumedSeqs,
});

describe("getPendingSubagentResults", () => {
  it("returns every result when nothing is consumed", () => {
    const pending = getPendingSubagentResults([result(1, "a"), result(2, "b")]);
    expect(pending.map((r) => r.subagentId)).toEqual(["a", "b"]);
  });

  it("excludes results consumed by a callback_started entry", () => {
    const pending = getPendingSubagentResults([
      result(1, "a"),
      result(2, "b"),
      consumed(3, [1]),
    ]);
    expect(pending.map((r) => r.subagentId)).toEqual(["b"]);
  });

  it("supports multiple consumption entries", () => {
    const pending = getPendingSubagentResults([
      result(1, "a"),
      consumed(2, [1]),
      result(3, "b"),
      result(4, "c"),
      consumed(5, [3, 4]),
    ]);
    expect(pending).toEqual([]);
  });

  it("ignores consumption of unknown seqs", () => {
    const pending = getPendingSubagentResults([result(1, "a"), consumed(2, [99])]);
    expect(pending.map((r) => r.subagentId)).toEqual(["a"]);
  });

  it("returns [] for an empty log", () => {
    expect(getPendingSubagentResults([])).toEqual([]);
  });
});
