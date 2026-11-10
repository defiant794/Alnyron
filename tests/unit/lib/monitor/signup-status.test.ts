/**
 * Unit tests — monitorSignupStatus + countMonitorSignupStatuses (admin-monitor-users-cleanup)
 * Journey: admin-monitor-users-cleanup  AMC-1, AMC-2, AMC-3, AMC-4, AMC-5, AMC-6
 *
 * All boundary tests use fixed Date values — no real clock.
 */

import { describe, it, expect } from "vitest";
import {
  monitorSignupStatus,
  countMonitorSignupStatuses,
  type MonitorSignupStatus,
} from "@/lib/monitor/signup-status";
import { MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES } from "@/config/monitor";

// ── Fixed timestamps ───────────────────────────────────────────────────────────

/** An arbitrary fixed "now". */
const NOW = new Date("2026-11-10T12:00:00.000Z");

/** Exactly 10 minutes before NOW (the boundary — should be "expired"). */
const EXACTLY_10_MIN_BEFORE = new Date(NOW.getTime() - 10 * 60 * 1000);

/** 1 ms before the 10-minute boundary (should be "pending"). */
const JUST_BEFORE_BOUNDARY = new Date(NOW.getTime() - (10 * 60 * 1000 - 1));

/** Well within 10 minutes (5 min old — "pending"). */
const FIVE_MIN_BEFORE = new Date(NOW.getTime() - 5 * 60 * 1000);

/** 1 ms after NOW (future — should still be "pending"). */
const ONE_MS_FUTURE = new Date(NOW.getTime() + 1);

/** Confirmed old: 30 minutes before NOW but confirmed → "registered". */
const THIRTY_MIN_BEFORE = new Date(NOW.getTime() - 30 * 60 * 1000);

// ── AMC-5: MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES constant ─────────────────────

describe("AMC-5: MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES — constant literal is 10", () => {
  it("AMC-5: MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES === 10", () => {
    expect(MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES).toBe(10);
  });
});

// ── AMC-1: confirmed → "registered" ───────────────────────────────────────────

describe("AMC-1: monitorSignupStatus — confirmed signup returns 'registered'", () => {
  it("AMC-1a: confirmed=true, recent signup → 'registered'", () => {
    const result = monitorSignupStatus(
      { confirmed: true, signedUpAt: FIVE_MIN_BEFORE.toISOString() },
      NOW,
    );
    expect(result).toBe("registered");
  });

  it("AMC-1b: confirmed=true, old signup (30 min) → 'registered' regardless of age", () => {
    const result = monitorSignupStatus(
      { confirmed: true, signedUpAt: THIRTY_MIN_BEFORE.toISOString() },
      NOW,
    );
    expect(result).toBe("registered");
  });
});

// ── AMC-2: unconfirmed age < 10 min → "pending" ───────────────────────────────

describe("AMC-2: monitorSignupStatus — unconfirmed signup age < 10 min returns 'pending'", () => {
  it("AMC-2a: confirmed=false, age=5 min → 'pending'", () => {
    const result = monitorSignupStatus(
      { confirmed: false, signedUpAt: FIVE_MIN_BEFORE.toISOString() },
      NOW,
    );
    expect(result).toBe("pending");
  });

  it("AMC-2b: confirmed=false, age=9:59.999 (1 ms before boundary) → 'pending'", () => {
    const result = monitorSignupStatus(
      { confirmed: false, signedUpAt: JUST_BEFORE_BOUNDARY.toISOString() },
      NOW,
    );
    expect(result).toBe("pending");
  });
});

// ── AMC-3: unconfirmed age ≥ 10 min → "expired" ───────────────────────────────

describe("AMC-3: monitorSignupStatus — unconfirmed signup age ≥ 10 min returns 'expired'", () => {
  it("AMC-3a: confirmed=false, age=exactly 10:00 → 'expired'", () => {
    const result = monitorSignupStatus(
      { confirmed: false, signedUpAt: EXACTLY_10_MIN_BEFORE.toISOString() },
      NOW,
    );
    expect(result).toBe("expired");
  });

  it("AMC-3b: confirmed=false, age=30 min → 'expired'", () => {
    const result = monitorSignupStatus(
      { confirmed: false, signedUpAt: THIRTY_MIN_BEFORE.toISOString() },
      NOW,
    );
    expect(result).toBe("expired");
  });
});

// ── AMC-4: unconfirmed future signedUpAt → "pending" ─────────────────────────

describe("AMC-4: monitorSignupStatus — unconfirmed future signedUpAt returns 'pending'", () => {
  it("AMC-4: confirmed=false, signedUpAt 1 ms in the future → 'pending'", () => {
    const result = monitorSignupStatus(
      { confirmed: false, signedUpAt: ONE_MS_FUTURE.toISOString() },
      NOW,
    );
    expect(result).toBe("pending");
  });
});

// ── AMC-6: countMonitorSignupStatuses ─────────────────────────────────────────

describe("AMC-6: countMonitorSignupStatuses — counts each status correctly", () => {
  it("AMC-6a: empty array returns zeroed record", () => {
    const result = countMonitorSignupStatuses([]);
    expect(result).toEqual({ registered: 0, pending: 0, expired: 0 });
  });

  it("AMC-6b: mixed statuses count correctly", () => {
    const statuses: MonitorSignupStatus[] = [
      "registered",
      "registered",
      "pending",
      "expired",
      "expired",
      "expired",
    ];
    const result = countMonitorSignupStatuses(statuses);
    expect(result).toEqual({ registered: 2, pending: 1, expired: 3 });
  });

  it("AMC-6c: all same status (registered)", () => {
    const result = countMonitorSignupStatuses(["registered", "registered"]);
    expect(result).toEqual({ registered: 2, pending: 0, expired: 0 });
  });

  it("AMC-6d: single pending → zeroed for other statuses", () => {
    const result = countMonitorSignupStatuses(["pending"]);
    expect(result).toEqual({ registered: 0, pending: 1, expired: 0 });
  });
});
