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
// antPath caches where ant was found, until ant.path changes; a miss is not cached, so that an
// ant installed later is found by the next restart.
let antPath: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Ant");
  watcher = vscode.workspace.createFileSystemWatcher("**/*.ant");
  context.subscriptions.push(
    output,
    watcher,
    vscode.commands.registerCommand("ant.restartServer", () => restart()),
    vscode.commands.registerCommand("ant.showOutput", () => output.show()),
    vscode.commands.registerCommand("ant.runFile", runFile),
    vscode.commands.registerCommand("ant.debugFile", debugFile),
    vscode.debug.registerDebugAdapterDescriptorFactory("ant", { createDebugAdapterDescriptor }),
    vscode.debug.registerDebugConfigurationProvider("ant", { resolveDebugConfiguration, resolveDebugConfigurationWithSubstitutedVariables }),
    vscode.tasks.registerTaskProvider("ant", {
      provideTasks: () => [],
      resolveTask: (task) => resolveAntTask(task),
    }),
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
        antPath = undefined;
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
  if (antPath === undefined) {
    antPath = await locateAnt();
  }
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

// runFile saves the active Ant file and runs it as an ant task.
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
  const file = editor.document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const task = await antTask({ type: "ant", file }, folder ?? vscode.TaskScope.Workspace, path.basename(file));
  task.presentationOptions = { clear: true, focus: true };
  await vscode.tasks.executeTask(task);
}

// AntTaskDefinition is a task of type ant: the one in tasks.json, or the one Ant: Run File makes.
interface AntTaskDefinition extends vscode.TaskDefinition {
  type: "ant";
  file: string; // the .ant file to run, relative to the workspace folder
}

// resolveAntTask gives a tasks.json task of type ant its execution, so that it runs, can be the
// default build task, and can have a keyboard shortcut; it needs a file and a trusted workspace.
async function resolveAntTask(task: vscode.Task): Promise<vscode.Task | undefined> {
  const def = task.definition as AntTaskDefinition;
  if (typeof def.file !== "string" || !def.file || !vscode.workspace.isTrusted) {
    return undefined;
  }
  return antTask(def, task.scope ?? vscode.TaskScope.Workspace, task.name);
}

// antTask builds the task that runs a file with ant run, started as a process with its
// arguments, so that no shell reads the path. A relative file is taken from the folder.
async function antTask(def: AntTaskDefinition, scope: vscode.WorkspaceFolder | vscode.TaskScope, name: string): Promise<vscode.Task> {
  const folder = typeof scope === "object" ? scope : undefined;
  const cwd = folder?.uri.fsPath ?? (path.isAbsolute(def.file) ? path.dirname(def.file) : undefined);
  const file = cwd ? path.resolve(cwd, def.file) : def.file;
  const ant = (await findAnt()) ?? "ant";
  const execution = new vscode.ProcessExecution(ant, ["run", file], cwd ? { cwd } : undefined);
  return new vscode.Task(def, scope, name, "ant", execution, "$ant");
}

// createDebugAdapterDescriptor starts ant dap for a debug session (spec/dap.md), only in a trusted
// workspace, since ant.path names the executable. It runs in the session's workspace folder, or
// the program's directory, so that a relative program is taken from there.
async function createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor | undefined> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage("Debugging needs a trusted workspace.");
    return undefined;
  }
  const ant = await findAnt();
  if (!ant) {
    vscode.window.showErrorMessage("The ant executable was not found. Set ant.path to debug Ant programs.");
    return undefined;
  }
  const program = session.configuration.program;
  const cwd = session.workspaceFolder?.uri.fsPath ?? (typeof program === "string" && program ? path.dirname(program) : undefined);
  return new vscode.DebugAdapterExecutable(ant, ["dap"], cwd ? { cwd } : undefined);
}

// resolveDebugConfiguration lets F5 debug the active Ant file when there is no launch.json, and
// gives a configuration without a program the active file.
function resolveDebugConfiguration(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
): vscode.DebugConfiguration | undefined {
  if (!config.type && !config.request && !config.name) {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== "ant") {
      return config;
    }
    config.type = "ant";
    config.request = "launch";
    config.name = "Debug Ant file";
  }
  if (!config.program) {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== "ant" || doc.uri.scheme !== "file") {
      vscode.window.showInformationMessage("Open an Ant file to debug it.");
      return undefined;
    }
    config.program = doc.uri.fsPath;
  }
  return config;
}

// resolveDebugConfigurationWithSubstitutedVariables makes a relative program, cwd, or stdin
// absolute, against the workspace folder, as launch.json paths are read, or, in a window with no
// folder, against the program's directory, where ant dap would look (spec/dap.md section 2).
function resolveDebugConfigurationWithSubstitutedVariables(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
): vscode.DebugConfiguration {
  if (folder && typeof config.program === "string" && config.program) {
    config.program = path.resolve(folder.uri.fsPath, config.program);
  }
  const base = folder?.uri.fsPath ?? (typeof config.program === "string" && path.isAbsolute(config.program) ? path.dirname(config.program) : undefined);
  for (const key of ["cwd", "stdin"]) {
    if (base && typeof config[key] === "string" && config[key]) {
      config[key] = path.resolve(base, config[key]);
    }
  }
  return config;
}

// debugFile saves the active Ant file and debugs it.
async function debugFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "ant") {
    vscode.window.showInformationMessage("Open an Ant file to debug it.");
    return;
  }
  if (editor.document.uri.scheme !== "file") {
    vscode.window.showInformationMessage("Save the file to debug it.");
    return;
  }
  if (editor.document.isDirty && !(await editor.document.save())) {
    return;
  }
  const file = editor.document.uri.fsPath;
  await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(editor.document.uri), {
    type: "ant",
    request: "launch",
    name: path.basename(file),
    program: file,
  });
}
