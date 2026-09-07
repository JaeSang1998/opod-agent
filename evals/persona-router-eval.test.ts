import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPersonaRouterFixture,
  renderPersonaRouterReport,
  runPersonaRouterEvaluation,
} from "./persona-router-eval.js";

describe("P1-1 Persona Router structure evaluation", () => {
  it("compares two generic personas without turning structure into a quality pass", async () => {
    const fixture = await loadPersonaRouterFixture(
      resolve("evals/cases/p1-persona-router.json"),
    );
    const report = await runPersonaRouterEvaluation(fixture);

    expect(fixture.personas).toHaveLength(2);
    expect(report.preflight).toEqual({ passed: true, reasons: [] });
    expect(report.metrics).toMatchObject({
      personaCount: 2,
      comparisonCount: 2,
      candidateNeutralUninvitedInjectionCount: 0,
      candidatePostStartOnlyInjectionCount: 0,
      candidateNeverPromptLeakCount: 0,
      candidateRelevantRetrievedTurnContextCount: 2,
    });
    expect(report.metrics.controlNeutralUninvitedInjectionCount).toBeGreaterThan(0);
    expect(report.metrics.controlPostStartOnlyInjectionCount).toBeGreaterThan(0);
    expect(report.metrics.controlNeverPromptLeakCount).toBeGreaterThan(0);
    expect(report.qualityPassed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.certificationEligible).toBe(false);
    expect(new Set(report.comparisons.map((item) => item.personaKey)).size).toBe(2);
  });

  it("renders a remote-reviewable report with the non-quality warning and source matrix", async () => {
    const fixture = await loadPersonaRouterFixture(
      resolve("evals/cases/p1-persona-router.json"),
    );
    const html = renderPersonaRouterReport(
      await runPersonaRouterEvaluation(fixture),
      fixture,
    );

    expect(html).toContain("대화 자연스러움: 판정하지 않음");
    expect(html).toContain("Control");
    expect(html).toContain("Candidate");
    expect(html).toContain("system_prompt");
    expect(html).toContain("turn_context");
    expect(html).toContain("never_prompt");
  });
});
