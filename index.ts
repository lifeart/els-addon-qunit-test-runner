/* eslint-disable no-undef */
/* globals QUnit */
import { Project, Server, AddonAPI } from "@lifeart/ember-language-server";
import { Diagnostic, DiagnosticSeverity, Range, Position } from 'vscode-languageserver/node';
import { chromium, ChromiumBrowser, ChromiumBrowserContext, Page } from "playwright";
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from "vscode-uri";
import { parseScriptFile } from "ember-meta-explorer";
import traverse from "@babel/traverse";

interface QUnitAssertion {
  result: boolean;
  message: string;
}
interface QUnitTestResult {
  name: string;
  module: string;
  skipped: boolean;
  todo: false;
  failed: number;
  passed: number;
  total: number;
  runtime: number;
  assertions: QUnitAssertion[],
  testId: string,
  source: string;
}
interface ASTLocation {
  start: { line: number, column: number };
  end: { line: number, column: number };
}

function createRange(location: ASTLocation) {
  const start = Position.create(location.start.line - 1, location.start.column);
  const end = Position.create(location.end.line - 1, location.end.column);
  return Range.create(start, end);
}

function toDiagnostic(location: ASTLocation, data: QUnitAssertion): Diagnostic {
  return {
    severity: data.result ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    range: createRange(location),
    message: data.message,
    code: 'qunit-test',
    source: 'qunit',
  };
}

interface ITest {
  name: string;
  nameLoc: ASTLocation;
  asserts: ASTLocation[]
}

interface ITestInfo {
  moduleName: string;
  moduleLoc: ASTLocation;
  tests: ITest[]
}

