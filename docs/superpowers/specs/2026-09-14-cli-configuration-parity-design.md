# CLI configuration parity with the Windows host

Date: 2026-09-14. Approved in conversation section by section. Goal: every setting
the WinUI host can change is also changeable from the CLI server, with the same
validation, conflict and disconnect semantics. The CLI bundle has no host UI, so
without this its users can only hand-edit JSON.

## Decisions

- Two entry points over one command layer: **live console commands** typed into a
  running CLI server, and **offline `config` subcommands** that run without starting
  a server.
- Offline mutations **refuse while any VidVNC server instance is running** and point
  to the live console. Offline reads still work. No IPC or new admin channel.
- Commands mirror host pages and concepts, not JSON paths.
- Session IDs are bearer credentials (`Authorization: Bearer <sessionId>`). The CLI
  never prints them in any mode or output format.

## Host inventory covered

| Host page | Settings/actions |
|---|---|
| Displays | Per-display sharing, per-display default profile, host default profile, desktop audio |
| Streaming profiles | Add, edit, duplicate, remove, enable/disable, reorder; client customization mode; allowed resolutions, frame rates and bitrates |
| Sessions | Status list, grant/revoke control, stop stream, disconnect device |
| Access | Default keyboard/mouse access for new connections |
| Overview/Settings | Connection addresses/password, logs location |

Not carried over: Identify (native overlay windows; `displays` prints position,
size and primary flag instead), theme (window-only), per-display allowed profiles
(not implemented in the host either).

## Command surface

Display selectors: `2` or `#2` (the server's existing inventory number: primary
first, then left to right), or a display ID prefix of at least 8 hex characters.
Profile selectors: exact ID, or exact case-insensitive name. Session selectors:
per-run console number (`#1`, assigned when first seen, never reused during the
run) or any of the session's public stream IDs. Ambiguous or unknown selectors are
errors, never guesses.

| Area | Commands | Live | Offline |
|---|---|:-:|:-:|
| General | `help [command]` · `info` | ✓ | ✓ (`info`: data/log folders, running instances) |
| Displays | `displays` · `share <display> on\|off` · `display-default <display> <profile>\|host` · `default-profile auto\|<profile>` · `audio on\|off` | ✓ | ✓ |
| Profiles | `profiles` · `profile add <name> [--size WxH] [--fps N] [--bitrate KBPS] [--description T] [--disabled]` · `profile edit <profile> [--name T] [--size WxH] [--fps N] [--bitrate KBPS] [--description T] [--enabled\|--disabled]` · `profile duplicate <profile>` · `profile remove <profile>` · `profile enable\|disable <profile>` · `profile move <profile> up\|down\|<position>` | ✓ | ✓ |
| Client customization | `client-mode profiles\|options` · `options` · `options add\|remove size WxH` · `options add\|remove framerate N` · `options add\|remove bitrate KBPS` | ✓ | ✓ |
| Access | `access` · `access approval\|available` | ✓ | ✓ |
| Sessions | `sessions` · `grant <session>` · `revoke [session]` · `stop <stream-id>` · `disconnect <session>` | ✓ | — |
| Scripting | `--json` on `displays`, `profiles`, `options`, `access`, `show` · `show` (policy, access, profile order) | — | ✓ |

Live `info` prints connection URLs, the session password, the local diagnostics
URL, data folder, log folder and default control. `sessions` prints per device:
console number, device, address, health, audio, control; per stream: public stream
ID, name, output size, target fps and profile.

Invocation: live commands are typed into the CLI server console. Offline:
`node apps/server/src/main.mjs config <command> [arguments]`, root script
`npm run config -- <command> [arguments]`; the future `VidVNC.Server.cmd config …`
launcher passes arguments through unchanged. `config` with no command prints help.

Behavior rules:

- Policy-changing live commands (display, profile, client-mode and options
  commands) require `[y/N]` confirmation when sessions are connected, because a
  saved policy disconnects clients. `--yes` skips the prompt. Each command applies
  immediately; there is no staged draft/Apply step.
- `profile move` writes only `profile-order.json` and never disconnects.
  Positions are 1-based in the displayed order.
  `access` never restarts streams.
- `profile add` defaults match the host's new-profile defaults: 1920×1080, 30 fps,
  4000 kbit/s, available, fixed frame delivery. New profile IDs are slugs of the
  name (lowercase ASCII letters/digits, other runs become `-`, at most 48
  characters, `profile` if empty), suffixed `-2`, `-3`… on collision, never `auto`
  or `custom`. `profile duplicate` names the copy `Copy of <name>`.
- Bitrates are entered as whole kbit/s everywhere; tables display Mbit/s.
- Existing `grant <stream-id>` and `disconnect <stream-id>` usage keeps working
  because sessions also resolve by stream ID.
- Offline exit codes: `0` success; `1` failure (validation, conflict, running
  instance, worker unavailable); `2` usage error.

## Architecture

New modules under `apps/server/src/cli/`:

| Module | Responsibility | Depends on |
|---|---|---|
| `tokenize.mjs` | Quote-aware argument splitting (`"Office desk"`, escaped quotes); no evaluation; 1024-character line cap | — |
| `policy-edits.mjs` | Pure candidate builders for each policy change, including first-run display-sharing seeding; every result passes `validateStreamPolicy` | `stream-policy.mjs` |
| `resolve.mjs` | Display, profile and session selector resolution | inventory, policy, status rows |
| `commands.mjs` | Command table: name, availability (live/offline/both), argument parser, `needsDisplays`, `mayDisconnect`, help text, handler against a context | modules above |
| `format.mjs` | Text tables and offline JSON output | — |
| `console.mjs` | Live readline adapter: serialized command queue, confirmation state machine, session numbering | `commands.mjs` |
| `offline.mjs` | `config` runner: instance check, store opening, lazy display listing, exit codes | `commands.mjs` |

