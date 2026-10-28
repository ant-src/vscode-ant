import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Ant");
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand("ant.restartServer", () => restart(context)),
    vscode.commands.registerCommand("ant.showOutput", () => output.show()),
    vscode.commands.registerCommand("ant.runFile", runFile),
    vscode.workspace.registerTextDocumentContentProvider("ant", {
      provideTextDocumentContent: async (uri) => {
        if (!client) {
          return "";
        }
        return client.sendRequest<string>("ant/source", { uri: uri.toString() });
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ant.path")) {
        restart(context);
      }
    }),
  );
  await start(context);
}

export async function deactivate(): Promise<void> {
  await stop();
}

async function start(context: vscode.ExtensionContext): Promise<void> {
  const ant = findAnt();
  if (!ant) {
    const install = "How to install";
    const choice = await vscode.window.showErrorMessage(
      "The ant executable was not found. Set ant.path, or install it with: go install github.com/ant-src/ant/cmd/ant@latest",
      install,
    );
    if (choice === install) {
      vscode.env.openExternal(vscode.Uri.parse("https://github.com/ant-src/ant#install"));
    }
    return;
  }
  output.appendLine(`starting ${ant} lsp`);
  const serverOptions: ServerOptions = { command: ant, args: ["lsp"] };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "ant" },
      { scheme: "ant", language: "ant" },
    ],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.ant") },
    outputChannel: output,
    traceOutputChannel: output,
  };
  client = new LanguageClient("ant", "Ant", serverOptions, clientOptions);
  context.subscriptions.push(client);
  try {
    await client.start();
  } catch (err) {
    output.appendLine(`the server did not start: ${err}`);
    vscode.window.showErrorMessage(`The Ant language server did not start: ${err}`);
  }
}

async function stop(): Promise<void> {
  if (client) {
    const c = client;
    client = undefined;
    await c.stop();
  }
}

async function restart(context: vscode.ExtensionContext): Promise<void> {
  await stop();
  await start(context);
}

// findAnt locates the ant executable: the ant.path setting, then ant on PATH, then $GOBIN, then
// the bin directory of go env GOPATH, then ~/go/bin.
function findAnt(): string | undefined {
  const configured = vscode.workspace.getConfiguration("ant").get<string>("path");
  if (configured) {
    return configured;
  }
  const exe = process.platform === "win32" ? "ant.exe" : "ant";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && isExecutable(candidate)) {
      return candidate;
    }
  }
  if (process.env.GOBIN && isExecutable(path.join(process.env.GOBIN, exe))) {
    return path.join(process.env.GOBIN, exe);
  }
  try {
    const gopath = cp.execFileSync("go", ["env", "GOPATH"], { encoding: "utf8", timeout: 5000 }).trim();
    if (gopath && isExecutable(path.join(gopath, "bin", exe))) {
      return path.join(gopath, "bin", exe);
    }
  } catch {
    // no go toolchain
  }
  const home = path.join(os.homedir(), "go", "bin", exe);
  if (isExecutable(home)) {
    return home;
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// runFile saves the active Ant file and runs it with ant run in a terminal.
async function runFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "ant") {
    vscode.window.showInformationMessage("Open an Ant file to run it.");
    return;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage("Running a file needs a trusted workspace.");
    return;
  }
  await editor.document.save();
  const ant = findAnt() ?? "ant";
  const terminal =
    vscode.window.terminals.find((t) => t.name === "Ant") ?? vscode.window.createTerminal("Ant");
  terminal.show();
  terminal.sendText(`${quote(ant)} run ${quote(editor.document.uri.fsPath)}`);
}

function quote(s: string): string {
  return /[\s"'`$\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s;
}
