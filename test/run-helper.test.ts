import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelper } from "../src/lib/run-helper.ts";

const dir = mkdtempSync(join(tmpdir(), "myday-helper-"));
function fake(name: string, body: string, mode = 0o755): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, mode);
  return p;
}

test("A-D-2 stdin JSON reaches the helper and arguments are never shell-expanded", async () => {
  const p = fake("echo-in", `printf '{"schema":1,"ok":true,"got":"%s","arg":"%s"}' "$(cat)" "$1"`);
  const r = await runHelper(p, ["$(whoami)"], { timeoutMs: 2000, input: { title: "x" } });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.stdout.includes('"arg":"$(whoami)"'));
  assert.ok(r.stdout.includes("title"));
});

test("missing helper, timeout and crash map to distinct failures", async () => {
  const missing = await runHelper(join(dir, "nope"), [], { timeoutMs: 1000 });
  assert.ok(!missing.ok && missing.failure.kind === "helper-missing");
  const slow = await runHelper(fake("slow", "sleep 5"), [], { timeoutMs: 300 });
  assert.ok(!slow.ok && slow.failure.kind === "timeout");
  const crash = await runHelper(fake("crash", "echo boom >&2; exit 3"), [], { timeoutMs: 1000 });
  assert.ok(!crash.ok && crash.failure.kind === "helper-error" && crash.failure.detail.includes("boom"));
});

test("non-zero exit with a JSON body is handed to the parser", async () => {
  const r = await runHelper(
    fake("usage", `echo '{"schema":1,"ok":false,"code":"denied","message":"no"}'; exit 2`),
    [],
    { timeoutMs: 1000 },
  );
  assert.ok(r.ok && r.stdout.includes("denied"));
});
