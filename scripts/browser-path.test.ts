import { describe, expect, test } from "bun:test";

import {
  browserExecutableCandidates,
  resolveBrowserExecutable,
} from "./browser-path.mjs";

describe("cross-platform Chromium browser discovery", () => {
  test("explicit override always has the highest priority", () => {
    const resolved = resolveBrowserExecutable({
      platform: "linux",
      environment: {
        LORE_CLIENT_BROWSER_PATH: "/opt/chrome-for-testing/chrome",
      },
      isExecutable: (candidate) =>
        candidate === "/opt/chrome-for-testing/chrome",
    });

    expect(resolved).toBe("/opt/chrome-for-testing/chrome");
  });

  test("Windows falls back from the user directory to system Edge", () => {
    const environment = {
      LOCALAPPDATA: "D:\\Users\\tester\\AppData\\Local",
      ProgramFiles: "D:\\Program Files",
      "ProgramFiles(x86)": "D:\\Program Files (x86)",
    };
    const expected = "D:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
    const resolved = resolveBrowserExecutable({
      platform: "win32",
      environment,
      isExecutable: (candidate) => candidate === expected,
    });

    expect(resolved).toBe(expected);
  });

  test("macOS uses the actual executable inside the application bundle", () => {
    const expected =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const resolved = resolveBrowserExecutable({
      platform: "darwin",
      environment: { HOME: "/Users/tester" },
      isExecutable: (candidate) => candidate === expected,
    });

    expect(resolved).toBe(expected);
  });

  test("Linux supports common Chromium command names", () => {
    const resolved = resolveBrowserExecutable({
      platform: "linux",
      environment: {},
      isExecutable: (candidate) => candidate === "chromium-browser",
    });

    expect(resolved).toBe("chromium-browser");
  });

  test("candidate paths use target-platform separators instead of host separators", () => {
    const windowsCandidates = browserExecutableCandidates("win32", {
      ProgramFiles: "C:\\Apps",
    });
    const macCandidates = browserExecutableCandidates("darwin", {
      HOME: "/Users/tester",
    });

    expect(windowsCandidates).toContain(
      "C:\\Apps\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(macCandidates).toContain(
      "/Users/tester/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  });

  test("missing browser returns an actionable configuration hint", () => {
    expect(() =>
      resolveBrowserExecutable({
        platform: "linux",
        environment: {},
        isExecutable: () => false,
      }),
    ).toThrow("LORE_CLIENT_BROWSER_PATH");
  });
});
