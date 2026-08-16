import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chromiumNeedsSoftwareGpu,
  managedForkArgs,
} from "../../dist/src/browser-runtime.js";
import {
  chromiumArgsWarning,
  guardProxyLaunchArgs,
  mergeChromiumArgs,
  normalizeChromiumArgs,
  parseChromiumArgs,
  resolveChromiumArgs,
} from "../../dist/src/chromium-args.js";

test("empty and whitespace-only argument strings parse to nothing", () => {
  for (const raw of ["", "   ", "\t\n", null, undefined]) {
    assert.deepEqual(parseChromiumArgs(raw), []);
  }
});

test("arguments split on arbitrary whitespace runs", () => {
  assert.deepEqual(
    parseChromiumArgs("  --disable-gpu \t --disable-software-rasterizer\n"),
    ["--disable-gpu", "--disable-software-rasterizer"],
  );
});

test("quotes keep a spaced switch value in one argument", () => {
  assert.deepEqual(parseChromiumArgs('--host-rules="MAP * 127.0.0.1" --disable-gpu'), [
    "--host-rules=MAP * 127.0.0.1",
    "--disable-gpu",
  ]);
  assert.deepEqual(parseChromiumArgs("--host-rules='MAP * 127.0.0.1'"), [
    "--host-rules=MAP * 127.0.0.1",
  ]);
});

test("an empty quoted value survives as an explicit empty switch value", () => {
  assert.deepEqual(parseChromiumArgs('--disable-features=""'), ["--disable-features="]);
});

test("an unterminated quote is an error rather than a silently truncated switch", () => {
  assert.throws(() => parseChromiumArgs('--host-rules="MAP * 127.0.0.1'), {
    name: "TypeError",
    message: /Unterminated double quote/,
  });
  assert.throws(() => parseChromiumArgs("--host-rules='MAP"), {
    name: "TypeError",
    message: /Unterminated single quote/,
  });
});

test("well-formed switches pass through normalization in caller order", () => {
  assert.deepEqual(
    normalizeChromiumArgs(["--disable-gpu", "--js-flags=--max-old-space-size=512"]),
    ["--disable-gpu", "--js-flags=--max-old-space-size=512"],
  );
});

test("normalization accepts a raw string and drops blank entries", () => {
  assert.deepEqual(normalizeChromiumArgs("--disable-gpu"), ["--disable-gpu"]);
  assert.deepEqual(normalizeChromiumArgs(["--disable-gpu", "", "   "]), ["--disable-gpu"]);
  assert.deepEqual(normalizeChromiumArgs(null), []);
});

test("non-switch and malformed entries are rejected with the source named", () => {
  assert.throws(() => normalizeChromiumArgs(["disable-gpu"], "BETTERWRIGHT_CHROMIUM_ARGS"), {
    name: "TypeError",
    message: /BETTERWRIGHT_CHROMIUM_ARGS entries must be Chromium switches starting with "--"/,
  });
  assert.throws(() => normalizeChromiumArgs(["-disable-gpu"]), { name: "TypeError" });
  assert.throws(() => normalizeChromiumArgs(["--"]), {
    name: "TypeError",
    message: /malformed switch name/,
  });
  assert.throws(() => normalizeChromiumArgs(["--bad_name"]), {
    name: "TypeError",
    message: /malformed switch name/,
  });
  assert.throws(() => normalizeChromiumArgs([42]), {
    name: "TypeError",
    message: /entries must be strings/,
  });
  assert.throws(() => normalizeChromiumArgs({ "--disable-gpu": true }), {
    name: "TypeError",
    message: /must be an array of strings or a string/,
  });
});

test("switches that would route traffic off the guard proxy are rejected", () => {
  for (const arg of [
    "--proxy-server=http://10.0.0.1:8080",
    "--proxy-pac-url=http://x/p.pac",
    "--proxy-bypass-list=*",
    "--no-proxy-server",
    "--winhttp-proxy-resolver",
  ]) {
    assert.throws(() => normalizeChromiumArgs([arg]), {
      name: "TypeError",
      message: /reserved by BetterWright/,
    });
  }
});

