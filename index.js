"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.default = void 0;
var _playwright = require("playwright");
var _vscodeUri = require("vscode-uri");
var _emberMetaExplorer = require("ember-meta-explorer");
var fs = _interopRequireWildcard(require("fs"));
var traverse = _interopRequireWildcard(require("@babel/traverse"));
function _interopRequireWildcard(obj) {
    if (obj && obj.__esModule) {
        return obj;
    } else {
        var newObj = {
        };
        if (obj != null) {
            for(var key in obj){
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {
                    };
                    if (desc.get || desc.set) {
                        Object.defineProperty(newObj, key, desc);
                    } else {
                        newObj[key] = obj[key];
                    }
                }
            }
        }
        newObj.default = obj;
        return newObj;
    }
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
class ElsAddonQunitTestRunner {
    async initBrowser() {
        const browser = await _playwright.chromium.launch({
            devtools: false,
            headless: true,
            timeout: 30 * 1000
        });
        const context = await browser.newContext();
        this.browser = browser;
        this.context = context;
    }
    onInit(server, project) {
        console.log('initialized');
        this.initBrowser();
        project.addWatcher((uri)=>{
            console.log('uri', uri);
            if (!this.browser) {
                console.log('no-browser');
                return;
            }
            this.getLinting(_vscodeUri.URI.parse(uri).fsPath);
        });
        return ()=>{
            this.browser.close();
        };
    }
    async getLinting(filePath) {
        console.log('getLinting', filePath);
        const info = this.extractTestFileInformation(filePath);
        console.log(info);
        const results = Promise.all(info.tests.map((el)=>{
            return this.getTestResults(info.moduleName, el);
        }));
        console.log('results', results);
        return results;
    }
    extractTestFileInformation(filePath) {
        const ast = _emberMetaExplorer.parseScriptFile(fs.readFileSync(filePath, "utf8"));
        let moduleName = "";
        let foundTests = [];
        traverse(ast, {
            ExpressionStatement (node) {
                if (node.expression.type === "CallExpression") {
                    if (node.expression.callee.name === "module") {
                        moduleName = node.expression.arguments[0].value;
                    } else if (node.expression.callee.name === "test") {
                        foundTests.push(node.expression.arguments[0].value);
                    }
                }
            }
        });
        return {
            moduleName,
            tests: foundTests
        };
    }
    async getTestResults(moduleName, testName) {
        console.log('getTestResults', moduleName, testName);
        const page = await this.context.newPage();
        const testId = generateHash(moduleName, testName);
        const url = `http://localhost:4300/tests?testId=${testId}`;
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
        const results = await page.evaluate(()=>window.__TEST_RESULTS
        );
        try {
            return results;
        } finally{
            page.close();
        }
    }
}
exports.default = ElsAddonQunitTestRunner;

