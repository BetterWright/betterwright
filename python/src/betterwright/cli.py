"""Command-line interface for BetterWright.

Commands
--------
``betterwright setup``    Install the pinned Playwright runtime and Chromium.
``betterwright doctor``   Report whether the runtime is ready, and why not.
``betterwright run``      Execute a Playwright snippet from a file, ``-``, or ``-c``.
``betterwright repl``     Read snippets from stdin, one per blank-line-separated block.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from betterwright import __version__
from betterwright.client import BetterWright
from betterwright.policy import NetworkPolicy
from betterwright.runtime import (
    PINNED_PLAYWRIGHT_VERSION,
    diagnose,
    node_executable,
    runtime_install_root,
)


def _policy_from_args(args: argparse.Namespace) -> NetworkPolicy:
    return NetworkPolicy(
        allow_loopback=getattr(args, "allow_loopback", False),
        allow_private_network=getattr(args, "allow_private_network", False),
        allow_hosts=tuple(getattr(args, "allow_host", None) or ()),
        block_hosts=tuple(getattr(args, "block_host", None) or ()),
    )


def _cmd_setup(args: argparse.Namespace) -> int:
    node = node_executable()
    if not node:
        print(
            "Node.js was not found on PATH. Install Node 18+ first "
            "(https://nodejs.org), then rerun `betterwright setup`.",
            file=sys.stderr,
        )
        return 1
    root = runtime_install_root()
    root.mkdir(parents=True, exist_ok=True)
    print(f"Installing playwright-core@{PINNED_PLAYWRIGHT_VERSION} into {root} ...")
    npm = _npm_executable()
    if not npm:
        print("npm was not found on PATH; it ships with Node.js.", file=sys.stderr)
        return 1
    install = subprocess.run(
        [npm, "install", "--no-save", f"playwright-core@{PINNED_PLAYWRIGHT_VERSION}"],
        cwd=str(root),
        check=False,
    )
    if install.returncode != 0:
        print("Failed to install playwright-core.", file=sys.stderr)
        return install.returncode
    print("Downloading the matching Chromium build ...")
    cli_js = root / "node_modules" / "playwright-core" / "cli.js"
    download = subprocess.run(
        [node, str(cli_js), "install", "chromium", "--no-shell"],
        check=False,
    )
    if download.returncode != 0:
        print("Failed to download Chromium.", file=sys.stderr)
        return download.returncode
    print("\nSetup complete. Run `betterwright doctor` to confirm.")
    return 0


def _npm_executable() -> str | None:
    import shutil

    return shutil.which("npm")


def _cmd_doctor(_args: argparse.Namespace) -> int:
    report = diagnose()
    width = max(len(k) for k in report)
    for key, value in report.items():
        print(f"{key.ljust(width)}  {value}")
    if report["ready"]:
        print("\nBetterWright is ready.")
        return 0
    print("\nNot ready. Run `betterwright setup` to install the missing pieces.")
    return 1


def _read_code(args: argparse.Namespace) -> str:
    if args.code is not None:
        return args.code
    if args.file == "-":
        return sys.stdin.read()
    return Path(args.file).read_text(encoding="utf-8")


def _cmd_run(args: argparse.Namespace) -> int:
    code = _read_code(args)
    with BetterWright(
        policy=_policy_from_args(args),
        headless=not args.headed,
        default_timeout=args.timeout,
    ) as bw:
        result = bw.run(code, session=args.session)
    print(json.dumps(_result_to_dict(result), indent=2, ensure_ascii=False))
    return 0 if result.ok else 1


def _cmd_repl(args: argparse.Namespace) -> int:
    print("BetterWright REPL — end a snippet with a blank line, Ctrl-D to quit.\n")
    with BetterWright(
        policy=_policy_from_args(args), headless=not args.headed
    ) as bw:
        buffer: list[str] = []
        for raw in sys.stdin:
            line = raw.rstrip("\n")
            if line.strip():
                buffer.append(line)
                continue
            if not buffer:
                continue
            result = bw.run("\n".join(buffer), session=args.session)
            buffer.clear()
            print(json.dumps(_result_to_dict(result), indent=2, ensure_ascii=False))
        if buffer:
            result = bw.run("\n".join(buffer), session=args.session)
            print(json.dumps(_result_to_dict(result), indent=2, ensure_ascii=False))
    return 0


def _result_to_dict(result) -> dict:
    return {
        "ok": result.ok,
        "value": result.value,
        "error": result.error,
        "console": result.console,
        "events": result.events,
        "artifacts": [
            {"kind": a.kind, "path": a.path, "size": a.size} for a in result.artifacts
        ],
        "pages": result.pages,
        "warnings": result.warnings,
        "duration_ms": result.duration_ms,
    }


def _add_policy_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--allow-loopback", action="store_true", help="permit 127.0.0.1 / localhost")
    parser.add_argument(
        "--allow-private-network", action="store_true", help="permit RFC1918 / link-local hosts"
    )
    parser.add_argument("--allow-host", action="append", metavar="HOST", help="always allow a host (repeatable)")
    parser.add_argument("--block-host", action="append", metavar="HOST", help="always block a host (repeatable)")
    parser.add_argument("--headed", action="store_true", help="run Chromium headed")
    parser.add_argument("--session", default="default", help="named browser session")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="betterwright",
        description="A persistent, policy-guarded Playwright browser for agents.",
    )
    parser.add_argument("--version", action="version", version=f"betterwright {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("setup", help="install the Playwright runtime and Chromium").set_defaults(func=_cmd_setup)
    sub.add_parser("doctor", help="report runtime readiness").set_defaults(func=_cmd_doctor)

    run = sub.add_parser("run", help="execute a Playwright snippet")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("file", nargs="?", help="path to a .js snippet, or - for stdin")
    source.add_argument("-c", "--code", help="inline snippet")
    run.add_argument("--timeout", type=int, default=30, help="per-snippet timeout (s)")
    _add_policy_flags(run)
    run.set_defaults(func=_cmd_run)

    repl = sub.add_parser("repl", help="run snippets from stdin, one blank-line-separated block at a time")
    _add_policy_flags(repl)
    repl.set_defaults(func=_cmd_repl)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
