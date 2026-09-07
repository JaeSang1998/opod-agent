import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

interface GitProvenance {
  gitSha?: string;
  gitDirty?: boolean;
  dirtyPathHashes?: Record<string, string>;
}

export async function collectGitProvenance(): Promise<GitProvenance> {
  const configuredSha = process.env.EVAL_GIT_SHA || process.env.GITHUB_SHA;
  try {
    const root = (await gitOutput(["rev-parse", "--show-toplevel"])).trim();
    const head = configuredSha ?? (await gitOutput(["rev-parse", "HEAD"])).trim();
    const status = await gitOutput(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const gitDirty = status.length > 0;
    const tracked = await gitOutput(["diff", "--name-only", "-z", "HEAD", "--"]);
    const untracked = await gitOutput(["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = [...new Set([...nulFields(tracked), ...nulFields(untracked)])].sort();
    const dirtyPathHashes: Record<string, string> = {};
    for (const path of paths) {
      try {
        const bytes = await readFile(resolve(root, path));
        dirtyPathHashes[path] = createHash("sha256").update(bytes).digest("hex");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          dirtyPathHashes[path] = createHash("sha256")
            .update(`opod-eval:deleted\0${path}`, "utf8")
            .digest("hex");
          continue;
        }
        throw error;
      }
    }
    return { gitSha: head || undefined, gitDirty, dirtyPathHashes };
  } catch (error) {
    console.warn(`Git provenance unavailable: ${errorMessage(error)}`);
    return { gitSha: configuredSha };
  }
}

async function gitOutput(args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(result.stdout);
}

function nulFields(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
