import { describe, it, expect } from "vitest";
import {
  BOND_LEVEL_XP,
  BOND_XP_BY_GRADE,
  DAILY_BOND_XP_CAP,
  MAX_BOND_LEVEL,
  MAX_BOND_XP,
  type BondGrade,
  bondLevelForXp,
  bondSnapshot,
  isBondGrade,
  levelFloorForXp,
  nextBondState,
  recencyFor,
  serviceDate,
} from "./bond.js";

const DAY = 24 * 60 * 60 * 1000;

describe("grades", () => {
  it("accepts only the five integer steps", () => {
    for (const grade of [-2, -1, 0, 1, 2]) expect(isBondGrade(grade)).toBe(true);
    for (const other of [-3, 3, 1.5, Number.NaN]) expect(isBondGrade(other)).toBe(false);
  });

  it("makes a warm exchange worth more than a cold one costs", () => {
    expect(BOND_XP_BY_GRADE[1]).toBeGreaterThan(0);
    expect(BOND_XP_BY_GRADE[1]).toBeGreaterThan(Math.abs(BOND_XP_BY_GRADE[-1]) - 1);
    expect(BOND_XP_BY_GRADE[-1]).toBeLessThan(0);
  });

  it("pays nothing for presence alone", () => {
    expect(BOND_XP_BY_GRADE[0]).toBe(0);
  });
});

describe("level table", () => {
  it("buckets XP into the level it exactly reaches", () => {
    expect(bondLevelForXp(0)).toBe(1);
    expect(bondLevelForXp(119)).toBe(1);
    expect(bondLevelForXp(120)).toBe(2);
    expect(bondLevelForXp(319)).toBe(2);
    expect(bondLevelForXp(320)).toBe(3);
    expect(bondLevelForXp(600)).toBe(4);
    expect(bondLevelForXp(960)).toBe(5);
  });

  it("never goes below 1 or above the table", () => {
    expect(bondLevelForXp(-500)).toBe(1);
    expect(bondLevelForXp(999_999)).toBe(MAX_BOND_LEVEL);
  });

  it("reports the floor of the level the XP sits in", () => {
    expect(levelFloorForXp(0)).toBe(0);
    expect(levelFloorForXp(200)).toBe(120);
    expect(levelFloorForXp(MAX_BOND_XP)).toBe(BOND_LEVEL_XP[MAX_BOND_LEVEL - 1]);
  });
});

describe("recency", () => {
  it("reads off the clock, not off a stored gauge", () => {
    expect(recencyFor(0)).toBe("close");
    expect(recencyFor(2 * DAY)).toBe("close");
    expect(recencyFor(5 * DAY)).toBe("steady");
    expect(recencyFor(13 * DAY)).toBe("steady");
    expect(recencyFor(14 * DAY)).toBe("cool");
    expect(recencyFor(365 * DAY)).toBe("cool");
  });
});

describe("service day", () => {
  it("uses the KST calendar day, not UTC", () => {
    // 2026-08-02T16:00Z is already 2026-08-03 in Seoul.
    expect(serviceDate(Date.parse("2026-08-02T16:00:00Z"))).toBe("2026-08-03");
    expect(serviceDate(Date.parse("2026-08-02T14:00:00Z"))).toBe("2026-08-02");
  });
});

describe("nextBondState", () => {
  const base = {
    bondXp: 0,
    lastExchangeAtMs: Date.parse("2026-08-02T05:00:00Z"),
    dailyBondDate: "2026-08-02",
    dailyBondXp: 0,
  };
  const now = Date.parse("2026-08-02T06:00:00Z");

  const grade = (g: BondGrade, state = base) => nextBondState(state, { grade: g, nowMs: now });

  it("moves the bond by the grade the character reported", () => {
    expect(grade(2).bondXp).toBe(BOND_XP_BY_GRADE[2]);
    expect(grade(1).bondXp).toBe(BOND_XP_BY_GRADE[1]);
    expect(grade(0).bondXp).toBe(0);
  });

  it("marks the relationship as touched even on a grade of 0", () => {
    // Recency is read off this stamp, so a quiet hello still has to move it.
    expect(grade(0).lastExchangeAtMs).toBe(now);
  });

  it("takes XP back for a bad exchange", () => {
    const cooled = grade(-1, { ...base, bondXp: 200 });
    expect(cooled.bondXp).toBe(200 + BOND_XP_BY_GRADE[-1]);
    expect(cooled.bondLevel).toBe(2);
  });

  it("never drops a level that was earned", () => {
    // Level 2 starts at 120; two hostile turns cannot take the badge away.
    let state = { ...base, bondXp: 130 };
    for (let i = 0; i < 5; i += 1) state = { ...state, ...nextBondState(state, { grade: -2, nowMs: now }) };
    expect(state.bondXp).toBe(120);
    expect(bondLevelForXp(state.bondXp)).toBe(2);
  });

  it("cannot grind a month of relationship into one evening", () => {
    let state = { ...base };
    for (let i = 0; i < 100; i += 1) {
      state = { ...state, ...nextBondState(state, { grade: 2, nowMs: now }) };
    }
    expect(state.bondXp).toBe(DAILY_BOND_XP_CAP);
    expect(bondLevelForXp(state.bondXp)).toBe(1);
  });

  it("gives the allowance back on the next service day", () => {
    const spent = { ...base, dailyBondDate: "2026-08-01", dailyBondXp: DAILY_BOND_XP_CAP };
    expect(nextBondState(spent, { grade: 2, nowMs: now }).bondXp).toBe(BOND_XP_BY_GRADE[2]);
  });

  it("caps the gain rather than refusing it at the boundary", () => {
    const nearly = { ...base, dailyBondXp: DAILY_BOND_XP_CAP - 4 };
    const next = nextBondState(nearly, { grade: 2, nowMs: now });
    expect(next.bondXp).toBe(4);
    expect(next.dailyBondXp).toBe(DAILY_BOND_XP_CAP);
  });

  it("never caps a loss — the counter is there to stop farming, not to protect anyone", () => {
    const spent = { ...base, bondXp: 300, dailyBondXp: DAILY_BOND_XP_CAP };
    const next = nextBondState(spent, { grade: -2, nowMs: now });
    expect(next.bondXp).toBe(300 + BOND_XP_BY_GRADE[-2]);
    expect(next.dailyBondXp).toBe(DAILY_BOND_XP_CAP);
  });

  it("stops accumulating past the top of the table", () => {
    const maxed = { ...base, bondXp: MAX_BOND_XP };
    expect(nextBondState(maxed, { grade: 2, nowMs: now }).bondXp).toBe(MAX_BOND_XP);
  });

  it("stores the level alongside the XP for the other services", () => {
    expect(nextBondState({ ...base, bondXp: 112 }, { grade: 1, nowMs: now }).bondLevel).toBe(2);
  });
});

describe("prompt projection", () => {
  it("expresses an old friendship gone quiet — the state one axis cannot", () => {
    const now = Date.parse("2026-08-02T05:00:00Z");
    const snap = bondSnapshot({ bondXp: MAX_BOND_XP, lastExchangeAtMs: now - 30 * DAY }, now);
    expect(snap.level).toBe(5); // depth survives
    expect(snap.recency).toBe("cool"); // recency does not
  });

  it("treats a clock that ran backwards as contact just now", () => {
    const now = Date.parse("2026-08-02T05:00:00Z");
    expect(bondSnapshot({ bondXp: 0, lastExchangeAtMs: now + DAY }, now).recency).toBe("close");
  });
});
