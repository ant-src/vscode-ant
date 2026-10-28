// The grammar tests tokenize snippets and the whole Ant corpus with vscode-textmate, checking the
// scopes the grammar gives and that no valid program is marked invalid or left in an open
// markup region.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// both packages are CommonJS
const vsctm = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const antRepo = process.env.ANT_REPO ?? path.join(root, "..", "ant");

const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
const onigLib = oniguruma.loadWASM(wasm).then(() => ({
  createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
  createOnigString: (s) => new oniguruma.OnigString(s),
}));

const registry = new vsctm.Registry({
  onigLib,
  loadGrammar: async (scopeName) => {
    if (scopeName === "source.ant") {
      return vsctm.parseRawGrammar(fs.readFileSync(path.join(root, "syntaxes", "ant.tmLanguage.json"), "utf8"), "ant.tmLanguage.json");
    }
    return null;
  },
});

const grammarPromise = registry.loadGrammar("source.ant");

// tokenize returns, per line, the tokens with their text and scopes, and the final rule stack.
async function tokenize(src) {
  const grammar = await grammarPromise;
  let stack = vsctm.INITIAL;
  const lines = [];
  for (const line of src.split(/\r\n|\r|\n/)) {
    const r = grammar.tokenizeLine(line, stack);
    lines.push(r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes.slice(1) })));
    stack = r.ruleStack;
  }
  return { lines, stack };
}

// scopeOf finds the scopes of the first token whose text is `text` in the source.
async function scopeOf(src, text) {
  const { lines } = await tokenize(src);
  for (const toks of lines) {
    for (const t of toks) {
      if (t.text.trim() === text) {
        return t.scopes.join(" ");
      }
    }
  }
  throw new Error(`no token ${JSON.stringify(text)} in ${JSON.stringify(src)}`);
}

test("keywords, fields, and reserved words", async () => {
  assert.match(await scopeOf("var x = 1", "var"), /storage\.type/);
  assert.match(await scopeOf("if a { b } else { c }", "else"), /keyword\.control/);
  assert.doesNotMatch(await scopeOf("event.type", "type"), /storage\.type|keyword/);
  assert.doesNotMatch(await scopeOf("var t = { type: string }", "type"), /storage\.type/);
  assert.match(await scopeOf("let x = 1", "let"), /invalid\.illegal\.reserved/);
  assert.doesNotMatch(await scopeOf("Map{ class: \"a\" }", "class"), /invalid/);
  assert.match(await scopeOf("x is null", "null"), /constant\.language/);
});

test("declarations", async () => {
  assert.match(await scopeOf("func Point.distance(a: Point): float64 {}", "distance"), /entity\.name\.function/);
  assert.match(await scopeOf("func Point.distance(a: Point): float64 {}", "Point"), /entity\.name\.type/);
  assert.match(await scopeOf("export type Shape = Circle | Rect", "Shape"), /entity\.name\.type/);
  assert.match(await scopeOf('import "./lib/geometry.ant" Geo', "Geo"), /entity\.name\.namespace/);
  assert.match(await scopeOf("//! Geometry has points.", "//! Geometry has points."), /comment\.line.*documentation/);
  assert.match(await scopeOf("#!/usr/bin/env ant", "#!/usr/bin/env ant"), /comment\.line\.shebang/);
});

test("literals", async () => {
  assert.match(await scopeOf("var n = 1_000_000", "1_000_000"), /constant\.numeric/);
  assert.match(await scopeOf("var n = 0xFF", "0xFF"), /constant\.numeric\.hex/);
  assert.match(await scopeOf("var n = 2.5e-3", "2.5e-3"), /constant\.numeric/);
  assert.match(await scopeOf('var s = "a\\nb"', "\\n"), /constant\.character\.escape/);
  assert.match(await scopeOf('var s = "a\\qb"', "\\q"), /invalid\.illegal\.escape/);
  const { lines } = await tokenize("var s = `total: ${count} items`");
  const inner = lines[0].find((t) => t.text === "count");
  assert.ok(inner && inner.scopes.join(" ").includes("meta.template.expression"), JSON.stringify(lines[0]));
});

