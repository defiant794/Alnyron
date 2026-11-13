/**
 * Unit tests: src/lib/payments/stripe-signature.ts — verifyStripeSignature
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC3a..WH-AC3m, WH-AC3-pass1, WH-AC3-wrong-secret, WH-AC3d2, WH-AC3g2, WH-AC3i4, WH-AC3k2
 *
 * Tests compute expected HMACs independently with node:crypto createHmac
 * (key = full whsec_… string as UTF-8, message = `${t}.${payload}`).
 * The production code uses crypto.subtle.verify (constant-time WebCrypto).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyStripeSignature } from "@/lib/payments/stripe-signature";

import { signStripeHeader } from "../../../helpers/stripe-webhook";

const WHSEC_FX = "whsec_testSig1234";
const NOW = 1_700_000_000;
const PAYLOAD = '{"id":"evt_001","type":"customer.subscription.updated"}';

/** Compute the expected hex HMAC independently. */
function hmac(payload: string, secret: string, t: number): string {
  return createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
}

// ── WH-AC3a: missing / empty header ──────────────────────────────────────────

describe("WH-AC3a: missing or empty stripe-signature header → missing_header", () => {
  it("WH-AC3a1: null header → { ok: false, reason: 'missing_header' }", async () => {
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: null,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "missing_header" });
  });

  it("WH-AC3a2: empty string header → { ok: false, reason: 'missing_header' }", async () => {
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: "",
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "missing_header" });
  });
});

// ── WH-AC3b: malformed header ─────────────────────────────────────────────────

describe("WH-AC3b: malformed header → malformed_header", () => {
  it("WH-AC3b1: no t field → malformed_header", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3b2: non-integer t (float) → malformed_header", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=1700000000.5,v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3b3: non-integer t (string 'abc') → malformed_header", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=abc,v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3b4: has valid t but no v1 entries (only v0) → malformed_header", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},v0=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3b5: item without '=' → malformed_header", async () => {
    // A8: a header item without `=` is not a valid key=value pair → malformed_header.
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},nodotequals,v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3b6: duplicate t entries → malformed_header", async () => {
    // Two `t=` entries: ambiguous timestamp → malformed_header.
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},t=${NOW},v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3b7: empty key '=value' → malformed_header", async () => {
    // An item like `=something` has no key → malformed_header.
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},=emptykey,v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });
});


// ── WH-AC3c / WH-AC3d / WH-AC3e: tolerance window ───────────────────────────

