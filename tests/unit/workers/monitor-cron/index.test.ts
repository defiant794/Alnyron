/**
 * Unit tests: workers/monitor-cron/index.ts — scheduled handler
 * Journey: monitor-engine  ENG-AC6
 *
 * Covers: invalid env → scheduled() throws naming keys not values and never
 *   starts a run; valid env → scheduled() awaits one runMonitorChecks with the
 *   env-derived rpc, config and a mailer that sends through sendEmail with
 *   RESEND_API_KEY. The handler awaits the run itself (no ctx.waitUntil).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "@/lib/email/resend";
import type { RunSummary } from "../../../../workers/monitor-cron/run";

const RUN_SUMMARY: RunSummary = {
  claimed: 0, strikerClaimed: 0, checked: 0, unchanged: 0, baselines: 0, changed: 0,
  errors: 0, staleSkips: 0, emailsSent: 0, emailsDeferred: 0,
  emailsRejected: 0, errorEmails: 0, signupNotices: 0, signupNoticesDeferred: 0, purged: 0, mailStop: null,
  budgetStop: false, batchFull: false, subrequests: 0,
  rpcErrors: 0, durationMs: 1,
};

// Mock runMonitorChecks so the index handler doesn't attempt real Supabase/Resend calls.
vi.mock("../../../../workers/monitor-cron/run", () => ({
  runMonitorChecks: vi.fn(),
}));
vi.mock("../../../../workers/monitor-cron/rpc", () => ({
  createSupabaseEngineRpc: vi.fn(() => ({})),
}));
vi.mock("@/lib/email/resend", () => ({
  sendEmail: vi.fn(),
}));

import workerModule from "../../../../workers/monitor-cron/index";
// References to the mocked functions — resolved at vi.mock() time (hoisted).
import { runMonitorChecks } from "../../../../workers/monitor-cron/run";
import { createSupabaseEngineRpc } from "../../../../workers/monitor-cron/rpc";
import { sendEmail } from "@/lib/email/resend";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runMonitorChecks).mockResolvedValue(RUN_SUMMARY);
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "mocked" });
});

const VALID_ENV = {
  SUPABASE_URL: "https://giokcppmmzrrknmllfjc.supabase.co",
  SUPABASE_SECRET_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
  RESEND_API_KEY: "re_test_abc",
  MAIL_FROM: "Alnyron <noreply@send.alnyron.dk>",
  MONITOR_SITE_URL: "https://alnyron.dk",
  MONITOR_BATCH_SIZE: "2",
  MONITOR_SUBREQUEST_LIMIT: "50",
};

// ── Invalid env → throws naming the key ──────────────────────────────────────

describe("scheduled handler — ENG-AC6: invalid env → throws naming keys, never values", () => {
  /** The env error of parseMonitorCronEnv: the keys only. */
  const envError = (key: string) => new Error(`monitor-cron: missing or invalid environment keys: ${key}`);

  it("ENG-AC6idx1: missing SUPABASE_SECRET_KEY → throws the error naming SUPABASE_SECRET_KEY", async () => {
    const badEnv = { ...VALID_ENV, SUPABASE_SECRET_KEY: undefined };
    await expect(workerModule.scheduled({}, badEnv, {})).rejects.toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  it("ENG-AC6idx2: invalid SUPABASE_URL → throws the error naming SUPABASE_URL, not the value", async () => {
    const badEnv = { ...VALID_ENV, SUPABASE_URL: "not-a-url" };
    await expect(workerModule.scheduled({}, badEnv, {})).rejects.toThrow(envError("SUPABASE_URL"));
  });

  it("ENG-AC6idx3: invalid env → no rpc client is built and runMonitorChecks is never called", async () => {
    const badEnv = { ...VALID_ENV, RESEND_API_KEY: "" };
    await expect(workerModule.scheduled({}, badEnv, {})).rejects.toThrow(envError("RESEND_API_KEY"));
    expect(createSupabaseEngineRpc).not.toHaveBeenCalled();
    expect(runMonitorChecks).not.toHaveBeenCalled();
  });
});

// ── Valid env → engine functions called with env-derived args ────────────────

describe("scheduled handler — ENG-AC6: valid env → one awaited run wired from the env", () => {
  it("ENG-AC6idx4: rpc from URL + secret key; config from the vars; mailer sends via sendEmail with RESEND_API_KEY", async () => {
    await workerModule.scheduled({}, VALID_ENV, {});

    expect(createSupabaseEngineRpc).toHaveBeenCalledTimes(1);
    expect(createSupabaseEngineRpc).toHaveBeenCalledWith(
      VALID_ENV.SUPABASE_URL,
      VALID_ENV.SUPABASE_SECRET_KEY,
    );
    expect(runMonitorChecks).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(runMonitorChecks).mock.calls[0]![0];
    expect(deps.rpc).toBe(vi.mocked(createSupabaseEngineRpc).mock.results[0]!.value);
    expect(deps.config).toEqual({
      batchSize: 2, // coerced from "2"
      subrequestLimit: 50, // coerced from "50"
      siteUrl: VALID_ENV.MONITOR_SITE_URL,
      mailFrom: VALID_ENV.MAIL_FROM,
    });

    const message: EmailMessage = {
      from: VALID_ENV.MAIL_FROM,
      to: "user@example.com",
      subject: "Subject",
      html: "<p>Body</p>",
      text: "Body",
    };
    await expect(deps.mailer(message, "monitor-event/evt-1")).resolves.toEqual({ ok: true, id: "mocked" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(VALID_ENV.RESEND_API_KEY, message, "monitor-event/evt-1");
  });

  it("ENG-AC6idx5: scheduled() resolves only after the run has finished", async () => {
    const run = Promise.withResolvers<RunSummary>();
    vi.mocked(runMonitorChecks).mockImplementationOnce(() => run.promise);
    let settled = false;
    const handled = workerModule.scheduled({}, VALID_ENV, {}).then(() => { settled = true; });

    await vi.waitFor(() => expect(runMonitorChecks).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    run.resolve(RUN_SUMMARY);
    await handled;
    expect(settled).toBe(true);
  });
});
