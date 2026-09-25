# Security policy

VidVNC is a development preview for trusted local networks. It has not had production
security hardening or an external test, so don't expose it to the internet or forward its
ports unless you accept that. An opt-in [remote access mode](docs/security/remote-access.md)
exists (off by default), but it hasn't been validated on real networks yet. A self-hosted
VPN, with remote access left off, remains the recommended way to reach VidVNC from outside.
The [security analysis](docs/security/internet-exposure.md) records what is fixed and what is
still open.

## Supported versions

There are no releases yet. Only the latest commit on `main` receives fixes.

## Report a vulnerability

Report vulnerabilities privately: open this repository's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue or pull request.

Please include:

- the package or build, and its version or commit
- what an attacker can do, and what access they need (for example, being on the same
  network, or knowing the password)
- steps to reproduce, or a proof of concept

Don't include real passwords, session IDs or logs from machines that aren't yours.

VidVNC is maintained by one person, so responses are best effort, and there is no bug
bounty.
