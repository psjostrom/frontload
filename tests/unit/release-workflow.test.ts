import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const publishWorkflowPath = path.resolve(".github/workflows/npm-publish.yml");
const releasePrWorkflowPath = path.resolve(".github/workflows/create-release-pr.yml");

describe("npm publish workflow", () => {
  it("publishes from main with npm trusted publishing instead of a long-lived token", () => {
    const workflow = fs.readFileSync(publishWorkflowPath, "utf8");

    expect(workflow).toContain("name: Publish npm package");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).toContain("npm view frontload@${PACKAGE_VERSION} version");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("creates release PRs manually without publishing", () => {
    const workflow = fs.readFileSync(releasePrWorkflowPath, "utf8");

    expect(workflow).toContain("name: Create release PR");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain("VERSION_INPUT: ${{ inputs.version }}");
    expect(workflow).toContain("BUMP_INPUT: ${{ inputs.bump }}");
    expect(workflow).toContain('pnpm release:pr -- --version "$VERSION_INPUT"');
    expect(workflow).toContain('pnpm release:pr -- --bump "$BUMP_INPUT"');
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });
});
