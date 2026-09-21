# Contributing to VidVNC

Thanks for your interest in VidVNC. It is a development preview maintained by one
person, kiforsbe.

## Pull requests

Pull requests are not accepted at this time. VidVNC is licensed under the AGPL and may
also be offered under commercial licenses, which requires owning all of its code and
documentation (see [LICENSING.md](LICENSING.md)). Pull requests may be closed without
review. Issues are the best way to help.

## Report a bug

1. Search the existing issues first. If one matches, add your details there instead of
   opening another.
2. Open a **Bug report** and fill in the form, including the package or build, version,
   Windows build, graphics card and driver, and the viewing device and browser.
3. Paste relevant logs from `%LOCALAPPDATA%\VidVNC\logs`. Remove passwords, IP addresses
   and anything else private first.

## Suggest a feature

Check [the roadmap](docs/ROADMAP.md) first; it may already be planned. Then open a
**Feature request** and describe the problem you want solved before the solution.

## Report a security vulnerability

Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Build and test your own copy

Follow [Build and run (Windows)](README.md#build-and-run-windows). These commands run
from the repository root:

| Command                 | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `npm ci`                | Installs the pinned JavaScript dependencies                          |
| `npm run format:check`  | Checks formatting                                                    |
| `npm test`              | Runs the portable tests, with hardware stubbed                       |
| `npm run test:hardware` | Runs the hardware tests (Windows 25H2+, a GPU with a hardware encoder, interactive desktop) |

Forks are welcome under the AGPL. If you distribute a modified VidVNC, or let people
interact with it over a network, you must offer them its source code under the same
license.
