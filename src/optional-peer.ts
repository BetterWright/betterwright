// Loading BetterWright's optional peer dependencies (@anthropic-ai/sdk,
// @modelcontextprotocol/sdk).
//
// A bare `import("@anthropic-ai/sdk")` resolves relative to *this file*, which
// for `npm install -g betterwright` is somewhere under the npm global root.
// Node's resolution walks up from there and never looks at the working
// directory, so a user who ran `npm install @anthropic-ai/sdk` in their project
// gets "not installed" no matter how many times they install it — and the old
// error text told them to run exactly that failing command. So: try the normal
// resolution, then retry from the working directory, and if both miss, say
// which command actually applies to this install and where we looked.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const selfDir = path.dirname(fileURLToPath(import.meta.url));

// A global install lives outside the project the user is standing in, so its
// peers have to be installed globally too.
function isGlobalInstall(cwd) {
  return !selfDir.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep);
}

export function installHint(specifier, cwd = process.cwd()) {
  // Peers are declared on the package root, not the subpath being imported.
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  return isGlobalInstall(cwd)
    ? `npm install -g ${packageName}`
    : `npm install ${packageName}`;
}

/**
 * Is an optional peer resolvable, by the same two-step rule `importOptionalPeer`
 * uses? Callers that only need to *report* on a peer — doctor, the default-model
 * choice — must ask this rather than a bare `require.resolve`, which misses the
 * working-directory copy and so tells a user with a global BetterWright and a
 * project-local SDK to install a package they already have.
 *
 * @param {string} specifier bare specifier, optionally with a subpath
 * @param {string} [cwd]
 */
export function optionalPeerAvailable(specifier, cwd = process.cwd()) {
  const require_ = createRequire(import.meta.url);
  try {
    require_.resolve(specifier);
    return true;
  } catch {
    /* fall through to the working-directory retry */
  }
  try {
    createRequire(path.join(cwd, "noop.js")).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import an optional peer dependency, falling back to the working directory.
 * @param {string} specifier bare specifier, optionally with a subpath
 * @param {string} label human name used in the failure message
 * @returns {Promise<object>} the module namespace
 */
export async function importOptionalPeer(specifier, label) {
  try {
    return await import(specifier);
  } catch (error) {
    // Anything other than "it isn't there" — a syntax error or a throwing
    // top-level await inside the peer — is a real failure worth surfacing.
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  const cwd = process.cwd();
  let resolved;
  try {
    // createRequire needs a file path to resolve from; the file need not exist.
    resolved = createRequire(path.join(cwd, "noop.js")).resolve(specifier);
  } catch {
    throw new Error(
      `${label} needs ${specifier}, which is not installed. Install it with \`${installHint(specifier, cwd)}\`. ` +
        `Looked next to BetterWright (${selfDir}) and in the working directory (${cwd}).`,
    );
  }
  // Resolution succeeded, so the peer is installed: any error from here is the
  // peer's own and must not be reported as a missing install.
  return await import(pathToFileURL(resolved).href);
}