describe("WH-AC3c: stale past timestamp → stale_timestamp (signature is correct)", () => {
  it("WH-AC3c: |now − t| > tolerance (301 s past) → stale_timestamp", async () => {
    const t = NOW - 301;
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, t);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

describe("WH-AC3d: timestamp exactly at tolerance boundary → ok", () => {
  it("WH-AC3d: |now − t| == tolerance (300 s past) → { ok: true }", async () => {
    const t = NOW - 300;
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, t);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toMatchObject({ ok: true });
  });
});

describe("WH-AC3e: future timestamp beyond tolerance → stale_timestamp", () => {
  it("WH-AC3e: |now − t| > tolerance (301 s future) → stale_timestamp", async () => {
    const t = NOW + 301;
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, t);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

// ── WH-AC3f: check ORDER — shape → sig match → timestamp ─────────────────────

describe("WH-AC3f: check order is shape → signature → timestamp", () => {
  it("WH-AC3f1: correctly signed stale event → stale_timestamp (not no_signature_match)", async () => {
    // The signature is correct but the timestamp is 1 hour old.
    const t = NOW - 3600;
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, t);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    // Correctly signed → passes sig check → reaches timestamp check → stale_timestamp.
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("WH-AC3f2: wrongly signed AND stale event → no_signature_match (not stale_timestamp)", async () => {
    const t = NOW - 3600;
    const badSig = "a".repeat(64); // 64 hex chars but wrong
    const header = `t=${t},v1=${badSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    // Wrong sig → fails sig check → never reaches timestamp check → no_signature_match.
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });
});

// ── WH-AC3g: tampered body ────────────────────────────────────────────────────

describe("WH-AC3g: correct signature over DIFFERENT body fails", () => {
  it("WH-AC3g: sig computed over other body, presented for this body → no_signature_match", async () => {
    const otherBody = '{"id":"evt_other"}';
    const header = signStripeHeader(otherBody, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });
});

// ── WH-AC3h: multiple v1 entries, one correct ────────────────────────────────

describe("WH-AC3h: any v1 match passes", () => {
  it("WH-AC3h: second v1 is correct, first is wrong → { ok: true }", async () => {
    const badSig = "b".repeat(64);
    const goodSig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const header = `t=${NOW},v1=${badSig},v1=${goodSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toMatchObject({ ok: true });
  });
});

// ── WH-AC3i / WH-AC3j: v1 of wrong length/non-hex is SKIPPED ────────────────

describe("WH-AC3i: v1 that is not 64 hex chars is skipped (not malformed_header)", () => {
  it("WH-AC3i1: v1 of 32 chars (too short) → skipped → no_signature_match when no other v1", async () => {
    const shortSig = "a".repeat(32);
    const header = `t=${NOW},v1=${shortSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    // Skipped → no matching v1 → no_signature_match, NOT malformed_header
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });

  it("WH-AC3i2: v1 of 128 chars (too long) → skipped → no_signature_match", async () => {
    const longSig = "c".repeat(128);
    const header = `t=${NOW},v1=${longSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });

  it("WH-AC3i3: v1 containing non-hex chars (zz...) → skipped → no_signature_match", async () => {
    const nonHexSig = "z".repeat(64);
    const header = `t=${NOW},v1=${nonHexSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });
});

describe("WH-AC3j: wrong-length v1 mixed with one valid v1 → valid one passes", () => {
  it("WH-AC3j: short invalid v1 + correct 64-char v1 → { ok: true }", async () => {
    const shortBad = "d".repeat(32);
    const goodSig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const header = `t=${NOW},v1=${shortBad},v1=${goodSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toMatchObject({ ok: true });
  });
});

// ── WH-AC3k: HMAC key is FULL whsec_… string (not stripped, not base64) ──────

describe("WH-AC3k: HMAC key is full whsec_… string as UTF-8", () => {
  it("WH-AC3k: a signature computed with the prefix-stripped key fails (key is not base64-decoded)", async () => {
    // Strip the "whsec_" prefix — if the production code stripped the prefix,
    // this sig would match; it must not.
    const strippedSecret = WHSEC_FX.replace("whsec_", "");
    const sigWithStripped = hmac(PAYLOAD, strippedSecret, NOW);
    const header = `t=${NOW},v1=${sigWithStripped}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    // If production strips the prefix, this would succeed — it must fail.
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });

  it("WH-AC3k2: a signature computed with the full whsec_ key succeeds", async () => {
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toMatchObject({ ok: true, timestamp: NOW });
  });
});

// ── WH-AC3l: constant-time compare via crypto.subtle.verify ──────────────────

describe("WH-AC3l: comparison uses crypto.subtle.verify (constant-time), not string equality", () => {
  it("WH-AC3l: crypto.subtle.verify is called for a 64-char hex v1 candidate", async () => {
    const verifySpy = vi.spyOn(crypto.subtle, "verify");
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, NOW);
    await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    // Must have been called at least once — proves constant-time WebCrypto path is used.
    expect(verifySpy).toHaveBeenCalled();
    verifySpy.mockRestore();
  });
});

// ── WH-AC3m: v0 and other non-v1 signatures are ignored ──────────────────────

describe("WH-AC3m: v0 and other non-v1 entries are silently ignored", () => {
  it("WH-AC3m1: only v0 present (valid HMAC) → malformed_header (no v1)", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},v0=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("WH-AC3m2: v0 ignored, v1 correct → { ok: true }", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},v0=ignored_value,v1=${sig}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toMatchObject({ ok: true });
  });
});

// WH-AC3n: STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300 — pinned in tests/unit/config/payments.test.ts (WH-AC27b).

// ── WH-AC3-pass: happy path + missing boundary cases ─────────────────────────

describe("WH-AC3-pass: valid signature with fresh timestamp → { ok:true, timestamp } (toEqual, not toMatchObject)", () => {
  it("WH-AC3-pass1: valid sig + fresh timestamp → { ok: true, timestamp: NOW }", async () => {
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: true, timestamp: NOW });
  });
});

describe("WH-AC3-wrong-secret: signature with a different whsec_ → no_signature_match", () => {
  it("WH-AC3-wrong-secret: different secret → no_signature_match", async () => {
    const otherWhsec = "whsec_diffSig1234";
    const header = signStripeHeader(PAYLOAD, otherWhsec, NOW);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX, // correct secret, wrong sig
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });
});

describe("WH-AC3d2: timestamp exactly at future tolerance boundary (t = now + 300) → ok", () => {
  it("WH-AC3d2: t = NOW + 300 (at future boundary) → { ok: true }", async () => {
    const t = NOW + 300;
    const header = signStripeHeader(PAYLOAD, WHSEC_FX, t);
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: true, timestamp: t });
  });
});

describe("WH-AC3i4: uppercase hex v1 (64 uppercase chars) → accepted when HMAC matches", () => {
  it("WH-AC3i4: uppercase valid sig → { ok: true, timestamp }", async () => {
    // contract: lowercase-or-uppercase hex; uppercase the independently-computed HMAC
    const correctSig = createHmac("sha256", WHSEC_FX).update(`${NOW}.${PAYLOAD}`, "utf8").digest("hex").toUpperCase();
    const header = `t=${NOW},v1=${correctSig}`;
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: true, timestamp: NOW });
  });
});

describe("WH-AC3g2: tampered sig (one char flipped in valid sig) → no_signature_match", () => {
  it("WH-AC3g2: flip one char in a correct 64-hex sig → no_signature_match", async () => {
    const correct = createHmac("sha256", WHSEC_FX).update(`${NOW}.${PAYLOAD}`, "utf8").digest("hex");
    // Flip last char: 'a'→'b', anything else→'a'
    const flipped = correct.slice(0, -1) + (correct.endsWith("a") ? "b" : "a");
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},v1=${flipped}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: false, reason: "no_signature_match" });
  });
});

// ── WH-AC_A18a: > STRIPE_WEBHOOK_MAX_SIGNATURES v1 entries → malformed_header ─

describe("WH-AC_A18a: more than STRIPE_WEBHOOK_MAX_SIGNATURES (8) v1 entries → malformed_header before HMAC", () => {
  it("WH-AC_A18a: 9 v1 entries → malformed_header; crypto.subtle.verify and importKey not called", async () => {
    // A18: more than 8 v1 entries must be rejected BEFORE any HMAC computation.
    const verifySpy = vi.spyOn(crypto.subtle, "verify");
    const importKeySpy = vi.spyOn(crypto.subtle, "importKey");
    try {
      const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
      // 9 v1 entries: one valid + eight junk (> STRIPE_WEBHOOK_MAX_SIGNATURES = 8)
      const v1Parts = [
        ...Array.from({ length: 8 }, () => `v1=${"0".repeat(64)}`),
        `v1=${sig}`,
      ];
      const header = `t=${NOW},${v1Parts.join(",")}`;
      const r = await verifyStripeSignature({
        payload: PAYLOAD,
        header,
        secret: WHSEC_FX,
        nowSeconds: NOW,
        toleranceSeconds: 300,
      });
      expect(r).toEqual({ ok: false, reason: "malformed_header" });
      expect(verifySpy).not.toHaveBeenCalled();
      expect(importKeySpy).not.toHaveBeenCalled();
    } finally {
      verifySpy.mockRestore();
      importKeySpy.mockRestore();
    }
  });

  it("WH-AC_A18a-boundary: exactly 8 v1 entries (7 junk + the valid one last) → ok", async () => {
    const sig = hmac(PAYLOAD, WHSEC_FX, NOW);
    const v1Parts = [...Array.from({ length: 7 }, () => `v1=${"0".repeat(64)}`), `v1=${sig}`];
    const r = await verifyStripeSignature({
      payload: PAYLOAD,
      header: `t=${NOW},${v1Parts.join(",")}`,
      secret: WHSEC_FX,
      nowSeconds: NOW,
      toleranceSeconds: 300,
    });
    expect(r).toEqual({ ok: true, timestamp: NOW });
  });
});
