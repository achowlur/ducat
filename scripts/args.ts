/** Shared CLI argument reading for the scripts in this directory. */

/** `--name=value` → "value"; undefined when the flag is absent. */
export function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

/** Presence of a bare `--name` flag. */
export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
