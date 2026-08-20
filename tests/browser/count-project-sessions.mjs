#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  artifactDir,
  countCatalogForRoots,
  ensureArtifactDir,
  readProject,
} from "../app-server/test-env.mjs";

const url = process.env.CODEX_WEB_URL || "http://127.0.0.1:8214";
const projectName = process.argv[2];
if (!projectName) {
  console.error("usage: node tests/browser/count-project-sessions.mjs <projectName>");
  process.exit(2);
}
const { project } = readProject(projectName);
const catalogRows = countCatalogForRoots([project.rootPaths[0]]);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (
    ["error", "warning"].includes(message.type()) ||
    message.text().includes("CatalogRendererDebug")
  ) {
    consoleErrors.push(`[${message.type()}] ${message.text().slice(0, 500)}`);
  }
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(Number(process.env.CODEX_WEB_WAIT_MS || 12000));

  const projectRow = page.locator(
    `[data-app-action-sidebar-project-row][aria-label="${projectName}"]`,
  ).first();
  const projectLocator = page.getByText(projectName, { exact: true }).first();
  if (await projectRow.isVisible().catch(() => false)) {
    if ((await projectRow.getAttribute("aria-expanded")) !== "true") {
      await projectRow.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }
  }

  const expandToggle = page.getByText("折叠显示", { exact: true }).first();
  if (await expandToggle.isVisible().catch(() => false)) {
    await expandToggle.click().catch(() => undefined);
    await page.waitForTimeout(1500);
  }

  const bodyText = await page.locator("body").innerText();
  const projectContainer = page.locator(
    `[data-sidebar-project-kind="local"][role="listitem"][aria-label="${projectName}"]`,
  ).first();
  const projectThreadRows = projectContainer.locator(
    `[data-app-action-sidebar-thread-row]`,
  );
  const renderedProjectThreads = await projectThreadRows
    .evaluateAll((rows) =>
      rows.map((row) => ({
        id: row.getAttribute("data-app-action-sidebar-thread-id"),
        title:
          row.querySelector("[data-app-action-sidebar-thread-title]")?.textContent?.trim() ||
          row.textContent?.trim() ||
          "",
      })),
    )
    .catch(() => []);
  const projectDom = await projectLocator
    .evaluate((element) => {
      const ancestors = [];
      let current = element;
      for (let index = 0; current && index < 8; index += 1) {
        ancestors.push({
          tag: current.tagName,
          role: current.getAttribute("role"),
          ariaExpanded: current.getAttribute("aria-expanded"),
          className: current.getAttribute("class"),
          text: current.textContent?.trim().slice(0, 500),
          html: current.outerHTML.slice(0, 1200),
        });
        current = current.parentElement;
      }
      return ancestors;
    })
    .catch(() => []);
  const visibleRows = catalogRows.filter((row) =>
    bodyText.includes(row.display_title),
  );
  const report = {
    url,
    project: { name: project.name, id: project.id, primaryRoot: project.rootPaths[0] },
    expectedFromCatalog: catalogRows.length,
    visibleTitleMatches: visibleRows.length,
    renderedProjectThreadCount: renderedProjectThreads.length,
    renderedProjectThreads,
    visibleThreadIds: visibleRows.map((row) => row.thread_id),
    missingVisibleTitles: catalogRows
      .filter((row) => !bodyText.includes(row.display_title))
      .map((row) => row.display_title),
    projectLocatorVisible: await projectLocator.isVisible().catch(() => false),
    projectExpanded: await projectRow.getAttribute("aria-expanded").catch(() => null),
    projectDom,
    bodyTextSample: bodyText.slice(0, 3000),
    consoleErrors: consoleErrors.slice(0, 20),
  };
  const outputPath = path.join(ensureArtifactDir(), "web-session-count.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, missingVisibleTitles: undefined, bodyTextSample: undefined, outputPath }, null, 2));
} finally {
  await browser.close();
}
