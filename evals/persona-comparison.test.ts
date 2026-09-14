import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { loadPersonaComparison, runPersonaComparison } from "./persona-comparison.js";

function fixture() {
  return {
    schemaVersion: 1, clock: "2026-09-07T06:22:21Z", timezone: "Asia/Seoul", repetitions: 2,
    pairs: [["original", "split"], ["split", "no-examples"]],
    conditions: ["original", "split", "no-examples"].map((id) => ({ id, personas: ["one", "two"].map((characterId) => ({
      characterId, name: `Synthetic ${characterId}`, bio: "A calm synthetic persona.", canonMemories: ["A fixed fact."],
      blocks: [
        { id: `${characterId}-voice`, title: "Voice", content: "Speak calmly." },
        { id: `${characterId}-note`, title: "Note", content: "A production note.", injection: id === "original" ? "always" : "never_prompt" },
        { id: `${characterId}-example`, title: "Examples", content: "A static sample reply.", injection: id === "no-examples" ? "never_prompt" : "always" },
      ],
    })) })),
    cases: [
      { id: "initial", messages: [{ role: "user", content: "안녕" }] },
      { id: "followup", messages: [{ role: "user", content: "내일 면접이야" }, { role: "assistant", content: "응원할게요" }, { role: "user", content: "잘 끝났어" }] },
    ],
  };
}