function generateHash(module, testName) {
  let str = module + "\x1C" + testName;
  let hash = 0;

  for (var i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  } // Convert the possibly negative integer hash code into an 8 character hex string, which isn't
  // strictly necessary but increases user understanding that the id is a SHA-like hash

  let hex = (0x100000000 + hash).toString(16);

  if (hex.length < 8) {
    hex = "0000000" + hex;
  }

  return hex.slice(-8);
}
module.exports = class ElsAddonQunitTestRunner implements AddonAPI {
  server!: Server;
  browser!: ChromiumBrowser;
  context!: ChromiumBrowserContext;
  pagePool: Page[] = [];
  initPromise: any;
  matchFunctions: any[] = [];
  linterResults: {
    [key: string]: Diagnostic[]
  } = {};
  async initBrowser() {
    if (!this.initPromise) {
      this.initPromise = new Promise(async (resolve) => {
        const browser = await chromium.launch({
          devtools: false,
          headless: true,
          timeout: 30 * 1000,
        });
        const context = await browser.newContext();
        this.browser = browser;
        this.context = context;
        resolve(true);
      });
    }
    await this.initPromise;
  }
  onInit(server: Server, project: Project) {
    this.server = server;
    project.addWatcher((uri, changeType) => {
      if (changeType === 2) {
        this.matchFunctions.forEach((fn) => fn(uri));
      }
    });
    let lintedVersions = [];
    const lintFn: any = async (document : TextDocument) => {
      
      const filePath = URI.parse(document.uri).fsPath;
      const version = document.version;
      const testRunId = `${filePath}:${version}`;
      if (lintedVersions.includes(testRunId)) {
        return;
      }
      if (project.matchPathToType(filePath)?.kind === 'test') {
        lintedVersions.push(testRunId);
        const info = this.extractTestFileInformation(document.getText());
        this.asyncLint(info, document, testRunId);
        return this.createPreDiagnostics(info);
      }

    }
    project.addLinter(lintFn);

    return () => {
      this.pagePool.forEach((page) => page.close());
      if (this.browser) {
        this.browser.close();
      }
    };
  }
  async asyncLint(info: ITestInfo, document: TextDocument, testRunId: string) {
    await Promise.all([this.initBrowser(), this.waitForAssets()]);
    console.time(`${testRunId}:testing`);
    const results = await this.getLinting(info);
    this.server.connection.sendDiagnostics({
      version: document.version,
      diagnostics: results,
      uri: document.uri
    });
    console.timeEnd(`${testRunId}:testing`);
  }
  waitForAssets(timeout = 60000) {
    let timeoutUid = null;
    let resolve = null;
    let reject = null;
    let deleteFunction = null;
    let item = new Promise((res, rej) => {
      resolve = res;
      reject = (reason) => {
        deleteFunction();
        rej(reason);
      };
    });
    timeoutUid = setTimeout(() => {
      reject("timeout");
    }, timeout);
    let fn = (uri) => {
      if (uri.includes('dist') && uri.includes('assets')) {
        deleteFunction();
        setTimeout(resolve);
      }
    };
    this.matchFunctions.push(fn);
    deleteFunction = () => {
      clearTimeout(timeoutUid);
      this.matchFunctions = this.matchFunctions.filter((f) => f !== fn);
    };
    return item;
  }
  createDiagnostics(testsInfo: ITestInfo, testsResults: QUnitTestResult[]) {
    const diagnostics: Diagnostic[] = [];
    // testsResults.forEach((result) => {
    //   const relatedTest = testsInfo.tests.find((el) => el.name === result.name);
    //   const relatedAsserts = relatedTest.asserts;
    //   result.assertions.forEach((assert, index) => {
    //     diagnostics.push(toDiagnostic(relatedAsserts[index], assert));
    //   });
    // });
    const allRelatedResults = testsResults.filter((el) => el.module === testsInfo.moduleName);

    testsInfo.tests.forEach((test) => {
      const testResult = allRelatedResults.find((result) => result.name === test.name);
      const failMessage = testResult.assertions.filter((assert)=> assert.result === false).map((el)=> el.message);
      const successMessage = testResult.assertions.map((el) => el.message);
      const isPassed = testResult.failed === 0;
      diagnostics.push(toDiagnostic(test.nameLoc, {
        result: isPassed,
        message: isPassed ? [
          'Test Passed:',
          '---------------',
          'Asserts:',
          '---------------',
          ...successMessage.map((el)=>`* ${el}`)
        ].join('\n') : [
            'Test Failed:',
            '---------------',
            'Failed Asserts:',
            ...failMessage.map((el)=>`* ${el}`)
          ].join('\n')
      }))
    });

    return diagnostics;
  }
  createPreDiagnostics(info: ITestInfo) {
    const diagnostics: Diagnostic[] = [];
    info.tests.forEach((test) => {
      diagnostics.push({
        severity: DiagnosticSeverity.Information,
        range: createRange(test.nameLoc),
        message: `Test: "${test.name}" in progress, ${test.asserts.length} asserts...`,
        code: 'qunit-test',
        source: 'qunit',
      });
    });
    return diagnostics;
  }

  async getLinting(info: ITestInfo) {
    const results = await Promise.all(
      info.tests.map((el) => {
        return this.getTestResults(info.moduleName, el.name);
      })
    );
    const diagnostics = this.createDiagnostics(info, results);
    return diagnostics;
  }
  extractTestFileInformation(text): ITestInfo {
    const ast = parseScriptFile(text);
    let moduleName = "";
    let moduleLoc!: ASTLocation;
    let foundTests = [];
    try {
      traverse(ast, {
        ExpressionStatement(nodePath) {
          const node = nodePath.node;
          if (node.expression.type === "CallExpression") {
            if (node.expression.callee.name === "module") {
              moduleName = node.expression.arguments[0].value;
              moduleLoc = node.expression.arguments[0].loc;
            } else if (node.expression.callee.name === "test") {
              foundTests.push({
                name: node.expression.arguments[0].value,
                nameLoc: node.expression.arguments[0].loc,
                asserts: []
              });
            }
          }
        },
        MemberExpression(path) {
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
      moduleLoc,
      tests: foundTests,
    };
  }
  async getTestResults(moduleName, testName) {
    const page = this.pagePool.shift() || await this.context.newPage();
    const testId = generateHash(moduleName, testName);
    const url = `http://localhost:4300/tests?testId=${testId}`;
    await page.goto(url, {
      waitUntil: "load",
    });
    await page.evaluate(() => {
      QUnit.config.callbacks.testDone.push((results) => {
        window.__TEST_RESULTS = results;
      });
    });
    await page.waitForSelector(`#qunit-test-output-${testId} .runtime`, {
      timeout: 30000,
    });
    const result: QUnitTestResult = await page.evaluate(() => window.__TEST_RESULTS);
    try {
      return result;
    } finally {
      this.pagePool.push(page);
    }
  }
}
