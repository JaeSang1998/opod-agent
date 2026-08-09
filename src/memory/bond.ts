/**
 * Bond — the (user, character) relationship progression.
 *
 * One stored number: `bondXp`, projected onto a level 1..5. It moves by a grade
 * the character itself hands back at the end of every turn (`-2..+2`, see
 * chat/bond-signal.ts). The model that just read the exchange is the only judge
 * with the context to say whether it left the two of them closer, so it says so
 * — no second pass, no proxy metric, no extra call.
 *
 * Two rules keep the number honest:
 *
 *   A level, once reached, is never lost. XP may sag inside the level it earned
 *   — a bad week should cost something — but the floor holds. Watching a badge
 *   you spent three weeks on disappear is a betrayal; a relationship that has
 *   cooled is what `recency` is for.
 *
 *   Positive XP is capped per service day. A user who buys a stack of credits
 *   should not be able to compress a month of relationship into one evening,
 *   and a self-reported grade is exactly the kind of signal a determined user
 *   will try to talk the character into inflating.
 *
 * How recently they have been in touch is *derived* from the last exchange, not
 * accumulated: closeness is a thing you earn, recency is a thing you read off a
 * clock. Nothing to store, nothing to decay, nothing to farm.
 *
 * Pure math only — no store, no clock, no I/O. The caller owns where grades are
 * granted and how the level is surfaced.
 */

// ===== The grade =====

/**
 * What the character reports about the exchange it just had. Five steps, not
 * nine: a model can tell "they let me in" from "they were done talking", but it
 * cannot hold a stable opinion about the difference between +3 and +4.
 */
export type BondGrade = -2 | -1 | 0 | 1 | 2;

export function isBondGrade(value: number): value is BondGrade {
  return Number.isInteger(value) && value >= -2 && value <= 2;
}

/**
 * Grade → XP. Asymmetric on purpose: a warm exchange is worth more than a cold
 * one costs, because relationships should be easier to build than to break, and
 * a user who loses a week of progress to one awkward message leaves. Real
 * hostility is not a grade problem — that is what reporting and blocking are
 * for — but it should not read as free either.
 *
 * `0` is worth nothing at all. Presence is not progression: turning up and
 * typing "ㅇㅇ" for an hour must not level anything.
 */
export const BOND_XP_BY_GRADE: Readonly<Record<BondGrade, number>> = Object.freeze({
  "-2": -24,
  "-1": -8,
  0: 0,
  1: 8,
  2: 16,
});

// ===== Levels =====

/**
 * Cumulative XP to reach each level; the index is `level - 1`. A table rather
 * than a curve: five numbers you can read and retune in one place beat a
 * closed-form inversion nobody can picture. Spacing widens so later levels take
 * longer, and it stops at 5 — past "you go a long way back" there is nothing
 * left for a number to say.
 *
 * At the daily cap of genuine conversation that reads as
 *   L2 ~2d · L3 ~6d · L4 ~10d · L5 ~16d — "아는 사이"가 되는 데 일주일쯤.
 * Slower than a tamagotchi on purpose: DM contact is far less frequent than
 * tapping a creature, and a relationship that levels in a day cheapens it.
 */
export const BOND_LEVEL_XP: readonly number[] = Object.freeze([0, 120, 320, 600, 960]);

export const MAX_BOND_LEVEL = BOND_LEVEL_XP.length;

/** XP beyond the last threshold buys nothing, so it is never stored. */
export const MAX_BOND_XP = BOND_LEVEL_XP[MAX_BOND_LEVEL - 1] as number;

export function bondLevelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i < BOND_LEVEL_XP.length; i += 1) {
    if (xp >= (BOND_LEVEL_XP[i] as number)) level = i + 1;
  }
  return level;
}

/** XP floor of the level `xp` currently sits in — the line a dip cannot cross. */
export function levelFloorForXp(xp: number): number {
  return BOND_LEVEL_XP[bondLevelForXp(xp) - 1] as number;
}

// ===== Daily cap =====