function oracleFixture() {
  const input = fixture();
  return {
    ...input,
    selectorMode: "fixed_oracle_diagnostic_only",
    conditions: input.conditions.map((condition) => ({
      ...condition,
      personas: condition.personas.map((persona) => ({
        ...persona,
        blocks: [...persona.blocks, {
          id: `${persona.characterId}-lore`, title: "Background", content: `A specific past event for ${persona.characterId}.`,
          injection: condition.id === "original" ? "always" : "retrieved",
        }],
      })),
    })),
    cases: input.cases.map((item) => ({
      ...item,
      oracleSelections: input.conditions.flatMap((condition) => condition.personas.map((persona) => ({
        conditionId: condition.id, characterId: persona.characterId,
        blockIds: condition.id !== "original" && item.id === "followup" ? [`${persona.characterId}-lore`] : [],
      }))),
    })),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("fixed Persona comparisons", () => {
  it.each(["empty", "oracle"])("pins %s input bytes so changes after review cannot enter a comparison", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "opod-comparison-"));
    try {
      const input = mode === "oracle" ? oracleFixture() : fixture();
      const hash = (text: string) => createHash("sha256").update(text).digest("hex");
      const conditions = [];
      for (const c of input.conditions) {
        const content = JSON.stringify(c.personas);
        await writeFile(join(root, `${c.id}.json`), content);
        conditions.push({ id: c.id, personaFile: `${c.id}.json`, personaSha256: hash(content) });
      }
      const cases = JSON.stringify({ cases: input.cases });
      await writeFile(join(root, "cases.json"), cases);
      const { cases: _cases, conditions: _conditions, ...settings } = input;
      await writeFile(join(root, "manifest.json"), JSON.stringify({ ...settings, conditions, casesFile: "cases.json", casesSha256: hash(cases) }));
      const loaded = (await loadPersonaComparison(join(root, "manifest.json"))).fixture;
      expect(loaded.conditions).toHaveLength(3);
      expect(loaded.selectorMode).toBe(mode === "oracle" ? "fixed_oracle_diagnostic_only" : "fixed_empty_diagnostic_only");
      expect(loaded.cases.map((item) => item.oracleSelections)).toEqual(input.cases.map((item) => "oracleSelections" in item ? item.oracleSelections : undefined));
      await writeFile(join(root, "cases.json"), `${cases} `);
      await expect(loadPersonaComparison(join(root, "manifest.json"))).rejects.toThrow("input hash mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("replays identical frozen prefixes independently and keeps synthetic success separate from quality", async () => {
    const chat = vi.spyOn(FakeProvider.prototype, "chat");
    const embed = vi.spyOn(FakeProvider.prototype, "embed");
    const input = fixture();
    const before = structuredClone(input);
    const result = await runPersonaComparison(input, { mode: "preflight", maxCalls: 24, env: {} });
    expect(result).toMatchObject({ completedCalls: 24, externalModelCalls: 0, structurePassed: true, qualityPassed: false, certificationEligible: false, selectorMode: "fixed_empty_diagnostic_only" });
    expect(chat).toHaveBeenCalledTimes(24);
    expect(embed).not.toHaveBeenCalled();
    expect(input).toEqual(before);
    for (const item of input.cases) {
      const requests = result.observations.flatMap((o, i) => o.caseId === item.id ? [chat.mock.calls[i]![0]] : []);
      expect(new Set(requests.map((r) => JSON.stringify(r.messages.slice(1)))).size).toBe(1);
      expect(JSON.stringify(requests)).not.toContain("구조 검증용 합성 응답입니다.");
      expect(JSON.stringify(requests)).toContain("September 7, 2026 at 3:22 PM");
    }
    for (const o of result.observations) {
      expect(o.promptDebug?.contextSectionNames).toEqual(["current_moment"]);
      expect(o.promptDebug?.personaProvenance?.sources.find((s) => s.id.endsWith("-example"))?.destination)
        .toBe(o.conditionId === "no-examples" ? "excluded" : "system_prompt");
    }
  });

  it("routes frozen per-case oracle IDs through the real target without claiming automatic selection quality", async () => {
    const chat = vi.spyOn(FakeProvider.prototype, "chat");
    const embed = vi.spyOn(FakeProvider.prototype, "embed");
    const input = oracleFixture();
    const before = structuredClone(input);
    const result = await runPersonaComparison(input, { mode: "preflight", maxCalls: 24, env: {} });
    expect(result).toMatchObject({ completedCalls: 24, externalModelCalls: 0, selectorMode: "fixed_oracle_diagnostic_only", qualityPassed: false, certificationEligible: false });
    expect(embed).not.toHaveBeenCalled();
    expect(input).toEqual(before);
    for (const [index, observation] of result.observations.entries()) {
      const expected = observation.conditionId === "original" ? "system_prompt" : observation.caseId === "followup" ? "turn_context" : "excluded";
      expect(observation.promptDebug?.personaProvenance?.sources.find((s) => s.id === `${observation.characterId}-lore`)?.destination).toBe(expected);
      const payload = JSON.stringify(chat.mock.calls[index]![0].messages);
      expect(payload.includes(`A specific past event for ${observation.characterId}.`)).toBe(expected !== "excluded");
      expect(payload).not.toContain(`A specific past event for ${observation.characterId === "one" ? "two" : "one"}.`);
      if (observation.conditionId !== "original") expect(payload).not.toContain("A production note.");
    }
  });

  it.each(["missing", "duplicate", "unknown condition", "unknown character", "foreign source", "never source", "stable source", "unknown source", "duplicate source", "wrong mode"])("rejects oracle %s before any completion", async (failure) => {
    const chat = vi.spyOn(FakeProvider.prototype, "chat");
    const input = oracleFixture();
    const selections = input.cases[1]!.oracleSelections;
    const entry = selections.find((s) => s.conditionId === "split" && s.characterId === "one")!;
    if (failure === "missing") selections.pop();
    if (failure === "duplicate") selections.push(structuredClone(entry));
    if (failure === "unknown condition") entry.conditionId = "missing";
    if (failure === "unknown character") entry.characterId = "missing";
    if (failure === "foreign source") entry.blockIds = ["two-lore"];
    if (failure === "never source") entry.blockIds = ["one-note"];
    if (failure === "stable source") entry.blockIds = ["one-voice"];
    if (failure === "unknown source") entry.blockIds = ["missing"];
    if (failure === "duplicate source") entry.blockIds.push("one-lore");
    if (failure === "wrong mode") input.selectorMode = "fixed_empty_diagnostic_only";
    await expect(runPersonaComparison(input, { mode: "preflight", maxCalls: 24, env: {} })).rejects.toThrow();
    expect(chat).not.toHaveBeenCalled();
  });

  it("does not silently substitute empty selection for an oracle case with no selection contract", async () => {
    const input = { ...fixture(), selectorMode: "fixed_oracle_diagnostic_only" };
    await expect(runPersonaComparison(input, { mode: "preflight", maxCalls: 24, env: {} })).rejects.toThrow();
  });

  it.each(["canon", "duplicate", "prefix", "budget"])("rejects %s drift before any completion", async (failure) => {
    const chat = vi.spyOn(FakeProvider.prototype, "chat");
    const input = fixture();
    if (failure === "canon") input.conditions[1]!.personas[0]!.canonMemories.push("A changed fact.");
    if (failure === "duplicate") input.conditions[1]!.id = input.conditions[0]!.id;
    if (failure === "prefix") input.cases[0]!.messages[0]!.role = "assistant";
    await expect(runPersonaComparison(input, { mode: "preflight", maxCalls: failure === "budget" ? 23 : 24, env: {} })).rejects.toThrow();
    expect(chat).not.toHaveBeenCalled();
  });

  it("requires an explicit provider configuration before running a live comparison", async () => {
    await expect(runPersonaComparison(fixture(), { mode: "run", maxCalls: 24, env: {} })).rejects.toThrow("explicit");
  });

  it("uses the configured OpenAI-compatible wire path with no embeddings, hidden retries or state drift", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let rejectRequest = false;
    let truncate = false;
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push({ path: req.url ?? "", body });
      res.writeHead(rejectRequest ? 429 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(rejectRequest ? { error: { message: "local rate limit", type: "rate_limit_error" } } : {
        id: "local-completion", object: "chat.completion", created: 0, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "로컬 모의 서버 응답" }, finish_reason: truncate ? "length" : "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("local server address missing");
      const input = fixture();
      input.repetitions = 1;
      input.cases = input.cases.slice(0, 1);
      input.conditions = input.conditions.slice(0, 2).map((c) => ({ ...c, personas: c.personas.slice(0, 1) }));
      input.pairs = [["original", "split"]];
      const options = { mode: "run" as const, maxCalls: 2, env: {
        LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, LLM_API_KEY: "local-test", LLM_MODEL: "local-protocol-model",
        EVAL_TARGET_MAX_TOKENS: "32", EVAL_TARGET_TEMPERATURE: "0", EVAL_TARGET_MAX_RETRIES: "5", EVAL_LOG_LEVEL: "error",
      } };
      const result = await runPersonaComparison(input, options);
      expect(result.completedCalls).toBe(2);
      expect(requests).toHaveLength(2);
      expect(requests.every((r) => r.path === "/v1/chat/completions")).toBe(true);
      expect(requests[0]!.body).toMatchObject({ model: "local-protocol-model", temperature: 0, max_tokens: 32 });
      expect(result.observations.every((o) => o.usage.totalTokens === 10 && o.finishReason === "stop")).toBe(true);
      truncate = true;
      const saved = vi.fn(async () => {});
      await expect(runPersonaComparison(input, { ...options, onResult: saved })).rejects.toThrow("truncated");
      expect(saved).toHaveBeenCalledWith(expect.objectContaining({ finishReason: "length" }));
      expect(requests).toHaveLength(3);
      rejectRequest = true;
      await expect(runPersonaComparison(input, options)).rejects.toThrow("HTTP");
      expect(requests).toHaveLength(4); // One failed request; no SDK retry or later condition.
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
