# Ant for Visual Studio Code

Support for the [Ant](https://github.com/ant-src/ant) programming language: highlighting,
formatting, and the language features of `ant lsp`, including diagnostics, completion, hover, go to
definition, references, and rename.

## Install ant

The extension does not bundle `ant`:

```sh
go install github.com/ant-src/ant/cmd/ant@latest
```

It finds `ant` on `PATH` or in your Go bin directory. Set `ant.path` to use another one.

## Commands

- **Ant: Run File** runs the current file with `ant run`
- **Ant: Restart Language Server**
- **Ant: Show Server Output**

## Development

```sh
npm install
npm test                  # grammar tests
npm run test:integration  # tests in VS Code, needs ../ant
npm run package           # builds the .vsix
```

To release, run `npm version patch && git push --follow-tags`. CI attaches `ant.vsix` to a GitHub
release and publishes it to the Marketplace.