test("switches that would open a second browser control channel are rejected", () => {
  for (const arg of [
    "--remote-debugging-port=9222",
    "--remote-debugging-pipe",
    "--remote-debugging-address=0.0.0.0",
    "--remote-allow-origins=*",
  ]) {
    assert.throws(() => normalizeChromiumArgs([arg]), {
      name: "TypeError",
      message: /BetterWright owns the browser control channel/,
    });
  }
});

test("profile, identity, and headless switches are rejected with their alternative named", () => {
  const cases: [string, RegExp][] = [
    ["--user-data-dir=/tmp/x", /lock-protected/],
    ["--profile-directory=Default", /lock-protected/],
    ["--lang=de-DE", /use the `locale` option/],
    ["--bw-timezone=Europe/Berlin", /use the `timezone` option/],
    ["--headless=new", /use the `headless` option/],
    ["--fingerprint=1234", /`locale`, `timezone`, and `platform`/],
    ["--fingerprint-platform=windows", /`locale`, `timezone`, and `platform`/],
    ["--fingerprint-locale=de-DE", /`locale`, `timezone`, and `platform`/],
  ];
  for (const [arg, message] of cases) {
    // Node regex-matches RegExp values in the expectation object; its types
    // only describe the string form.
    assert.throws(
      () => normalizeChromiumArgs([arg]),
      { name: "TypeError", message } as any,
      arg,
    );
  }
});

test("a switch merely prefixed like a reserved one is still allowed", () => {
  // `--fingerprint` is reserved by prefix, but only on a `-` boundary: an
  // unrelated switch that happens to start with the same letters must not be
  // swept up by the guard.
  assert.deepEqual(normalizeChromiumArgs(["--fingerprinting-guard"]), [
    "--fingerprinting-guard",
  ]);
  assert.deepEqual(normalizeChromiumArgs(["--headless-mode-extras"]), [
    "--headless-mode-extras",
  ]);
});

test("the option and the environment variable both contribute, option first", () => {
  const resolved = resolveChromiumArgs(["--disable-gpu"], {
    BETTERWRIGHT_CHROMIUM_ARGS: "--disk-cache-size=1 --mute-audio",
  });
  assert.deepEqual(resolved, [
    "--disable-gpu",
    "--disk-cache-size=1",
    "--mute-audio",
  ]);
});

test("a reserved switch is rejected from the environment as well as the option", () => {
  assert.throws(
    () => resolveChromiumArgs([], { BETTERWRIGHT_CHROMIUM_ARGS: "--proxy-server=http://x" }),
    { name: "TypeError", message: /reserved by BetterWright/ },
  );
});

test("resolving with neither source set yields nothing", () => {
  assert.deepEqual(resolveChromiumArgs(undefined, {}), []);
});

test("caller switches are appended after the managed ones", () => {
  const managed = managedForkArgs("seed-1");
  const { args, ignored } = mergeChromiumArgs(managed, ["--disable-gpu"]);
  assert.deepEqual(args.slice(0, managed.length), managed);
  assert.equal(args.at(-1), "--disable-gpu");
  assert.deepEqual(ignored, []);
});

test("a collision keeps BetterWright's value and reports the dropped switch", () => {
  // Chromium resolves duplicate switches last-wins, so appending a colliding
  // switch would override the managed value. It must be dropped instead.
  const managed = managedForkArgs("seed-2");
  assert.ok(managed.includes("--renderer-process-limit=2"));
  const { args, ignored } = mergeChromiumArgs(managed, [
    "--renderer-process-limit=8",
    "--disable-gpu",
  ]);
  assert.deepEqual(ignored, ["--renderer-process-limit"]);
  assert.ok(args.includes("--renderer-process-limit=2"));
  assert.ok(!args.some((arg) => arg.startsWith("--renderer-process-limit=8")));
  assert.ok(args.includes("--disable-gpu"));
});

test("software rasterizer boilerplate is dropped with a warning instead of failing launch", () => {
  const extra = normalizeChromiumArgs(["--disable-software-rasterizer"]);
  assert.deepEqual(extra, ["--disable-software-rasterizer"]);
  const { args, ignored } = mergeChromiumArgs([], extra);
  assert.deepEqual(args, []);
  assert.deepEqual(ignored, ["--disable-software-rasterizer"]);
  assert.match(
    chromiumArgsWarning(ignored),
    /managed browser must retain its WebGL software fallback/,
  );
});

