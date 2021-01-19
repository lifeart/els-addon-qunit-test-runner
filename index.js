"use strict";
var _node = require("vscode-languageserver/node");
var _playwright = require("playwright");
var _vscodeUri = require("vscode-uri");
var _emberMetaExplorer = require("ember-meta-explorer");
var _traverse = _interopRequireDefault(require("@babel/traverse"));
function _interopRequireDefault(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function toDiagnostic(location, data) {
    const start = _node.Position.create(location.start.line - 1, location.start.column);
    const end = _node.Position.create(location.end.line - 1, location.end.column);
    return {
        severity: data.result ? _node.DiagnosticSeverity.Hint : _node.DiagnosticSeverity.Error,
        range: _node.Range.create(start, end),
        message: data.message,
        code: 'qunit-test',
        source: 'qunit'
    };
}
function generateHash(module, testName) {
    let str = module + "\x1C" + testName;
    let hash = 0;
    for(var i = 0; i < str.length; i++){
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    } // Convert the possibly negative integer hash code into an 8 character hex string, which isn't
    // strictly necessary but increases user understanding that the id is a SHA-like hash
    let hex = (4294967296 + hash).toString(16);
    if (hex.length < 8) {
        hex = "0000000" + hex;
    }
    return hex.slice(-8);
}
module.exports = (function() {
    class ElsAddonQunitTestRunner {
        async initBrowser() {
            if (!this.initPromise) {
                this.initPromise = new Promise(async (resolve)=>{
                    const browser = await _playwright.chromium.launch({
                        devtools: false,
                        headless: true,
                        timeout: 30 * 1000
                    });
                    const context = await browser.newContext();
                    this.browser = browser;
                    this.context = context;
                    resolve(true);
                });
            }
            await this.initPromise;
        }
        onInit(server, project) {
            this.server = server;
            // project.addWatcher((uri, changeType) => {
            //   console.log('uri', uri);
            //   if (!this.browser) {
            //     console.log('no-browser');
            //     return;
            //   }
            //   if (changeType === 2) {
            //     const filePath = URI.parse(uri).fsPath;
            //     if (project.matchPathToType(filePath)?.kind === 'test') {
            //       this.getLinting(filePath);
            //     }
            //   }
            // });
            const lintFn = async (document)=>{
                const asyncLint = async ()=>{
                    var ref;
                    await this.initBrowser();
                    const filePath = _vscodeUri.URI.parse(document.uri).fsPath;
                    if (((ref = project.matchPathToType(filePath)) === null || ref === void 0 ? void 0 : ref.kind) === 'test') {
                        console.log('can lint');
                        const results = await this.getLinting(document.getText());
                        console.log('results', results);
                        this.server.connection.sendDiagnostics({
                            version: document.version,
                            diagnostics: results,
                            uri: document.uri
                        });
                    }
                };
                asyncLint();
            };
            project.addLinter(lintFn);
            return ()=>{
                this.pagePool.forEach((page)=>page.close()
                );
                if (this.browser) {
                    this.browser.close();
                }
            };
        }
        createDiagnostics(testsInfo, testsResults) {
            const diagnostics = [];
            testsResults.forEach((result)=>{
                const relatedTest = testsInfo.tests.find((el)=>el.name === result.name
                );
                const relatedAsserts = relatedTest.asserts;
                result.assertions.forEach((assert, index)=>{
                    diagnostics.push(toDiagnostic(relatedAsserts[index], assert));
                });
            });
            return diagnostics;
        }
        async getLinting(text) {
            const info = this.extractTestFileInformation(text);
            const results = await Promise.all(info.tests.map((el)=>{
                return this.getTestResults(info.moduleName, el.name);
            }));
            const diagnostics = this.createDiagnostics(info, results);
            return diagnostics;
        }
        extractTestFileInformation(text) {
            const ast = _emberMetaExplorer.parseScriptFile(text);
            let moduleName = "";
            let foundTests = [];
            try {
                _traverse.default(ast, {
                    ExpressionStatement (nodePath) {
                        const node = nodePath.node;
                        if (node.expression.type === "CallExpression") {
                            if (node.expression.callee.name === "module") {
                                moduleName = node.expression.arguments[0].value;
                            } else if (node.expression.callee.name === "test") {
                                foundTests.push({
                                    name: node.expression.arguments[0].value,
                                    asserts: []
                                });
                            }
                        }
                    },
                    MemberExpression (path) {
                        if (path.node.object.type === 'Identifier' && path.node.object.name === 'assert') {
                            foundTests[foundTests.length - 1].asserts.push(path.node.object.loc);
                        }
                    }
                });
            } catch (e) {
                console.log(e);
            }
            return {
                moduleName,
                tests: foundTests
            };
        }
        async getTestResults(moduleName, testName) {
            const page = this.pagePool.shift() || await this.context.newPage();
            const testId = generateHash(moduleName, testName);
            const url = `http://localhost:4300/tests?testId=${testId}`;
            console.time(testId);
            await page.goto(url, {
                waitUntil: "load"
            });
            await page.evaluate(()=>{
                QUnit.config.callbacks.testDone.push((results)=>{
                    window.__TEST_RESULTS = results;
                });
            });
            await page.waitForSelector(`#qunit-test-output-${testId} .runtime`, {
                timeout: 30000
            });
            const result = await page.evaluate(()=>window.__TEST_RESULTS
            );
            console.timeEnd(testId);
            try {
                return result;
            } finally{
                this.pagePool.push(page);
            }
        }
        constructor(){
            this.pagePool = [];
            this.linterResults = {
            };
        }
    }
    return ElsAddonQunitTestRunner;
})();

