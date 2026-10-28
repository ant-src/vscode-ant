import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

const execFile = promisify(cp.execFile);

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;
let watcher: vscode.FileSystemWatcher;
// lifecycle serializes starts and stops, so that two restarts in a row leave one server.
let lifecycle: Promise<void> = Promise.resolve();
// antPath caches where ant was found, until ant.path changes.
let antPath: string | undefined | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Ant");
  watcher = vscode.workspace.createFileSystemWatcher("**/*.ant");
  context.subscriptions.push(
    output,
    watcher,
    vscode.commands.registerCommand("ant.restartServer", () => restart()),
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
        antPath = null;
        restart();
      }
    }),
    { dispose: () => void stop() },
  );
  await restart();
}

export async function deactivate(): Promise<void> {
  await stop();
}

// restart stops the running client, if any, and starts one; calls queue up behind each other.
function restart(): Promise<void> {
  lifecycle = lifecycle.then(stopClient).then(startClient).catch((err) => {
    output.appendLine(`restart failed: ${err}`);
  });
  return lifecycle;
}

function stop(): Promise<void> {
  lifecycle = lifecycle.then(stopClient);
  return lifecycle;
}

async function startClient(): Promise<void> {
  const ant = await findAnt();
  if (!ant) {
    const install = "How to install";
    // not awaited: the notification has an action, so it stays until dismissed
    void vscode.window
      .showErrorMessage(
        "The ant executable was not found. Set ant.path, or install it with: go install github.com/ant-src/ant/cmd/ant@latest",
        install,
      )
      .then((choice) => {
        if (choice === install) {
          vscode.env.openExternal(vscode.Uri.parse("https://github.com/ant-src/ant#install"));
        }
      });
    return;
  }
  output.appendLine(`starting ${ant} lsp`);
  const serverOptions: ServerOptions = { command: ant, args: ["lsp"] };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "ant" },
      { scheme: "ant", language: "ant" },
    ],
    synchronize: { fileEvents: watcher },
    outputChannel: output,
    traceOutputChannel: output,
  };
  const c = new LanguageClient("ant", "Ant", serverOptions, clientOptions);
  try {
    await c.start();
    client = c;
  } catch (err) {
    output.appendLine(`the server did not start: ${err}`);
    vscode.window.showErrorMessage(`The Ant language server did not start: ${err}`);
    await c.dispose();
  }
}

async function stopClient(): Promise<void> {
  if (client) {
    const c = client;
    client = undefined;
    await c.stop();
    await c.dispose();
  }
}

// findAnt locates the ant executable: the ant.path setting, then ant on PATH, then $GOBIN, then
// the bin directory of go env GOPATH, then ~/go/bin. The result is kept until ant.path changes.
async function findAnt(): Promise<string | undefined> {
  if (antPath !== null) {
    return antPath;
  }
  antPath = await locateAnt();
  return antPath;
}

async function locateAnt(): Promise<string | undefined> {
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
    const { stdout } = await execFile("go", ["env", "GOPATH"], { encoding: "utf8", timeout: 5000 });
    const gopath = stdout.trim();
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

// runFile saves the active Ant file and runs it with ant run as a task, whose shell quoting VS
// Code does for the shell in use.
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
  if (editor.document.uri.scheme !== "file") {
    vscode.window.showInformationMessage("Save the file to run it.");
    return;
  }
  if (editor.document.isDirty && !(await editor.document.save())) {
    return;
  }
  const ant = (await findAnt()) ?? "ant";
  const file = editor.document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const execution = new vscode.ShellExecution(
    { value: ant, quoting: vscode.ShellQuoting.Strong },
    ["run", { value: file, quoting: vscode.ShellQuoting.Strong }],
    { cwd: folder?.uri.fsPath ?? path.dirname(file) },
  );
  const task = new vscode.Task({ type: "ant", file }, folder ?? vscode.TaskScope.Workspace, path.basename(file), "ant", execution, "$ant");
  task.presentationOptions = { clear: true, focus: true };
  await vscode.tasks.executeTask(task);
}
