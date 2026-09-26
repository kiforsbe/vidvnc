# Instructions for coding agents

These rules apply to any AI coding agent working in this repository (Claude Code reads
them through [CLAUDE.md](CLAUDE.md)). They add to [CONTRIBUTING.md](CONTRIBUTING.md) and the
[architecture conventions](docs/ARCHITECTURE.md#repository-layout-and-ownership); where they
overlap, follow both.

## Keep the documentation current

Documentation is part of the change, not a follow-up. Every commit that changes behaviour,
an interface, a setting, a security property or a process updates the documents it affects
**in the same commit** (or the same push, for a series). A reviewer should never find a
document that describes the code as it was before.

Before you commit, go through this table and update every row your change touches:

| Document                                                                                                                 | Update it when a change…                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [CHANGELOG.md](CHANGELOG.md)                                                                                             | Is visible to a user or operator: a feature, fix, behaviour change, removal, security fix, or known limitation. See [Changelog entries](#changelog-entries).                                                 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                             | Changes how processes, sessions, streams, the media pipeline, input, recovery or diagnostics work; adds or changes a message, route, state or boundary; or changes repository layout, dependencies or tests. |
| [docs/ARCHITECTURE.md → Security architecture](docs/ARCHITECTURE.md#security-architecture)                               | Adds or changes an entry point, secret, credential, persisted file, trust boundary, privilege, security header, limit or default. Add a row to the threat model for any new threat.                          |
| [docs/security/internet-exposure.md](docs/security/internet-exposure.md)                                                 | Fixes, adds or changes the status of a security finding, changes the exposure map or controls, or records a new verification run.                                                                            |
| [docs/security/remote-access.md](docs/security/remote-access.md)                                                         | Changes anything an operator does to set up or check remote access.                                                                                                                                          |
| [SECURITY.md](SECURITY.md)                                                                                               | Changes the support position or the reporting process.                                                                                                                                                       |
| [README.md](README.md)                                                                                                   | Changes installing, running, building, packaging, CLI commands or configuration, data locations, or what the user sees and does (including the iPhone notes).                                                |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                       | Changes a build or test command, or how dependencies are brought up to date.                                                                                                                                 |
| [docs/ROADMAP.md](docs/ROADMAP.md)                                                                                       | Delivers, starts, drops or re-scopes a roadmap item, or changes what has been validated.                                                                                                                     |
| [docs/PACKAGING.md](docs/PACKAGING.md), [packaging/\*/README.md](packaging/README.md)                                    | Changes a product, payload, installer, signing or packaging step.                                                                                                                                            |
| [docs/investigations/\*.md](docs/investigations/IOS-COMPATIBILITY.md)                                                    | Changes behaviour an investigation describes as current (for example iOS compatibility).                                                                                                                     |
| App, tool and test READMEs (`apps/*/README.md`, `tools/debug/README.md`, `apps/windows-host/tests/Navigation/README.md`) | Changes what that directory owns, how to run it, or what its checks cover.                                                                                                                                   |
| [LICENSING.md](LICENSING.md), package license notices                                                                    | Adds, removes or upgrades a third-party dependency that ships in a package.                                                                                                                                  |
| [AGENTS.md](AGENTS.md)                                                                                                   | Changes any process described here.                                                                                                                                                                          |

Do **not** update `docs/superpowers/plans/` or `docs/superpowers/specs/`. They are dated
history ([why](docs/superpowers/README.md)); write a new dated spec or plan instead of
editing an old one.

### How to write the updates

- **Check facts against the code.** Every number, name, route, limit and file path in a
  document must match the code at that commit. Link to the source file that owns a claim,
  as the existing documents do.
- **Diagrams.** `docs/ARCHITECTURE.md` uses Mermaid. When a flow, state machine, class or
  boundary changes, update its diagram, or add one if the change introduces a new flow.
  Make sure every diagram still parses (Mermaid 11); a semicolon inside a sequence-diagram
  message, for example, breaks it.
- **Be honest about verification.** Say what was tested and how, and what was not (for
  example "not yet validated on an iPhone"). Record security verification runs in the
  security analysis's verification record.
- **Style.** Plain, direct sentences, matching the spelling and terms of the surrounding
  text; wrap Markdown at about 95 columns. Markdown is not covered by `npm run format`,
  so align any table you add or edit with `npx prettier --write <file>` and check the
  diff touches only your section.
- **Don't duplicate.** Each fact has one home (see the document map at the top of the
  security architecture). Link to it instead of copying it.

### Changelog entries

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

- Add entries under `## [Unreleased]` at the top, creating that heading if it is missing.
  Never add new entries under a released version.
- Use these subsections, in this order, and only the ones you need: `### Added`,
  `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`, then this
  project's `### Known limitations`.
- Write for users and operators, not developers: say what changed and what they will
  notice, in the product's words (the VidVNC app, the command line, the viewer). Name
  commands, settings and pages exactly as they appear. Leave out refactors, test-only and
  documentation-only changes unless they change what someone does.
- One entry per change; extend an existing `Unreleased` entry instead of adding a second
  one for the same feature.

## Before you commit

Run, from the repository root:

```sh
npm run format:check
npm test
```

Run the narrower suite for what you changed as you work (see
[CONTRIBUTING.md](CONTRIBUTING.md#build-and-test-your-own-copy)); hardware and host tests
need Windows. If you could not run a relevant check, say so in your summary.

## Versions, tags and releases

VidVNC uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0:

- **Patch** (`0.9.0` → `0.9.1`): fixes, and small additions that change no setting file
  format, protocol message or command.
- **Minor** (`0.9.1` → `0.10.0`): new features, or anything that changes a setting file,
  a protocol between processes, a command, or otherwise needs users to act.

Only cut a release when the owner asks for one. The owner decides the version number.

### Release steps

1. **Start from an up-to-date `main`** with a clean working tree:

   ```sh
   git fetch origin main --tags
   git checkout main
   git merge --ff-only origin/main
   git status
   ```

2. **Finish the changelog.** Make sure `## [Unreleased]` lists everything since the last
   tag (`git log --oneline <last-tag>..HEAD` helps), then rename that heading to the
   version and today's date, in ISO format:

   ```md
   ## [0.9.2] - 2026-09-27
   ```

   Rename it before the next step: if no heading for the version exists,
   `set-version` adds an empty `## [x.y.z] - Unreleased` heading instead.

3. **Set the version everywhere** with the repository's tool; don't edit version fields by
   hand:

   ```sh
   npm run set-version -- 0.9.2
   npm run set-version
   ```

   The first command updates every declared version: the root and workspace
   `package.json` files and their `@vidvnc/*` dependencies, `package-lock.json`,
   `apps/windows-host/VidVnc.Host.csproj`, `apps/windows-host/app.manifest` (as
   `0.9.2.0`), and `CMakeLists.txt` ([tools/version.mjs](tools/version.mjs)). The second,
   with no argument, lists them and must end with `Version: 0.9.2`. Also search for the old
   version string to catch anything the tool doesn't own:

   ```sh
   git grep -n "0\.9\.1" -- ':!CHANGELOG.md' ':!package-lock.json'
   ```

4. **Check the release commit.** Run `npm run format:check` and `npm test`. On Windows,
   also run `npm run test:hardware`, `npm run test:host` and, if packages are part of the
   release, `npm run build` and `npm run package` (see
   [Windows packages](README.md#windows-packages)).

5. **Commit** only the version and changelog changes, with the message
   `Release v0.9.2`:

   ```sh
   git commit -am "Release v0.9.2"
   ```

6. **Tag the release commit** with an annotated tag named `v` plus the version, and the
   same message:

   ```sh
   git tag -a v0.9.2 -m "Release v0.9.2"
   ```

   Never move, delete or re-create a tag that has been pushed. If a release is wrong,
   release the next patch version instead.

7. **Push the commit, then the tag:**

   ```sh
   git push origin main
   git push origin v0.9.2
   ```

8. **Publish a GitHub release, when the owner wants one.** Create it from the tag, title
   it `VidVNC 0.9.2`, paste that version's changelog section as the notes, and mark it as a
   pre-release while the version is below 1.0.0. Attach packages only if they were built
   from the tagged commit, and say in the notes that they are unsigned development builds
   (the MSIX is signed with a self-signed development certificate).

9. **Open the next cycle** by adding an empty `## [Unreleased]` heading above the new
   version in the changelog, in the next change that adds an entry.

### Past releases

Tags `v0.3.0` to `v0.9.0` exist as annotated tags on their release commits; `0.1.0`,
`0.2.0` and `0.9.1` were released without tags. Check `git tag -l` before tagging, and
don't create tags for past releases unless the owner asks.

## Git and GitHub

- Don't push to `main`, rewrite published history, or create tags or releases unless the
  owner has asked for that in the current task.
- Keep commits focused, with an imperative subject line (`Viewer: stop touch drags from
clicking`) and a body that says why.
- The repository doesn't accept outside pull requests ([CONTRIBUTING.md](CONTRIBUTING.md)).
- Never commit secrets, real passwords, session tokens, logs from real machines,
  downloaded SDKs or generated packages.
