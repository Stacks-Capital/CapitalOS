import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/*
 * The design system claims WCAG 2.1 AA contrast. This reads the real stylesheet and checks it, so the
 * claim cannot drift away from the tokens. White on the accent was 3.18:1 when this was written, which
 * is what prompted the check.
 */

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function tokens(): Map<string, string> {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(root?.[1], "styles.css must declare tokens on :root");
  const found = new Map<string, string>();
  for (const line of root[1].split("\n")) {
    const match = /^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) found.set(match[1], match[2]);
  }
  return found;
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every pair the app actually paints, named by where it is painted. */
const PAIRS: Array<[string, string, string]> = [
  ["body text", "--text-primary", "--bg-app"],
  ["panel text", "--text-primary", "--bg-card"],
  ["secondary text on a panel", "--text-secondary", "--bg-card"],
  ["secondary text on a chip", "--text-secondary", "--bg-subtle"],
  ["muted text on a panel", "--text-muted", "--bg-card"],
  ["muted text on a chip", "--text-muted", "--bg-subtle"],
  ["healthy state text", "--success-text", "--bg-card"],
  ["warning text", "--warning-text", "--bg-card"],
  ["danger text", "--danger-text", "--bg-card"],
  ["primary button label", "--on-accent", "--accent"],
  ["primary button label while hovered", "--on-accent", "--accent-hover"],
];

describe("design system contrast", () => {
  const palette = tokens();

  it("declares every colour the pairs below are checked against", () => {
    for (const [, foreground, background] of PAIRS) {
      assert.ok(palette.get(foreground), `styles.css is missing ${foreground}`);
      assert.ok(palette.get(background), `styles.css is missing ${background}`);
    }
  });

  it("meets WCAG 2.1 AA for normal text on every painted pair", () => {
    const failures: string[] = [];
    for (const [where, foreground, background] of PAIRS) {
      const fg = palette.get(foreground);
      const bg = palette.get(background);
      if (fg === undefined || bg === undefined) continue;
      const ratio = contrast(fg, bg);
      if (ratio < 4.5) failures.push(`${where}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(failures, []);
  });

  it("never paints plain white on the accent, which is below AA", () => {
    const accent = palette.get("--accent");
    assert.ok(accent);
    assert.ok(contrast("#ffffff", accent) < 4.5, "this guard is pointless if white ever passes");
    assert.doesNotMatch(css, /background:\s*var\(--accent\);\s*\n\s*color:\s*#fff/, "use var(--on-accent)");
  });

  it("zeroes animation and transition for a reduced motion preference", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
