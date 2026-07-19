# Security

BetterWright hands a browser to automated, sometimes model-authored, code. Its
threat model and the controls that enforce it are documented in
[docs/architecture.md](docs/architecture.md#security-model). In short:

- **The network floor** (metadata endpoints and private networks blocked at the
  resolver, transport proxy, and policy layers) is the real boundary and fails
  closed.
- **The sandbox** removes the escape-hatch APIs from model code as defense in
  depth. It is not, and does not claim to be, a `node:vm` security boundary.
- **The credential vault** encrypts records at rest, URL-gates login lookup,
  fills detected forms without returning secrets, and redacts handled values
  from outputs. The filled value still exists in the matched page's DOM, and
  the local key file does not defend against an attacker who can already read
  files as the same OS user. External vault adapters remain available for a
  stronger key-management boundary.

Please read those sections before deploying BetterWright somewhere it can be
driven by untrusted input.

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** flow (Security → Advisories) on the repository, rather than
opening a public issue. Please include a description, affected version, and a
minimal reproduction. We aim to acknowledge reports within a few days.

Because the network floor is the boundary we rely on, a way to reach a blocked
metadata endpoint or private address from inside a `run()` snippet — bypassing
the resolver rules, the transport proxy, and the policy — is the highest-severity
class of report.
