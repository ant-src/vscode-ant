# Ant for Visual Studio Code

Support for the [Ant](https://github.com/ant-src/ant) programming language: highlighting of `.ant`
files and of ```` ```ant ```` blocks in Markdown, comment toggling, bracket matching, indentation,
the editor defaults that `ant fmt` produces, and the language features of `ant lsp`.

The extension does not bundle `ant`. Install it with Go:

```sh
go install github.com/ant-src/ant/cmd/ant@latest
```

The extension looks for `ant` in the `ant.path` setting, then on `PATH`, then in `$GOBIN`, then in
the `bin` directory of `go env GOPATH`, then in `~/go/bin`.

With the server running, an open file gets:

- the errors of `ant check` as you type, unsaved buffers included, with an error on an `import`
  when the module it leads to has errors of its own
- completion of names in scope, of namespace, module, and type members after `.`, of record fields,
  of functions that take the left side after `|`, of parameters as `name:`, of a record literal's
  missing fields, of import paths and exports, of types, and of elements, attributes, and end tags
  in markup
- hover with the type of a name where it is used, narrowing included, and its doc comment
- signature help, with the active parameter
- go to definition, across modules, into the prelude, and from an import's path to its file
- find references, highlight, and rename, across the modules of the workspace for an export
- the outline of a file and workspace symbol search
- formatting with `ant fmt` (Format Document, or `editor.formatOnSave`)
- folding, selection ranges, semantic highlighting, inlay hints, and quick fixes

| Setting            | Default | Meaning                                                                   |
| ------------------ | ------- | ------------------------------------------------------------------------- |
| `ant.path`         | `""`    | the `ant` executable; empty means the search above                        |
| `ant.trace.server` | `"off"` | `"messages"` or `"verbose"` traces the protocol in the Ant output channel |

The commands are **Ant: Restart Language Server**, **Ant: Show Server Output**, and **Ant: Run
File**, which saves the file and runs `ant run` on it in a terminal. In an untrusted workspace the
workspace's own `ant.path` is ignored and Run File is disabled.

A task can run `ant check` with the `$ant` problem matcher:

```json
{
  "label": "ant check",
  "type": "shell",
  "command": "ant check main.ant",
  "problemMatcher": "$ant"
}
```

## Development

```sh
npm install
npm run compile
npm test
```

`npm test` tokenizes snippets and every `.ant` file of `../ant/tests` and `../ant/examples`,
failing on any token scoped `invalid` and on any markup region left open. Set `ANT_REPO` to use an
`ant` checkout elsewhere.

`npm run test:integration` builds `ant` from `ANT_REPO` (default `../ant`), or takes `ANT_BIN`,
and runs `test/integration` in a copy of VS Code downloaded into `.vscode-test`, against a fixture
workspace: diagnostics, hover, definition, completion, symbols, formatting, and the prelude
document.

`npm run package` builds the `.vsix`.
