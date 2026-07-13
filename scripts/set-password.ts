import { randomBytes } from "node:crypto";
import * as readline from "node:readline";
import { hashPassword } from "../src/lib/auth/password";

/**
 * Generates the auth secrets for cloud mode without ever writing or echoing the
 * password. YOU type the password into this terminal (input is muted); the
 * script prints the scrypt hash + a fresh session secret for you to paste into
 * .env (locally) or your Vercel env vars. The plaintext password is never stored.
 *
 * Usage: npm run auth:set-password
 */
function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = asMutable._writeToOutput?.bind(rl);
  process.stdout.write(question);
  asMutable._writeToOutput = () => {}; // mute keystroke echo
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      asMutable._writeToOutput = original;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const password = (await promptHidden("Choose an app password: ")).trim();
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const confirm = (await promptHidden("Confirm password: ")).trim();
  if (confirm !== password) {
    console.error("Passwords did not match.");
    process.exit(1);
  }

  const hash = hashPassword(password);
  const sessionSecret = randomBytes(32).toString("hex");

  console.log("\nAdd these to your .env (local) or Vercel Environment Variables:\n");
  console.log(`AUTH_PASSWORD_HASH="${hash}"`);
  console.log(`SESSION_SECRET="${sessionSecret}"`);
  console.log("\nKeep SESSION_SECRET private — rotating it logs out all sessions.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