test("regular expressions and division", async () => {
  assert.match(await scopeOf("var r = /^\\d+$/i", "^"), /string\.regexp/);
  assert.match(await scopeOf("var r = /^\\d+$/i", "i"), /keyword\.other\.regexp\.flags/);
  assert.match(await scopeOf("Regex.test(/ant/, s)", "ant"), /string\.regexp/);
  assert.match(await scopeOf("return /x/", "x"), /string\.regexp/);
  const { lines } = await tokenize("var q = total / count");
  assert.ok(!lines[0].some((t) => t.scopes.join(" ").includes("string.regexp")), JSON.stringify(lines[0]));
  const two = await tokenize("var r = (total\n  / count)");
  assert.ok(!two.lines[1].some((t) => t.scopes.join(" ").includes("string.regexp")), JSON.stringify(two.lines[1]));
});

test("markup", async () => {
  assert.match(await scopeOf("var h = <div class=\"a\">hi</div>", "div"), /entity\.name\.tag/);
  assert.match(await scopeOf("var h = <div class=\"a\">hi</div>", "class"), /entity\.other\.attribute-name/);
  const { lines } = await tokenize("var ok = n < limit");
  assert.ok(!lines[0].some((t) => t.scopes.join(" ").includes("entity.name.tag")), JSON.stringify(lines[0]));
  // text is not code: a keyword in text keeps the markup scope and no keyword scope
  const text = await tokenize("var h = <p>for the record</p>");
  const word = text.lines[0].find((t) => t.text.trim() === "for the record");
  assert.ok(word && !word.scopes.some((s) => s.startsWith("keyword")), JSON.stringify(text.lines[0]));
  // an interpolation holds code
  const interp = await tokenize("var h = <p>{if x { \"a\" }}</p>");
  const kw = interp.lines[0].find((t) => t.text === "if");
  assert.ok(kw && kw.scopes.some((s) => s.startsWith("keyword.control")), JSON.stringify(interp.lines[0]));
  // nested elements of one name close in order, and a self-closing one ends at />
  const nested = await tokenize("var h = <div><div>a</div><br /></div>\nvar x = 1");
  const after = nested.lines[1].find((t) => t.text === "var");
  assert.ok(after && after.scopes.some((s) => s.startsWith("storage.type")), JSON.stringify(nested.lines[1]));
  assert.equal(nested.stack.depth, 1, "the markup region is closed");
  // a fragment
  const frag = await tokenize("func f(): Html {\n  <>\n    <li>a</li>\n  </>\n}\nvar y = 2");
  assert.equal(frag.stack.depth, 1);
});

test("the corpus has no invalid tokens and closes every region", async () => {
  const dirs = ["tests/run", "tests/check", "tests/check/lib", "tests/unchecked", "tests/stdlib", "examples", "examples/lib", "examples/lib/shapes"];
  let files = 0;
  for (const dir of dirs) {
    const full = path.join(antRepo, dir);
    if (!fs.existsSync(full)) {
      continue;
    }
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith(".ant")) {
        continue;
      }
      files++;
      const src = fs.readFileSync(path.join(full, name), "utf8");
      const { lines, stack } = await tokenize(src);
      lines.forEach((toks, i) => {
        for (const t of toks) {
          const bad = t.scopes.find((s) => s.startsWith("invalid"));
          assert.ok(!bad, `${dir}/${name}:${i + 1}: ${JSON.stringify(t.text)} is ${bad}`);
        }
      });
      assert.equal(stack.depth, 1, `${dir}/${name}: a region is left open at the end`);
    }
  }
  assert.ok(files > 100, `only ${files} corpus files under ${antRepo}; set ANT_REPO`);
});
