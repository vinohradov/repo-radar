import fs from "node:fs";
import path from "node:path";

/**
 * Recursively list files under root, skipping excluded dir names.
 * Dot-entries are skipped by default; pass includeDotFiles to include them
 * (e.g. for secret scanning of .env files). `.git` is always skipped.
 */
export function walkFiles(
  root: string,
  opts: { excludes: string[]; exts?: string[]; maxFiles?: number; includeDotFiles?: boolean },
): string[] {
  const excludes = new Set(opts.excludes);
  const exts = opts.exts ? new Set(opts.exts) : null;
  const maxFiles = opts.maxFiles ?? 5000;
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const name = entry.name;
      if (name === ".git") continue;
      if (!opts.includeDotFiles && name.startsWith(".") && name !== ".") continue;
      if (excludes.has(name)) continue;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (exts && !exts.has(path.extname(name))) continue;
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

export function readTextSafe(file: string, maxBytes = 512_000): string | null {
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Extract a small snippet (± contextLines around `line`, 1-indexed). */
export function snippet(source: string, line: number, contextLines = 3): string {
  const lines = source.split("\n");
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
}
