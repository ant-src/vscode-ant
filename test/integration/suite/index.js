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

  // formatting
  const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", mainUri, { tabSize: 2, insertSpaces: true });
  assert.ok(Array.isArray(edits));

  // the prelude opens as a document
  const preludePos = doc.positionAt(text.indexOf("Math.sqrt") + 6);
  const preludeDefs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", mainUri, preludePos);
  assert.equal(preludeDefs.length, 1);
  assert.equal(preludeDefs[0].uri.scheme, "ant");
  const prelude = await vscode.workspace.openTextDocument(preludeDefs[0].uri);
  assert.ok(prelude.getText().includes("func Math.sqrt"), prelude.getText().slice(0, 100));
};