test("host-resolver-rules is dropped so Chromium does not paint an infobar", () => {
  const extra = normalizeChromiumArgs([
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  ]);
  const { args, ignored } = mergeChromiumArgs([], extra);
  assert.deepEqual(args, []);
  assert.deepEqual(ignored, ["--host-resolver-rules"]);
  assert.match(chromiumArgsWarning(ignored), /unsupported-flag infobar/);
});

test("guard proxy launch args point Chromium at the SOCKS port without resolver rules", () => {
  assert.deepEqual(guardProxyLaunchArgs(1080), [
    "--proxy-server=socks5://127.0.0.1:1080",
    "--proxy-bypass-list=<-loopback>",
  ]);
  assert.equal(
    guardProxyLaunchArgs(9050).some((arg) => arg.startsWith("--host-resolver-rules")),
    false,
  );
  assert.throws(() => guardProxyLaunchArgs(0), { name: "TypeError" });
  assert.throws(() => guardProxyLaunchArgs(70_000), { name: "TypeError" });
});

test("the WebRTC proxy boundary cannot be displaced", () => {
  const boundary = "--webrtc-ip-handling-policy";
  for (const managed of [managedForkArgs("seed-3")]) {
    const { args, ignored } = mergeChromiumArgs(managed, [`${boundary}=default`]);
    assert.deepEqual(ignored, [boundary]);
    assert.ok(args.includes(`${boundary}=disable_non_proxied_udp`));
    assert.equal(args.filter((arg) => arg.startsWith(boundary)).length, 1);
  }
});

test("GPU capability detection distinguishes accessible DRI devices", () => {
  assert.equal(
    chromiumNeedsSoftwareGpu({
      platform: "linux",
      readdirSync: () => ["renderD128", "card0"],
      accessSync: (device) => {
        if (device.endsWith("renderD128")) return;
        throw new Error("inaccessible");
      },
    }),
    false,
  );
  assert.equal(
    chromiumNeedsSoftwareGpu({
      platform: "linux",
      readdirSync: () => ["renderD128"],
      accessSync: () => {
        throw new Error("not bound into sandbox");
      },
    }),
    true,
  );
  assert.equal(
    chromiumNeedsSoftwareGpu({
      platform: "darwin",
      readdirSync: () => {
        throw new Error("must not inspect DRI on macOS");
      },
    }),
    false,
  );

  // On a GPU host (the default), the managed args bind the hardware GL backend
  // so a headless launch's implicit --use-angle=swiftshader-webgl never wins and
  // silently forces software rendering (which would trip the fork's integrated-
  // GPU spoof and the resulting PixelScan "masking detected" inconsistency).
  const native = managedForkArgs("seed");
  assert.ok(native.includes("--use-gl=angle"));
  assert.ok(native.includes("--use-angle=gl"));
  assert.ok(!native.includes("--use-angle=swiftshader"));
  assert.ok(!native.includes("--enable-unsafe-swiftshader"));
});

test("a switch repeated by the caller is applied once", () => {
  const { args, ignored } = mergeChromiumArgs([], ["--disable-gpu", "--disable-gpu=1"]);
  assert.deepEqual(args, ["--disable-gpu"]);
  assert.deepEqual(ignored, ["--disable-gpu"]);
});

test("merging without caller switches leaves the managed list untouched", () => {
  const managed = managedForkArgs("seed-4");
  const { args, ignored } = mergeChromiumArgs(managed, []);
  assert.deepEqual(args, managed);
  assert.deepEqual(ignored, []);
});

test("the dropped-switch warning names each switch and pluralizes correctly", () => {
  assert.equal(chromiumArgsWarning([]), "");
  assert.equal(chromiumArgsWarning(undefined), "");
  assert.match(chromiumArgsWarning(["--test-type"]), /Ignored Chromium switch --test-type:/);
  assert.match(
    chromiumArgsWarning(["--test-type", "--lang"]),
    /Ignored Chromium switches --test-type, --lang:/,
  );
});
