/* eslint-disable no-undef */
/* globals QUnit */
import type { Project, Server, AddonAPI } from "@lifeart/ember-language-server";
import { chromium, ChromiumBrowser, ChromiumBrowserContext } from "playwright";
import { URI } from "vscode-uri";
import { parseScriptFile } from "ember-meta-explorer";
import * as fs from "fs";
import * as traverse from "@babel/traverse";

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

export default class ElsAddonQunitTestRunner implements AddonAPI {
  browser!: ChromiumBrowser;
  context!: ChromiumBrowserContext;
  async initBrowser() {
    const browser = await chromium.launch({
      devtools: false,
      headless: true,
      timeout: 30 * 1000,
    });
    const context = await browser.newContext();
    this.browser = browser;
    this.context = context;
  }
  onInit(server: Server, project: Project) {
    console.log('initialized');
    this.initBrowser();
    project.addWatcher((uri) => {
      console.log('uri', uri);
      if (!this.browser) {
        console.log('no-browser');
        return;
      }
      this.getLinting(URI.parse(uri).fsPath);
    });
    return () => {
      this.browser.close();
    };
  }
  async getLinting(filePath) {
    console.log('getLinting', filePath);
    const info = this.extractTestFileInformation(filePath);
    console.log(info);
    const results = Promise.all(
      info.tests.map((el) => {
        return this.getTestResults(info.moduleName, el);
      })
    );
    console.log('results', results);
    return results;
  }
  extractTestFileInformation(filePath) {
    const ast = parseScriptFile(fs.readFileSync(filePath, "utf8"));
    let moduleName = "";
    let foundTests = [];
    traverse(ast, {
      ExpressionStatement(node) {
        if (node.expression.type === "CallExpression") {
          if (node.expression.callee.name === "module") {
            moduleName = node.expression.arguments[0].value;
          } else if (node.expression.callee.name === "test") {
            foundTests.push(node.expression.arguments[0].value);
          }
        }
      },
    });
    return {
      moduleName,
      tests: foundTests,
    };
  }
  async getTestResults(moduleName, testName) {
    console.log('getTestResults', moduleName, testName);
    const page = await this.context.newPage();
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
    const results = await page.evaluate(() => window.__TEST_RESULTS);
    try {
      return results;
    } finally {
      page.close();
    }
  }
}
