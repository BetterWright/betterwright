# Sessions and the session daemon

A **session** is an independent set of pages plus its own `state` object, named
with `--session` (default `"default"`). A **session daemon** is the background
process that owns them: one per `BETTERWRIGHT_HOME` **and profile**, holding a
single browser — policy guard, stealth hooks, vault, worker, Chromium — and
serving thin CLI clients over a local socket.

That is what makes `run`, `repl`, and `exec` persistent. Open tabs, in-page
state, cookies, and (for `exec`) the agent's conversation survive between
invocations, so a coding agent can drive the browser one small step per call
without paying a launch or a re-login each time.

```bash
betterwright exec "sign in to example.com"      # starts the daemon, logs in
betterwright exec "download last month's invoice"   # same tabs, still signed in
betterwright sessions                            # what is open right now
betterwright close --all                         # end everything, stop the daemon
```

## Lifecycle

| Event | What happens |
| --- | --- |
| First `run` / `repl` / `exec` | The daemon is spawned detached, on demand |
| Different browser flags | An **idle** daemon is replaced; a **busy** one is left alone and the call falls back to a one-shot browser |
| Session idle past the TTL | Its pages close (default 15 minutes) |
| Last session closes | The daemon exits on its own |
| `betterwright close --all` | Every session of every profile closes and each daemon stops now |

Set `BETTERWRIGHT_NO_DAEMON=1` (or pass `--no-daemon`) to skip it entirely and
get a private one-shot browser per call — the pre-daemon behaviour.

## Concurrency

Different sessions run **at the same time**; calls within one session stay
strictly ordered. That ordering is the point: a snippet must never land on
pages another snippet in the same session is halfway through changing. Give
parallel workers their own `--session <name>` and they will not queue behind
each other.

```bash
betterwright exec --session research "compare the three plans" &
betterwright exec --session invoices "download last month's invoice" &
```

## Sessions vs. profiles

Sessions share one browser, and therefore **one cookie jar**: every session is
signed in as the same person. That is what you want for parallel work as one
identity, and it is cheap — one Chromium, many lanes.

A `--profile <name>` is the other axis: a **separate identity**, with its own
cookie jar, its own browser, its own daemon, and its own saved `exec`
transcripts. Use it when two runs must be different accounts — a posting
account and a reading account, work and personal — rather than two lanes of the
same account.

```bash
betterwright exec --profile social  "post the release note" &
betterwright exec --profile review  "summarise the top HN thread" &
betterwright sessions        # both daemons, labelled by profile
betterwright close --all     # stops every profile's daemon
```

`BETTERWRIGHT_PROFILE=social` sets the identity for a whole shell (and is the
only way to set it for the MCP server); `--profile` beats it. Both run at once
and both stay signed in, because each profile locks its own directory under
`$BETTERWRIGHT_HOME/browser/profiles/`. Two runs of the *same*
profile still serialize: the second gets an isolated, signed-out ephemeral
profile, exactly as two runs of the default profile do. Omitting `--profile`
keeps the single default profile and the daemon it already had. The vault is
shared, so a credential saved once fills in any profile.

## Stopping a run

`Ctrl-C` during `betterwright exec` **stops the agent** rather than orphaning
it. The run lives in the daemon, so simply abandoning the CLI would leave it
working — and spending — with nobody watching. On interrupt the in-flight model
call or browser step is aborted, the transcript is saved, and the run reports
`reason: "interrupted"`. The next `exec` on that session picks up from there.

A second `Ctrl-C` stops waiting for the daemon to confirm.

If the CLI dies without getting to say anything — a closed terminal, `SIGKILL`
— the daemon notices the run has no watcher and stops it after a grace period
(`BETTERWRIGHT_ORPHAN_GRACE_SECONDS`, default 30). Set it to `0` to let
detached runs finish on their own.

## Losing the connection

The run belongs to the daemon, not to the socket. If the pipe breaks mid-task
the CLI reconnects, reattaches to the same run, replays the step notes it
missed, and returns the same answer it would have gotten. When the run produced
more notes than the daemon's replay buffer holds, it says so rather than
silently resuming mid-story.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_HOME` | `~/.betterwright` | State directory; one daemon per home |
| `BETTERWRIGHT_SESSION_TTL_SECONDS` | `900` | Idle time before a session's pages close |
| `BETTERWRIGHT_ORPHAN_GRACE_SECONDS` | `30` | Unwatched-run grace before interrupt; `0` disables |
| `BETTERWRIGHT_NO_DAEMON` | unset | `1` forces one-shot browsers |

## Security model

The socket is `0600` inside the `0700` home — the ssh-agent shape, same-user
processes only. On Windows it is a named pipe under the same account.

A unix socket path is capped by `sockaddr_un.sun_path` (104 bytes on macOS, 108
on Linux). If `$BETTERWRIGHT_HOME` is deep enough that `<home>/daemon.sock`
would exceed that, the daemon binds a short socket derived from the home inside
a `0700` directory in the system temp dir, whose ownership is verified before
use — same `0600` socket, same same-user-only rule. Without this the daemon
died on `listen` and every command silently fell back to a private,
non-persistent browser. Sessions
are **collaboration scopes, not a security boundary**: any client that can open
the socket can drive any session. What *is* a boundary is the worker process —
model-authored snippets run there, not in the daemon, and never see Node's
`process`, module loader, filesystem, or the route APIs that enforce the
network policy. See [architecture.md](architecture.md).

## Diagnosing

`betterwright sessions` prints the daemon's pid, version, uptime, active run
count, and per-session idle time, watchers, and in-flight calls. The daemon's
own stderr goes to `<BETTERWRIGHT_HOME>/daemon.log` (rotated once past 4 MB);
if a run ends with a connection error, that file is where the reason is.

A result carrying the warning `session persistence unavailable (…)` means the
command ran in a private browser that closed when it exited — tabs and page
state did not survive. The parenthesised reason says why; `daemon.log` says the
rest.
