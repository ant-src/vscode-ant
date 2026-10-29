# Ant for Visual Studio Code

Support for the [Ant](https://github.com/ant-src/ant) programming language: highlighting,
formatting, the language features of `ant lsp`, including diagnostics, completion, hover, go to
definition, references, and rename, and debugging through `ant dap`.

## Install ant

The extension does not bundle `ant`:

```sh
go install github.com/ant-src/ant/cmd/ant@latest
```

It finds `ant` on `PATH` or in your Go bin directory. Set `ant.path` to use another one.

## Commands

- **Ant: Run File** runs the current file with `ant run`
- **Ant: Debug File** debugs the current file with `ant dap`
- **Ant: Restart Language Server**
- **Ant: Show Server Output**

## Debugging

Press F5 in an Ant file, or run **Ant: Debug File**, to debug it with no `launch.json`. Breakpoints
with conditions, hit counts, and log messages, function breakpoints, stepping, pause, every
goroutine's stack and variables, Set Value, watch expressions, the debug console, hover on names and
fields, and stopping at panics work as `ant dap` serves them. A launch configuration takes the program and, optionally, its arguments, working
directory, environment, a file for its standard input, and whether to stop on entry:

```json
{ "type": "ant", "request": "launch", "name": "Debug main", "program": "${workspaceFolder}/main.ant", "args": ["-v"] }
```

## Tasks

A task of type `ant` in `tasks.json` runs a file with `ant run`, so it can be the default build task
or have a keyboard shortcut:

```json
{ "type": "ant", "file": "main.ant", "label": "run main", "group": "build", "problemMatcher": "$ant" }
```

## Development

```sh
npm install
npm test                  # grammar tests
npm run test:integration  # tests in VS Code, needs ../ant
npm run package           # builds the .vsix
```

To release, run `npm version patch && git push --follow-tags`. CI attaches `ant.vsix` to a GitHub
release and publishes it to the Marketplace.
