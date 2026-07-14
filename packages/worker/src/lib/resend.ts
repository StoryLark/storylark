/** Minimal Resend sender — one dependency-free POST. */
export async function sendMail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return res.ok;
}

export function magicLinkEmail(appName: string, link: string, code: string): string {
  return `<!doctype html>
<body style="font-family: Georgia, serif; background:#f4f0e6; padding:32px; color:#23262d;">
  <div style="max-width:480px; margin:0 auto; background:#fbf8f1; border:1px solid #d8d1c0; border-radius:8px; padding:32px;">
    <h1 style="font-size:20px; margin:0 0 16px;">${appName}</h1>
    <p>Your sign-in code is:</p>
    <p style="text-align:center; margin:20px 0;">
      <span style="font-family: 'Courier New', monospace; font-size:34px; font-weight:bold; letter-spacing:8px; color:#8C4420;">${code}</span>
    </p>
    <p>Type this code into the app to sign in on the device you're reading on. The code works once and expires in 15 minutes.</p>
    <p style="margin:24px 0 8px; color:#7a7f88; font-size:14px;">Or, if you prefer, just tap the button:</p>
    <p style="text-align:center; margin:8px 0 24px;">
      <a href="${link}" style="background:#8C4420; color:#EDE6D6; text-decoration:none; padding:12px 28px; border-radius:6px; display:inline-block;">Sign in</a>
    </p>
    <p style="color:#7a7f88; font-size:13px;">If you didn't request this, you can ignore this email.</p>
  </div>
</body>`;
}

export function passwordResetEmail(appName: string, link: string, code: string): string {
  return `<!doctype html>
<body style="font-family: Georgia, serif; background:#f4f0e6; padding:32px; color:#23262d;">
  <div style="max-width:480px; margin:0 auto; background:#fbf8f1; border:1px solid #d8d1c0; border-radius:8px; padding:32px;">
    <h1 style="font-size:20px; margin:0 0 16px;">${appName}</h1>
    <p>We got a request to reset your password. Your reset code is:</p>
    <p style="text-align:center; margin:20px 0;">
      <span style="font-family: 'Courier New', monospace; font-size:34px; font-weight:bold; letter-spacing:8px; color:#8C4420;">${code}</span>
    </p>
    <p>Type this code into the app, on the same screen where you asked to reset, then choose a new password. The code works once and expires in 30 minutes.</p>
    <p style="margin:24px 0 8px; color:#7a7f88; font-size:14px;">Or, if you prefer, tap the button to set a new password:</p>
    <p style="text-align:center; margin:8px 0 24px;">
      <a href="${link}" style="background:#8C4420; color:#EDE6D6; text-decoration:none; padding:12px 28px; border-radius:6px; display:inline-block;">Reset password</a>
    </p>
    <p style="color:#7a7f88; font-size:13px;">If you didn't ask to reset your password, you can ignore this email. Your password stays the same.</p>
  </div>
</body>`;
}
