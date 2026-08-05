import * as readline from "node:readline";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../src/lib/auth/totp";

/**
 * Generates the OPT-IN second-factor secret for the login gate, in the same
 * shape auth:set-password generates the first factor: printed once for you to
 * put wherever this instance reads its environment, never stored by the
 * script, never in the database, never committed (HARD RULE).
 *
 * Enrollment is verified BEFORE you deploy anything: the script asks for one
 * code from the app you just added the secret to, so a mistyped secret is
 * caught here — not at tomorrow's locked-out login. The check runs entirely
 * offline (TOTP is arithmetic on a shared secret; nothing is sent anywhere).
 *
 * Recovery is operating your own infrastructure, by design: lose the
 * authenticator, and you remove AUTH_TOTP_SECRET from the deployment's
 * environment and redeploy. There is no in-app reset — an in-app backdoor
 * would be a second factor only for people who don't attack the app.
 *
 * Usage: npm run auth:set-totp
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const secret = generateTotpSecret();

  console.log("\nAdd this account to your authenticator app (Aegis, Google Authenticator,");
  console.log("1Password, …) by typing the secret in manually:\n");
  console.log(`  Secret (base32): ${secret}`);
  console.log(`  Type: time-based (TOTP), SHA-1, 6 digits, 30 seconds — every app's default.`);
  console.log(`\n  Or paste the full URI where the app accepts one:\n  ${otpauthUri(secret)}\n`);

  const code = (await prompt("Enter the 6-digit code the app now shows, to prove enrollment: ")).trim();
  if (verifyTotp(secret, code, Date.now(), 0) === null) {
    console.error(
      "\nThat code does not match this secret. NOT verified — do not deploy this secret.\n" +
        "Usual causes: a typo entering the secret, or the device clock is off. Run again.",
    );
    process.exit(1);
  }

  console.log("\nVerified. Add this to your .env (local) or Vercel Environment Variables:\n");
  console.log(`AUTH_TOTP_SECRET="${secret}"`);
  console.log(
    "\nEnabling or rotating it logs out every existing session (deliberate — see\n" +
      "docs/conventions/security-and-auth.md), and codes are one-use per login.",
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