/**
 * Ceiling on XP *gained* in one service day. Losses are never capped: they only
 * ever cost the person causing them, so there is nothing to farm, and a
 * character who has to stay polite about being insulted because of a counter
 * would read as broken.
 */
export const DAILY_BOND_XP_CAP = 60;

/**
 * Service-day key, `YYYY-MM-DD` in KST — the same convention
 * `credit_check_ins.check_in_date` uses, so "today" means one thing across the
 * product. Stored as a string rather than derived from a timestamp so a
 * timezone change can never silently roll the day. KST has no DST, so a fixed
 * offset is exact.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function serviceDate(nowMs: number): string {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ===== Recency =====

const DAY_MS = 24 * 60 * 60 * 1000;

/** How recently they have been in touch. Read from the clock, never stored. */
export type BondRecency = "close" | "steady" | "cool";

/** Talking this week is "close"; a fortnight of silence is "cool". */
const RECENCY_CLOSE_WITHIN_MS = 3 * DAY_MS;
const RECENCY_STEADY_WITHIN_MS = 14 * DAY_MS;

export function recencyFor(msSinceLastExchange: number): BondRecency {
  if (msSinceLastExchange < RECENCY_CLOSE_WITHIN_MS) return "close";
  if (msSinceLastExchange < RECENCY_STEADY_WITHIN_MS) return "steady";
  return "cool";
}

// ===== Projection for the prompt =====
// Both axes reach the prompt as labels, never as numbers. Handing a model
// "level 4, 72 xp" gets you a character who says "호감도 72%" out loud; handing
// it a band gets you a character who acts like it.

export interface BondSnapshot {
  level: number;
  recency: BondRecency;
}

export function bondSnapshot(
  state: { bondXp: number; lastExchangeAtMs: number },
  nowMs: number,
): BondSnapshot {
  return {
    level: bondLevelForXp(state.bondXp),
    recency: recencyFor(Math.max(0, nowMs - state.lastExchangeAtMs)),
  };
}

// ===== Grant =====

export interface BondStateSlice {
  bondXp: number;
  /** When they last traded messages — the only input `recency` has. */
  lastExchangeAtMs: number;
  dailyBondDate: string;
  /** Positive XP already granted on `dailyBondDate`. */
  dailyBondXp: number;
}

/**
 * `bondLevel` is derived from `bondXp` and stored anyway. It is denormalised on
 * purpose: opod-service-backend serves `GET /characters/:id/relationship` and
 * needs the level, and a stored column is the one way it can have it without a
 * second copy of this table living in another repo and drifting from this one.
 *
 * The cost is that retuning the table leaves stored levels stale until each
 * relationship's next grant. That is the better failure — nobody's level
 * silently drops the moment we redeploy.
 */
export type BondGrant = BondStateSlice & { bondLevel: number };

/**
 * The whole grant, as one pure step: turn the grade into XP, cap the gain
 * against the day's allowance, apply it without dropping below the current
 * level's floor, and hand back the row to persist. Both store adapters call
 * this so the policy lives in exactly one place and can be unit-tested without
 * a database.
 *
 * Called on *every* exchange, including grade 0 — `lastExchangeAtMs` is what
 * recency reads, so a quiet check-in still has to move it. Skipping the write
 * would leave a character acting distant with someone who just said hello.
 */
export function nextBondState(
  prev: BondStateSlice,
  input: { grade: BondGrade; nowMs: number },
): BondGrant {
  const today = serviceDate(input.nowMs);
  const earnedToday = prev.dailyBondDate === today ? prev.dailyBondXp : 0;

  const raw = BOND_XP_BY_GRADE[input.grade];
  const delta = raw > 0 ? Math.min(raw, Math.max(0, DAILY_BOND_XP_CAP - earnedToday)) : raw;

  const bondXp = Math.min(
    MAX_BOND_XP,
    Math.max(levelFloorForXp(prev.bondXp), prev.bondXp + delta),
  );

  return {
    bondXp,
    bondLevel: bondLevelForXp(bondXp),
    lastExchangeAtMs: input.nowMs,
    dailyBondDate: today,
    dailyBondXp: earnedToday + Math.max(0, delta),
  };
}