Context interface used by every handler: `policy()`, `savePolicy(candidate,
{ confirmDisconnect })`, `access()`, `saveAccess(defaultControl)`,
`profileOrder()`, `saveProfileOrder(ids)`, `displays()`, and `sessions` (live
only: `status()`, `grant`, `revoke`, `stopStream`, `disconnect`).

- **Live context** wraps the running `PolicyController`, `AccessSettings`,
  `DisplayInventory` and `StreamRuntime`: the same code path as the host's owner
  pipe, including revision checks, busy rejection and disconnect confirmation.
- **Offline context** opens `StreamPolicyStore` and `AccessSettings` directly and
  lists displays through the worker's `--list-displays` only when a command needs
  them. It has no sessions. `offline.mjs` accepts an injected display-listing
  function for tests.

Changes to existing code:

- `main.mjs`: `config` as the first argument dispatches to `offline.mjs` before any
  worker probe or listener starts. The non-desktop console block moves into
  `console.mjs`, and the banner's command list becomes a `Type help for commands.`
  hint. The `--desktop` owner-pipe protocol is unchanged.
- New `apps/server/src/paths.mjs`: data folder, settings file names and the
  instances folder, shared by server start and offline commands. First-run seeding
  (share the primary persistent display when `displaySharing` is `null`) moves into
  `policy-edits.mjs` and is used by both, so offline `share 2 on` on a fresh install
  shares the primary display and display 2.
- `profile-order.mjs` gains `saveProfileOrder`: validated like the host's
  `ProfileOrderStore` (at most 64 unique IDs of ASCII letters, digits and `-`),
  written to a temporary sibling and renamed into place.
- Instance registration: every server process, CLI or host-launched, writes
  `instances/<pid>.json` (`pid`, `startedAt`, `mode`, `port`) under the data folder
  at startup and removes it on shutdown, including from a synchronous `exit`
  handler. Offline mutations refuse while any recorded PID is alive
  (`process.kill(pid, 0)` succeeds or fails with `EPERM`); files for dead PIDs
  (`ESRCH`) are ignored. PID reuse can cause a
  false refusal, which fails safe; the message names the PID and file.

## Error handling

- Usage errors print one line plus `Type help <command>`; offline exits `2`.
- Validation errors show `validateStreamPolicy` messages verbatim, matching the
  host. CLI pre-checks cover format only: `WxH` syntax, even dimensions, integers.
- Blocked by the validator, as in the host: disabling or removing the last
  available profile; disabling or removing a profile still used as host or display
  default (the CLI appends "change the default first"); removing the last entry of
  an allowed-options list.
- Sharing a non-persistent display is rejected, matching the host's disabled
  toggle.
- Live confirmation resolves the display/profile target before prompting and names
  it. The candidate is rebuilt from the current policy snapshot after confirmation,
  so waiting at the prompt does not cause revision conflicts. If the target vanished
  meanwhile, nothing is saved. Declining, or end of input, prints
  `No changes applied.` Lines typed while a prompt is open queue behind it.
- Store conflicts and stranded lock files surface the store's message with mode
  advice: restart the server (live) or retry (offline). Lock files are never
  removed automatically.
- Offline worker unavailable: display commands exit `1` with an actionable message;
  profile, option and access commands still work.
- Instance file write failure at startup prints a warning and does not block
  serving. The stores' changed-on-disk detection still prevents silent overwrites.
- `sessionId` never appears in output. The password appears only in live `info`
  and the existing startup banner.

## Testing

Portable tests in `apps/server/tests/` (picked up by `tools/test.mjs`):

| File | Coverage |
|---|---|
| `cli-tokenize.test.mjs` | Quotes, escapes, unterminated quotes, line cap |
| `cli-policy-edits.test.mjs` | Each edit yields a valid policy; validator guards; first-run seeding; duplicate naming; slug generation, collisions and reserved IDs |
| `cli-resolve.test.mjs` | Display number/`#number`/ID prefix/ambiguity; profile ID/name/ambiguity; session number and stream ID |
| `cli-commands.test.mjs` | Parsing per command with a fake context; live-only rejection offline; confirm/decline/`--yes`; `--json`; every command has help |
| `cli-console.test.mjs` | Readline over in-memory streams: serialization, confirmation state machine, session numbering; asserts no output contains a session UUID |
| `cli-offline.test.mjs` | `main.mjs config …` subprocesses against a temporary data folder (`LOCALAPPDATA` override): exit codes, running-instance refusal, stale instance files, JSON output |
| `profile-order.test.mjs` | `saveProfileOrder` validation and round trip through `applyProfileOrder` |
| `cli-parity.test.mjs` | Every editable field in the policy, profile, allowed-options and access schemas maps to at least one CLI command, so new host settings cannot silently skip the CLI |

Run the server suite only (`npm test --workspace @vidvnc/server`); no native or
host code changes. Manual acceptance on hardware: start the CLI server, `displays`,
`share 2 on`, connect a browser and confirm display 2 is offered; then stop the
server and verify an offline `config access available` succeeds while it refuses
with the server running. Update the README CLI section.

## Out of scope

`VidVNC.Server.cmd` launcher and CLI bundle (packaging milestone), Identify,
theme, per-display allowed profiles, forwarding offline commands to a running
server, and the startup banner's stale resolution/frame-rate line.
