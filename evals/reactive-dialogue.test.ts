import { describe, expect, it } from "vitest";
import { runTrajectory } from "./evaluate.js";
import { ScenarioSchema } from "./schema.js";
import type { StructuredLlm } from "./llm.js";
import type { ConversationTarget, TargetTurnInput } from "./target.js";

const fixture = {
  schemaVersion: 1, id: "reactive-pilot", title: "일상 대화", description: "PRIVATE_RUBRIC",
  targetTurns: 3, historyWindowMessages: 8,
  conversationDesign: { kind: "reactive-pilot", relationship: "first-contact", contextCheck: "Opening does not assign a character trait or shared past; first contact runtime required." },
  character: { id: "test", name: "test", personaSummary: "PRIVATE_PERSONA", canon: ["PRIVATE_CANON"] },
  user: { identity: "처음 메시지를 보내는 성인", backstory: "할 일을 마치고 잠깐 잡담하고 싶다.", textingStyle: "짧은 존댓말", goals: ["잡담"], constraints: [] },
  phases: [{ fromTurn: 1, toTurn: 3, name: "private", simulatorInstruction: "PRIVATE_EVALUATION_INTENT" }],
  scriptedTurns: [{ turn: 1, message: "할 일 다 끝냈는데 좀 심심하네요 ㅋㅋ", purpose: "open" }],
  judgeCriteria: [{ id: "naturalness", description: "PRIVATE_EXPECTED_ANSWER", weight: 1, minimum: 3 }],
};

describe("reactive pilot contract", () => {
  it("accepts short pilots but rejects a later scripted beat and truncated history", () => {
    expect(ScenarioSchema.safeParse(fixture).success).toBe(true);
    expect(ScenarioSchema.safeParse({ ...fixture, scriptedTurns: [...fixture.scriptedTurns, { turn: 2, message: "왜 그랬어?", purpose: "forced" }] }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...fixture, historyWindowMessages: 4 }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...fixture, conversationDesign: undefined }).success).toBe(false);
  });

  it("continues actual replies without leaking private assessment material or granting automatic PASS", async () => {
    const inputs: TargetTurnInput[] = [];
    const simulatorRequests: string[] = [];
    const target: ConversationTarget = {
      kind: "in-process", model: "test", requestConfig: {}, runtimeConfig: {},
      reply: async input => {
        inputs.push(structuredClone(input));
        return { text: `ACTUAL_REPLY_${input.userTurn}`, responseModel: "test", finishReason: "stop", latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolEvents: [] };
      }, close: async () => {},
    };
    const simulator: StructuredLlm = {
      model: "simulator",
      complete: async options => {
        simulatorRequests.push(options.system + options.user);
        return { value: options.schema.parse({ message: "이어지는 사용자 발화", intent: "continue", decision: "continue" }), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const result = await runTrajectory({ scenario: ScenarioSchema.parse(fixture), target, simulator, evaluationMode: "diagnostic" });
    expect(result.runtimeError).toBeUndefined();
    expect(inputs[2]?.messages.filter(m => m.role === "assistant").map(m => m.content)).toEqual(["ACTUAL_REPLY_1", "ACTUAL_REPLY_2"]);
    expect(simulatorRequests[0]).toContain("ACTUAL_REPLY_1");
    expect(simulatorRequests.join(" ")).not.toContain("PRIVATE_");
    expect(result.passed).toBe(false);
    expect(result.certificationEligible).toBe(false);
  });

  it.each([
    { text: "", finishReason: "stop" },
    { text: "도중에 잘린 답변", finishReason: "length" },
  ])("stops before inventing a continuation for an incomplete reply: $finishReason", async reply => {
    let targetCalls = 0;
    let simulatorCalls = 0;
    const target: ConversationTarget = {
      kind: "in-process", model: "test", requestConfig: {}, runtimeConfig: {},
      reply: async () => {
        targetCalls++;
        return { ...reply, responseModel: "test", latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolEvents: [] };
      }, close: async () => {},
    };
    const simulator: StructuredLlm = {
      model: "simulator", complete: async () => { simulatorCalls++; throw new Error("must not continue"); },
    };
    const result = await runTrajectory({ scenario: ScenarioSchema.parse(fixture), target, simulator, evaluationMode: "diagnostic" });
    expect(result.runtimeError).toContain("empty or incomplete reply");
    expect(result.completedTurns).toBe(0);
    expect(targetCalls).toBe(1);
    expect(simulatorCalls).toBe(0);
    expect(result.passed).toBe(false);
  });
});
