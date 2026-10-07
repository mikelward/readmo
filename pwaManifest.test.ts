// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pwaManifest } from "./vite.config";

// The launch splash and the pre-stylesheet canvas are painted before any of
// the app's CSS exists, so their colors are copies of the `--rm-bg` tokens.
// These tests are what keeps the copies from drifting when a token moves.

const css = readFileSync(
  new URL("./src/styles/global.css", import.meta.url),
  "utf8",
);
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

/** `--rm-bg` declared in the first CSS block whose selector is exactly `selector`. */
function rmBg(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no "${selector}" block in global.css`).toBeGreaterThanOrEqual(
    0,
  );
  const block = css.slice(start, css.indexOf("}", start));
  const match = /--rm-bg:\s*(#[0-9a-f]{6})\s*;/i.exec(block);
  expect(match, `no --rm-bg in "${selector}"`).not.toBeNull();
  return match![1].toLowerCase();
}

describe("PWA manifest colors", () => {
  const light = rmBg(":root");
  const dark = rmBg(":root[data-theme='dark']");

  it("reads two different tokens (guards a parse that matched the same block twice)", () => {
    expect(light).not.toBe(dark);
  });

  it("paints the splash and title bar with the light page background", () => {
    expect(pwaManifest.background_color).toBe(light);
    expect(pwaManifest.theme_color).toBe(light);
  });

  it("switches both to the dark page background when the OS is dark", () => {
    const darkPair = { background_color: dark, theme_color: dark };
    expect(pwaManifest.color_scheme_dark).toEqual(darkPair);
    // The nested form is the one Chromium's parser reads today.
    expect(pwaManifest.user_preferences.color_scheme_dark).toEqual(darkPair);
  });
});

describe("index.html pre-stylesheet canvas", () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  const fallbacks = [
    ...style.matchAll(/var\(--rm-bg,\s*(#[0-9a-f]{6})\)/gi),
  ].map((m) => m[1].toLowerCase());

  it("falls back to the light token by default and the dark one for dark", () => {
    // Order matches the rules: bare html, explicit dark, system dark.
    expect(fallbacks).toEqual([
      rmBg(":root"),
      rmBg(":root[data-theme='dark']"),
      rmBg(":root[data-theme='dark']"),
    ]);
  });

  it("lets an explicit Light choice beat a dark OS", () => {
    expect(style).toContain("html:not([data-theme='light'])");
  });
});
