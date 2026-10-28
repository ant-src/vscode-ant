// Runs the integration tests in a copy of VS Code, against the ant built from ANT_REPO (default
// ../ant) or named by ANT_BIN.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
let ant = process.env.ANT_BIN;
if (!ant) {
  const repo = process.env.ANT_REPO ?? path.join(root, "..", "ant");
  ant = path.join(root, ".vscode-test", process.platform === "win32" ? "ant.exe" : "ant");
  execFileSync("go", ["build", "-o", ant, "./cmd/ant"], { cwd: repo, stdio: "inherit" });
}
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(here, "suite", "index.js"),
    launchArgs: [path.join(here, "fixture"), "--disable-extensions"],
    extensionTestsEnv: { ANT_BIN: ant },
  });
} catch (err) {
  console.error("the integration tests failed", err);
  process.exit(1);
}
