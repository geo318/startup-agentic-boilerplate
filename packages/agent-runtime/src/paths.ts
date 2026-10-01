import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathRejected extends Error {
  readonly reason = "policy violation";
}

// Returns an absolute path inside `root`, or throws. Resolves symlinks on the deepest existing
// ancestor so a link pointing outside the workspace cannot be written through.
export function resolveSafe(root: string, rel: string, protectedPaths: string[] = []): string {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) throw new PathRejected(`bad path: ${rel}`);
  const real = realpathSync(root);
  const full = resolve(real, rel);
  const clean = relative(real, full);
  if (clean === "" || clean.startsWith("..") || isAbsolute(clean)) throw new PathRejected(`escapes workspace: ${rel}`);
  const posix = clean.split(sep).join("/");
  if (protectedPaths.some((p) => posix === p || posix.startsWith(p.endsWith("/") ? p : `${p}/`))) {
    throw new PathRejected(`protected path: ${posix}`);
  }
  let probe = full;
  for (;;) {
    try {
      const st = lstatSync(probe);
      const target = realpathSync(probe);
      if (relative(real, target).startsWith("..")) throw new PathRejected(`symlink escape: ${rel}`);
      if (st.isFile() && st.nlink > 1) throw new PathRejected(`hardlinked file: ${rel}`);
      break;
    } catch (e) {
      if (e instanceof PathRejected) throw e;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return join(real, clean);
}
