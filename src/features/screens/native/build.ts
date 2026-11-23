import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SCREEN_NATIVE_DIRECTORY = "screen-native";
export const SCREEN_HELPER_EXECUTABLE = "ToyBoxScreens";
export const SCREEN_NATIVE_REQUIREMENT =
  "Screen sharing currently requires an Apple silicon Mac running macOS 14.2 or later, or WSLg with XWayland.";

/** Compiles the helper, unless it was already built from its current source. */
export async function buildScreenNative(destination?: string, benchmark = false): Promise<string> {
  if (process.platform === "linux") return buildLinuxScreenNative(destination);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(SCREEN_NATIVE_REQUIREMENT);
  const source = Bun.fileURLToPath(new URL("./macos/", import.meta.url));
  const root = destination ?? resolve(source, "../../../../../.nitro", SCREEN_NATIVE_DIRECTORY);
  const executable = join(root, `${SCREEN_HELPER_EXECUTABLE}${benchmark ? "Benchmark" : ""}`);
  const sources = [join(source, "main.swift"), join(source, "pixels.swift")];
  if (benchmark) sources.push(Bun.fileURLToPath(new URL("../bench/native.swift", import.meta.url)));
  const inputs = [...sources, Bun.fileURLToPath(import.meta.url)];
  const built = Bun.file(executable);
  if (
    (await built.exists()) &&
    inputs.every((input) => Bun.file(input).lastModified < built.lastModified)
  )
    return executable;
  await mkdir(root, { recursive: true });
  await run([
    "xcrun",
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-target",
    "arm64-apple-macos14.2",
    "-framework",
    "Cocoa",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "ImageIO",
    "-framework",
    "VideoToolbox",
    ...(benchmark ? ["-D", "SCREEN_BENCHMARK"] : []),
    ...sources,
    "-o",
    executable,
  ]);
  return executable;
}

async function buildLinuxScreenNative(destination?: string): Promise<string> {
  const source = Bun.fileURLToPath(new URL("./linux/main.c", import.meta.url));
  const buildScript = Bun.fileURLToPath(import.meta.url);
  const root = destination ?? resolve(source, "../../../../../../.nitro", SCREEN_NATIVE_DIRECTORY);
  const executable = join(root, SCREEN_HELPER_EXECUTABLE);
  const built = Bun.file(executable);
  if (
    (await built.exists()) &&
    [source, buildScript].every((input) => Bun.file(input).lastModified < built.lastModified)
  )
    return executable;
  await mkdir(root, { recursive: true });
  const cflags = (await run(["pkg-config", "--cflags", "x11", "xtst", "libjpeg"])).trim();
  const libs = (await run(["pkg-config", "--libs", "x11", "xtst"])).trim();
  await run([
    "gcc",
    "-O3",
    ...cflags.split(/\s+/).filter(Boolean),
    source,
    ...libs.split(/\s+/).filter(Boolean),
    "-Wl,-Bstatic",
    "-ljpeg",
    "-Wl,-Bdynamic",
    "-lm",
    "-pthread",
    "-o",
    executable,
  ]);
  return executable;
}

async function run(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`Screen native build failed (${command[0]}):\n${stdout}${stderr}`);
  return stdout;
}

if (import.meta.main) console.log(await buildScreenNative(process.argv[2]));
