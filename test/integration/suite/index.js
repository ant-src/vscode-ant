// The integration tests, run inside VS Code by test/integration/run.mjs: the extension starts the
// server for the fixture workspace, and the editor's language features answer.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(check, what, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) {
      return v;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

// runTask starts a task through start and resolves with the exit status of the task named name.
function runTask(start, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ended.dispose();
      reject(new Error(`timed out waiting for the task ${name}`));
    }, 20000);
    const ended = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.name === name) {
        clearTimeout(timer);
        ended.dispose();
        resolve(e.exitCode);
      }
    });
    start().then(undefined, reject);
  });
}

// applyEdits applies text edits to a document's text, last first.
function applyEdits(doc, edits) {
  let text = doc.getText();
  const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
  for (const e of sorted) {
    text = text.slice(0, doc.offsetAt(e.range.start)) + e.newText + text.slice(doc.offsetAt(e.range.end));
  }
  return text;
}

exports.run = async function run() {
  await vscode.workspace.getConfiguration("ant").update("path", process.env.ANT_BIN, vscode.ConfigurationTarget.Global);
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const mainUri = vscode.Uri.file(path.join(folder, "main.ant"));
  const doc = await vscode.workspace.openTextDocument(mainUri);
  await vscode.window.showTextDocument(doc);

  // diagnostics for the type error in the fixture
  const diags = await until(() => {
    const d = vscode.languages.getDiagnostics(mainUri);
    return d.length > 0 ? d : null;
  }, "diagnostics");
  assert.ok(diags.some((d) => d.message.includes("cannot use string where int is expected")), JSON.stringify(diags.map((d) => d.message)));

  // hover on an imported function
  const text = doc.getText();
  const hoverPos = doc.positionAt(text.indexOf("distance(p"));
  const hovers = await until(() => vscode.commands.executeCommand("vscode.executeHoverProvider", mainUri, hoverPos).then((h) => (h.length ? h : null)), "hover");
  const hoverText = hovers.map((h) => h.contents.map((c) => c.value).join("\n")).join("\n");
  assert.ok(hoverText.includes("func distance(a: Point, b: Point): float64"), hoverText);

  // definition across modules
  const defs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", mainUri, hoverPos);
  assert.equal(defs.length, 1);
  assert.ok(defs[0].uri.fsPath.endsWith(path.join("lib", "geometry.ant")), defs[0].uri.fsPath);

  // completion of a record's fields
  const dot = doc.positionAt(text.indexOf("p.x") + 2);
  const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", mainUri, dot);
  const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
  assert.ok(labels.includes("x") && labels.includes("y"), labels.join(","));

  // symbols
  const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", mainUri);
  assert.ok(symbols.some((s) => s.name === "main"), symbols.map((s) => s.name).join(","));

  // formatting rewrites a mis-formatted file through ant fmt
  const uglyUri = vscode.Uri.file(path.join(folder, "ugly.ant"));
  await vscode.workspace.openTextDocument(uglyUri);
  const edits = await until(() => vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", uglyUri, { tabSize: 2, insertSpaces: true }).then((e) => (e && e.length ? e : null)), "formatting edits");
  const ugly = await vscode.workspace.openTextDocument(uglyUri);
  const formatted = applyEdits(ugly, edits);
  assert.equal(formatted, "func f(a: int): int {\n  a + 1\n}\n");

  // the prelude opens as a document
  const preludePos = doc.positionAt(text.indexOf("Math.sqrt") + 6);
  const preludeDefs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", mainUri, preludePos);
  assert.equal(preludeDefs.length, 1);
  assert.equal(preludeDefs[0].uri.scheme, "ant");
  const prelude = await vscode.workspace.openTextDocument(preludeDefs[0].uri);
  assert.ok(prelude.getText().includes("func Math.sqrt"), prelude.getText().slice(0, 100));

  // a tasks.json task of type ant is resolved by the extension and runs its file
  const tasks = await vscode.tasks.fetchTasks({ type: "ant" });
  const hello = tasks.find((t) => t.name === "hello");
  assert.ok(hello, `no hello task among ${tasks.map((t) => t.name).join(",")}`);
  assert.equal(await runTask(() => vscode.tasks.executeTask(hello), "hello"), 0);

  // Ant: Run File runs the active file as a task
  const helloDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder, "hello.ant")));
  await vscode.window.showTextDocument(helloDoc);
  assert.equal(await runTask(() => vscode.commands.executeCommand("ant.runFile"), "hello.ant"), 0);

  // a debug session stops at a breakpoint, shows the locals, and runs to the end
  const debugFile = path.join(folder, "debug.ant");
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(debugFile), new vscode.Position(2, 0)));
  vscode.debug.addBreakpoints([breakpoint]);
  const stops = [];
  const outputs = [];
  // errors is what went wrong in the adapter, for the message of a failed assertion: the program's
  // standard error, a failed request, and how the adapter ended
  const errors = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory("ant", {
    createDebugAdapterTracker: () => ({
      onDidSendMessage: (m) => {
        if (m.type === "event" && m.event === "stopped") stops.push(m.body);
        if (m.type === "event" && m.event === "output") outputs.push(m.body.output);
        if (m.type === "event" && m.event === "output" && m.body.category === "stderr") errors.push(m.body.output);
        if (m.type === "response" && !m.success) errors.push(`${m.command}: ${m.message}\n`);
      },
      onError: (err) => errors.push(`${err}\n`),
      onExit: (code, signal) => errors.push(`ant dap exited with ${code ?? signal}\n`),
    }),
  });
  let ended = false;
  const terminated = vscode.debug.onDidTerminateDebugSession(() => {
    ended = true;
  });
  try {
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], { type: "ant", request: "launch", name: "debug", program: debugFile });
    assert.ok(started, `the debug session did not start; is ${process.env.ANT_BIN} an ant with dap?\n${errors.join("")}`);
    await until(() => stops.length > 0 || ended, "a stop at the breakpoint");
    assert.ok(stops.length > 0, `the session ended before the breakpoint\n${errors.join("")}`);
    assert.equal(stops[0].reason, "breakpoint");
    const session = vscode.debug.activeDebugSession;
    const trace = await session.customRequest("stackTrace", { threadId: stops[0].threadId });
    assert.equal(trace.stackFrames[0].name, "greet");
    assert.equal(trace.stackFrames[0].line, 3);
    const scopes = await session.customRequest("scopes", { frameId: trace.stackFrames[0].id });
    const vars = await session.customRequest("variables", { variablesReference: scopes.scopes[0].variablesReference });
    assert.deepEqual(vars.variables.map((v) => `${v.name}=${v.value}`), ['name="ant"', 'text="hello, ant"']);
    const evaluated = await session.customRequest("evaluate", { expression: "text + \"!\"", frameId: trace.stackFrames[0].id, context: "repl" });
    assert.equal(evaluated.result, '"hello, ant!"');
    await session.customRequest("continue", { threadId: stops[0].threadId });
    await until(() => ended, "the session to end");
    assert.ok(outputs.join("").includes("hello, ant"), outputs.join(""));
  } finally {
    if (!ended) {
      await vscode.debug.stopDebugging();
    }
    terminated.dispose();
    tracker.dispose();
    vscode.debug.removeBreakpoints([breakpoint]);
  }
};
