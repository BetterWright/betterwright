// Side-effect-free constants for the `betterwright/worker` subpath. The worker
// module itself is a process entrypoint — importing it wires up stdin/stdout
// and announces readiness — so the values consumers may want to read live here
// instead, where importing them cannot hijack the importer's stdio.

/**
 * @deprecated Retained for source compatibility. BetterWright no longer passes
 * `--host-resolver-rules` because Chromium displays a persistent unsupported
 * command-line warning whenever that flag is present.
 */
export const METADATA_RESOLVER_RULES = [
  "MAP metadata.google.internal ^NOTFOUND",
  "MAP metadata.goog ^NOTFOUND",
  "MAP 169.254.* ^NOTFOUND",
  "MAP 100.100.100.200 ^NOTFOUND",
  "MAP fd00:ec2::* ^NOTFOUND",
].join(", ");
