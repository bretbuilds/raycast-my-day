import { test } from "node:test";
import assert from "node:assert/strict";
import {
  columnWidth,
  COLUMN_GAP,
  EMPTY_LABEL_NUDGE,
  padTo,
  rangeLabel,
  textWidth,
  withColumn,
} from "../src/lib/columns.ts";

const at = (h: number, m = 0) => new Date(2026, 9, 4, h, m);
const visible = (s: string) => s.replace(/[\u2002\u2003\u2008\u2009\u200A\u200D]/g, "");

test("padding reaches the target width within a hair space and never uses collapsible ASCII runs", () => {
  for (const s of ["Any time", "Mon 5 Oct", "11:11 AM", "", "28 Oct – 19 Nov"]) {
    const p = padTo(s, 150);
    assert.ok(Math.abs(textWidth(p) - 150) < 0.9, `${s}: ${textWidth(p)}`);
    assert.ok(!/ {2}/.test(p));
  }
});

test("every left label puts the title at the same offset in both clock styles", () => {
  for (const use24 of [false, true]) {
    const target = columnWidth(use24) + COLUMN_GAP;
    const labels = [
      rangeLabel(at(2, 15), at(2, 45), use24),
      rangeLabel(at(11, 11), at(12), use24),
      rangeLabel(at(10), null, use24),
      "Any time",
      "Mon 5 Oct",
      "Wed 28 Oct",
      "28 Oct – 19 Nov",
      "",
    ];
    for (const l of labels) {
      const t = withColumn(l, "Title", use24);
      const offset = textWidth(t.slice(0, t.length - "Title".length));
      const expected = target + (l ? 0 : EMPTY_LABEL_NUDGE);
      assert.ok(Math.abs(offset - expected) < 0.9, `${use24} [${visible(l)}] ${offset} vs ${expected}`);
      assert.ok(t.endsWith("Title"));
    }
  }
});

test("ranges use natural spacing", () => {
  assert.equal(visible(rangeLabel(at(1, 11), at(2), false)), "1:11 AM – 2:00 AM");
  assert.equal(rangeLabel(at(14, 15), at(14, 45), false), "2:15 PM – 2:45 PM");
  assert.equal(visible(rangeLabel(at(14), at(15), true)), "14:00 – 15:00");
});
