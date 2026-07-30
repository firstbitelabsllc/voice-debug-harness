/**
 * Corpus path resolution for the portable CLI.
 *
 * Env (portable prefix):
 *   VOICE_DEBUG_CORPUS_DIR  — absolute or cwd-relative corpus folder
 *
 * Reads may use bundled package fixtures.
 * Writes without VOICE_DEBUG_CORPUS_DIR always use a cwd-local folder
 * (`./voice-debug-corpus`) so a clean install never mutates node_modules.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ID = "coach-hashmap-explain";
export const DEFAULT_TEXT =
  "Please explain step-by-step how the hash map two-sum solution works and why it is O(n).";

/** Cwd-local write target when VOICE_DEBUG_CORPUS_DIR is unset. */
export const DEFAULT_WRITE_CORPUS_DIRNAME = "voice-debug-corpus";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Absolute path to this package root (for tests that simulate install layout).
 * @param {{ packageRoot?: string }} [opts]
 */
export function packageRoot(opts = {}) {
  return opts.packageRoot || PACKAGE_ROOT;
}

/**
 * Resolve VOICE_DEBUG_CORPUS_DIR when set.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string|null}
 */
function corpusDirFromEnv(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const fromEnv = env.VOICE_DEBUG_CORPUS_DIR?.trim();
  if (!fromEnv) return null;
  return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(cwd, fromEnv);
}

/**
 * Corpus directory for reads (list / energy / play-probe).
 * Env wins; otherwise first existing candidate, preferring bundled fixtures.
 *
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, packageRoot?: string }} [opts]
 */
export function resolveCorpusDir(opts = {}) {
  const fromEnv = corpusDirFromEnv(opts);
  if (fromEnv) return fromEnv;

  const cwd = opts.cwd || process.cwd();
  const root = packageRoot(opts);
  const candidates = [
    path.join(root, "fixtures/voice-corpus"),
    path.join(cwd, "fixtures/voice-corpus"),
    path.join(cwd, DEFAULT_WRITE_CORPUS_DIRNAME),
    path.join(cwd, "voice-corpus"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Bundled fixtures path (may not exist yet in a stripped tree)
  return path.join(root, "fixtures/voice-corpus");
}

/**
 * Corpus directory for writes (`generate`).
 * Env wins; otherwise always cwd-local `./voice-debug-corpus`.
 * Refuses a default target under the package root; an explicit environment
 * override remains trusted local configuration.
 *
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, packageRoot?: string }} [opts]
 */
export function resolveWriteCorpusDir(opts = {}) {
  const fromEnv = corpusDirFromEnv(opts);
  if (fromEnv) return fromEnv;

  const cwd = opts.cwd || process.cwd();
  const target = path.resolve(cwd, DEFAULT_WRITE_CORPUS_DIRNAME);
  if (isUnderPackageRoot(target, opts)) {
    throw new Error(
      "default corpus write would be inside the package root; run from a consumer project or set VOICE_DEBUG_CORPUS_DIR explicitly",
    );
  }
  return target;
}

/**
 * True when `target` is the package root or a path inside it.
 * Used to refuse default writes into an installed package tree.
 *
 * @param {string} target
 * @param {{ packageRoot?: string }} [opts]
 */
export function isUnderPackageRoot(target, opts = {}) {
  const root = path.resolve(packageRoot(opts));
  const resolved = path.resolve(target);
  if (resolved === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved.startsWith(prefix);
}
