/**
 * Test fixture shared by change-email.test.ts and signup-notice-email.test.ts: the email
 * layout of `renderEmail`, typed out, for the exact whole-email pins. Not a test file (the unit
 * project collects only `*.test.{ts,tsx}`).
 */

/** The shared email layout, typed out, around the card's content (`card` ends with a newline). */
export function emailDocument(title: string, card: string): string {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fb;color:#0b1d33;font-family:'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e9f0;border-radius:12px;">
<tr><td style="padding:32px 28px;font-size:16px;line-height:1.5;">
${card}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}
