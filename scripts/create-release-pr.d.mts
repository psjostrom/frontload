export type ReleaseCommit = {
  sha: string;
  subject: string;
};

export function branchNameForVersion(version: string): string;
export function findPreviousReleaseRef(options: { tags: string[]; releaseCommits: ReleaseCommit[] }): string | null;
export function formatReleasePrBody(options: {
  version: string;
  previousRef: string | null;
  commits: ReleaseCommit[];
}): string;
export function prTitleForVersion(version: string): string;
export function resolveTargetVersion(options: { currentVersion: string; version?: string; bump?: string }): string;
