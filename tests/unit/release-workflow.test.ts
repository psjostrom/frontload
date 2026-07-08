import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const publishWorkflowPath = path.resolve(".github/workflows/npm-publish.yml");
const releasePrWorkflowPath = path.resolve(".github/workflows/create-release-pr.yml");

function blockAfterMarker(text: string, marker: string, nextSibling: RegExp): string {
  const start = text.indexOf(marker);
  expect(start, `Missing workflow block marker: ${marker.trim()}`).toBeGreaterThanOrEqual(0);

  const bodyStart = start + marker.length;
  nextSibling.lastIndex = bodyStart;
  const next = nextSibling.exec(text);
  return text.slice(start, next?.index ?? text.length);
}

function topLevelBlock(workflow: string, key: string): string {
  return blockAfterMarker(workflow, `${key}:\n`, /^[A-Za-z][A-Za-z0-9_-]*:\n/gm);
}

function jobBlock(workflow: string, job: string): string {
  return blockAfterMarker(workflow, `  ${job}:\n`, /^  [A-Za-z0-9_-]+:\n/gm);
}

function stepBlock(job: string, stepName: string): string {
  return blockAfterMarker(job, `      - name: ${stepName}\n`, /^      - name: /gm);
}

describe("npm publish workflow", () => {
  it("checks the npm version before running expensive verification or publishing", () => {
    const workflow = fs.readFileSync(publishWorkflowPath, "utf8");
    const topLevelPermissions = topLevelBlock(workflow, "permissions");
    const checkVersion = jobBlock(workflow, "check-version");
    const verify = jobBlock(workflow, "verify");
    const publish = jobBlock(workflow, "publish");

    expect(workflow).toContain("name: Publish npm package");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("workflow_dispatch:");
    expect(topLevelPermissions).toContain("  contents: read");
    expect(topLevelPermissions).not.toContain("id-token");

    expect(checkVersion).toContain("if: github.ref == 'refs/heads/main'");
    expect(checkVersion).toContain("should_publish: ${{ steps.check.outputs.should_publish }}");
    expect(stepBlock(checkVersion, "Set up Node")).toContain("registry-url: https://registry.npmjs.org");
    expect(stepBlock(checkVersion, "Set up Node")).toContain("node-version: 24");
    expect(stepBlock(checkVersion, "Set up Node")).toContain("package-manager-cache: false");
    expect(stepBlock(checkVersion, "Check npm version")).toContain(
      'npm view "frontload@${PACKAGE_VERSION}" version > npm-view.out 2> npm-view.err'
    );
    expect(stepBlock(checkVersion, "Check npm version")).toContain('grep -q "E404" npm-view.err');
    expect(stepBlock(checkVersion, "Check npm version")).toContain("exit 1");
    expect(checkVersion).not.toContain("pnpm install");
    expect(checkVersion).not.toContain("npm publish");

    expect(verify).toContain("needs: check-version");
    expect(verify).toContain("if: needs.check-version.outputs.should_publish == 'true'");
    expect(verify).toContain("permissions:\n      contents: read");
    expect(verify).not.toContain("id-token");
    expect(stepBlock(verify, "Install dependencies")).toContain("pnpm install --frozen-lockfile");
    expect(stepBlock(verify, "Lint")).toContain("pnpm lint");
    expect(stepBlock(verify, "Build")).toContain("pnpm build");
    expect(stepBlock(verify, "Unit tests")).toContain("pnpm test");
    expect(stepBlock(verify, "E2E tests")).toContain("pnpm e2e");
    expect(stepBlock(verify, "Validate bundled plugins")).toContain(
      "node dist/src/cli/index.js validate-plugins --repo ."
    );
    expect(stepBlock(verify, "Pack npm package")).toContain("npm pack --pack-destination .release");
    expect(stepBlock(verify, "Upload npm package")).toContain("path: .release/frontload-*.tgz");

    expect(publish).toContain("needs:\n      - check-version\n      - verify");
    expect(publish).toContain("if: needs.check-version.outputs.should_publish == 'true'");
    expect(publish).toContain("permissions:\n      contents: read\n      id-token: write");
    expect(stepBlock(publish, "Download npm package")).toContain("name: npm-package");
    expect(stepBlock(publish, "Set up Node")).toContain("registry-url: https://registry.npmjs.org");
    expect(stepBlock(publish, "Publish to npm")).toContain("npm publish npm-package/frontload-*.tgz --access public");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("pnpm test");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("creates release PRs manually without publishing", () => {
    const workflow = fs.readFileSync(releasePrWorkflowPath, "utf8");
    const permissions = topLevelBlock(workflow, "permissions");
    const job = jobBlock(workflow, "create-release-pr");

    expect(workflow).toContain("name: Create release PR");
    expect(workflow).toContain("workflow_dispatch:");
    expect(permissions).toContain("  contents: write");
    expect(permissions).toContain("  pull-requests: write");
    expect(stepBlock(job, "Checkout")).toContain("fetch-depth: 0");
    expect(stepBlock(job, "Set up Node")).toContain('node-version: "20"');
    expect(stepBlock(job, "Create release PR")).toContain("GH_TOKEN: ${{ github.token }}");
    expect(stepBlock(job, "Create release PR")).toContain("VERSION_INPUT: ${{ inputs.version }}");
    expect(stepBlock(job, "Create release PR")).toContain("BUMP_INPUT: ${{ inputs.bump }}");
    expect(stepBlock(job, "Create release PR")).toContain('node scripts/create-release-pr.mjs --version "$VERSION_INPUT"');
    expect(stepBlock(job, "Create release PR")).toContain('node scripts/create-release-pr.mjs --bump "$BUMP_INPUT"');
    expect(workflow).not.toContain("pnpm install");
    expect(workflow).not.toContain("pnpm/action-setup");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });
});
