import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Ecosystem } from "@repo-radar/shared";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface Acquired {
  repoDir: string;
  repoName: string;
  ecosystems: Ecosystem[];
  cleanup: () => void;
}

function detectEcosystems(dir: string): Ecosystem[] {
  const eco: Ecosystem[] = [];
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) eco.push("npm");
  if (has("pom.xml")) eco.push("maven");
  if (has("build.gradle") || has("build.gradle.kts")) eco.push("gradle");
  if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile")) eco.push("pip");
  if (eco.length === 0) eco.push("unknown");
  return eco;
}

function deriveName(source: string): string {
  const cleaned = source.replace(/\.git$/, "").replace(/\/+$/, "");
  const base = cleaned.split(/[\\/]/).pop() || "repository";
  return base;
}

export async function acquire(input: {
  scanId: string;
  repoUrl?: string | null;
  localPath?: string | null;
  branch?: string | null;
  token?: string | null;
}): Promise<Acquired> {
  if (input.localPath) {
    const resolved = path.resolve(input.localPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Local path not found or not a directory: ${resolved}`);
    }
    return {
      repoDir: resolved,
      repoName: deriveName(resolved),
      ecosystems: detectEcosystems(resolved),
      cleanup: () => {},
    };
  }

  if (!input.repoUrl) throw new Error("No repoUrl or localPath provided");

  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const dir = path.join(config.workspaceDir, input.scanId);
  fs.rmSync(dir, { recursive: true, force: true });

  // Inject a token into HTTPS URLs for private repos. For SSH URLs, ambient
  // keys are used. The token lives only in this local var + the git process.
  let cloneUrl = input.repoUrl;
  if (input.token && /^https:\/\//i.test(cloneUrl)) {
    cloneUrl = cloneUrl.replace(/^https:\/\//i, `https://x-access-token:${input.token}@`);
  }

  const args = ["clone", "--depth", "1"];
  if (input.branch) args.push("--branch", input.branch);
  args.push(cloneUrl, dir);

  try {
    await execFileAsync("git", args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // Fail fast instead of hanging on a credential prompt (private HTTPS).
        GIT_TERMINAL_PROMPT: "0",
        // Non-interactive SSH: accept new host keys, never prompt for a passphrase.
        GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
      },
    });
  } catch (err) {
    // Never leak the token in error messages.
    const raw = err instanceof Error ? err.message : String(err);
    const scrubbed = input.token ? raw.split(input.token).join("***") : raw;
    throw new Error(scrubbed);
  }

  return {
    repoDir: dir,
    repoName: deriveName(input.repoUrl),
    ecosystems: detectEcosystems(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
