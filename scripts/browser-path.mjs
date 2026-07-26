import { accessSync, constants } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * 按目标平台读取环境变量。
 *
 * Windows 环境变量名不区分大小写，但测试注入的普通对象会区分；这里统一兼容，
 * 避免 `ProgramFiles`、`PROGRAMFILES` 或 `Path` 的大小写差异改变浏览器发现结果。
 */
function readEnvironmentValue(environment, ...names) {
  for (const name of names) {
    const directValue = environment[name];
    if (typeof directValue === "string" && directValue.trim()) {
      return directValue;
    }
  }

  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const matchedEntry = Object.entries(environment).find(
    ([name, value]) =>
      normalizedNames.has(name.toLowerCase()) &&
      typeof value === "string" &&
      value.trim(),
  );
  return matchedEntry?.[1];
}

function uniqueCandidates(candidates) {
  return candidates.filter(
    (candidate, index) =>
      Boolean(candidate) && candidates.indexOf(candidate) === index,
  );
}

/**
 * 返回目标平台的常见 Chromium 浏览器位置。
 *
 * 候选路径使用目标平台自己的 path 实现构造，而不是当前执行测试的平台；
 * 这样 Windows 上也能可靠测试 macOS/Linux 候选，反之亦然。
 */
export function browserExecutableCandidates(
  platform,
  environment = process.env,
) {
  if (platform === "win32") {
    const programFiles =
      readEnvironmentValue(environment, "ProgramFiles") ??
      "C:\\Program Files";
    const programFilesX86 =
      readEnvironmentValue(environment, "ProgramFiles(x86)") ??
      "C:\\Program Files (x86)";
    const localAppData = readEnvironmentValue(environment, "LOCALAPPDATA");
    const roots = uniqueCandidates([
      localAppData,
      programFiles,
      programFilesX86,
    ]);

    return uniqueCandidates([
      ...roots.flatMap((root) => [
        win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        win32.join(
          root,
          "Google",
          "Chrome for Testing",
          "Application",
          "chrome.exe",
        ),
        win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        win32.join(root, "Chromium", "Application", "chrome.exe"),
      ]),
      "chrome.exe",
      "msedge.exe",
      "chromium.exe",
    ]);
  }

  if (platform === "darwin") {
    const home = readEnvironmentValue(environment, "HOME");
    const userApplications = home
      ? posix.join(home, "Applications")
      : undefined;
    const applicationRoots = uniqueCandidates([
      userApplications,
      "/Applications",
    ]);

    return uniqueCandidates([
      ...applicationRoots.flatMap((root) => [
        posix.join(
          root,
          "Google Chrome.app",
          "Contents",
          "MacOS",
          "Google Chrome",
        ),
        posix.join(
          root,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
        posix.join(
          root,
          "Microsoft Edge.app",
          "Contents",
          "MacOS",
          "Microsoft Edge",
        ),
        posix.join(
          root,
          "Chromium.app",
          "Contents",
          "MacOS",
          "Chromium",
        ),
      ]),
      "google-chrome",
      "chromium",
      "microsoft-edge",
    ]);
  }

  // Linux 发行版使用的可执行文件名并不统一，按常见安装方式依次探测。
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
  ];
}

function canAccessExecutable(path, platform) {
  try {
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查绝对路径或 PATH 中的命令是否可执行。
 *
 * Windows 的 PATH 分隔符和 PATHEXT 与 Unix 不同，因此不能使用当前宿主的
 * `node:path` 默认实现来推断另一个目标平台。
 */
export function executableExists(
  candidate,
  platform,
  environment = process.env,
) {
  const pathApi = platform === "win32" ? win32 : posix;
  if (
    pathApi.isAbsolute(candidate) ||
    candidate.includes("/") ||
    candidate.includes("\\")
  ) {
    return canAccessExecutable(candidate, platform);
  }

  const pathValue = readEnvironmentValue(environment, "PATH", "Path") ?? "";
  const pathDirectories = pathValue
    .split(pathApi.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean);
  const extensions =
    platform === "win32" && !win32.extname(candidate)
      ? (readEnvironmentValue(environment, "PATHEXT") ??
          ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];

  return pathDirectories.some((directory) =>
    extensions.some((extension) =>
      canAccessExecutable(pathApi.join(directory, candidate + extension), platform),
    ),
  );
}

/**
 * 解析 UI 验收使用的 Chromium 浏览器。
 *
 * 显式覆盖仍需经过存在性校验，使配置错误在启动子进程前就返回带平台与候选路径
 * 的诊断，而不是只得到难以定位的 ENOENT。
 */
export function resolveBrowserExecutable({
  platform = process.platform,
  environment = process.env,
  isExecutable = executableExists,
} = {}) {
  const override = readEnvironmentValue(
    environment,
    "LORE_CLIENT_BROWSER_PATH",
  );
  if (override) {
    if (isExecutable(override, platform, environment)) {
      return override;
    }
    throw new Error(
      `LORE_CLIENT_BROWSER_PATH points to a browser that cannot be executed: ${override}`,
    );
  }

  const candidates = browserExecutableCandidates(platform, environment);
  const resolved = candidates.find((candidate) =>
    isExecutable(candidate, platform, environment),
  );
  if (resolved) {
    return resolved;
  }

  throw new Error(
    `No supported Chromium browser was found on ${platform}. ` +
      `Install Chrome, Chromium, or Edge, or set LORE_CLIENT_BROWSER_PATH to the executable. ` +
      `Checked: ${candidates.join(", ")}`,
  );
}
