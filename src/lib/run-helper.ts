// Runs the bundled helper once per call: no shell, fixed arguments, optional JSON on stdin, hard timeout.
// Pure Node (no Raycast imports) so tests can drive it with fake helpers.
import { execFile } from "node:child_process";
import { chmodSync, statSync } from "node:fs";

export type RunFailureKind = "helper-missing" | "helper-not-executable" | "timeout" | "helper-error";
export interface RunFailure {
  kind: RunFailureKind;
  detail: string;
}
export type RunResult = { ok: true; stdout: string } | { ok: false; failure: RunFailure };

export const READ_TIMEOUT_MS = 15_000;
export const WRITE_TIMEOUT_MS = 20_000;
/** The permission request waits for the user to answer the system dialog. */
export const ACCESS_TIMEOUT_MS = 180_000;

/** Restores the execute bit if a copy step dropped it. */
export function ensureExecutable(helperPath: string): void {
  try {
    const { mode } = statSync(helperPath);
    if ((mode & 0o100) === 0) chmodSync(helperPath, mode | 0o755);
  } catch {
    // Missing file or failed chmod: execFile reports ENOENT or EACCES below.
  }
}

export interface RunOptions {
  timeoutMs: number;
  /** Serialized as JSON and written to the helper's stdin. User text travels here, never in arguments. */
  input?: unknown;
}

export function runHelper(helperPath: string, args: string[], options: RunOptions): Promise<RunResult> {
  ensureExecutable(helperPath);
  return new Promise((resolve) => {
    const child = execFile(
      helperPath,
      args,
      { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (err.code === "ENOENT") return resolve(fail("helper-missing", `Helper not found at ${helperPath}`));
        if (err.code === "EACCES") return resolve(fail("helper-not-executable", "Helper is not executable"));
        if (err.killed || err.signal === "SIGKILL" || err.signal === "SIGTERM") {
          return resolve(fail("timeout", `Helper did not answer within ${Math.round(options.timeoutMs / 1000)} s`));
        }
        // Non-zero exit that still printed JSON (structured failures): let the parser report it.
        if (typeof stdout === "string" && stdout.trim().startsWith("{")) return resolve({ ok: true, stdout });
        resolve(
          fail(
            "helper-error",
            String(stderr || err.message)
              .trim()
              .slice(0, 400),
          ),
        );
      },
    );
    if (child.stdin) {
      if (options.input !== undefined) {
        child.stdin.on("error", () => {
          /* helper exited before reading; the exit handler reports it */
        });
        child.stdin.end(JSON.stringify(options.input));
      } else {
        child.stdin.end();
      }
    }
  });
}

function fail(kind: RunFailureKind, detail: string): RunResult {
  return { ok: false, failure: { kind, detail } };
}
