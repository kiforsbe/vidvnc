# Windows Host Clients UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the native Windows Clients page and the host-side connection-dialog modes needed to present approved-client state before server credential operations are implemented.

**Architecture:** Keep shell routing in `HostWindow.Layout.cs` and put all Clients-page parsing and visual composition in a focused `HostWindow.Clients.cs` partial. Accept the future server status shape through `UpdateClients(JsonElement)`, render empty state when no status has arrived, and expose unsupported mutations as visibly disabled controls. Refactor the existing connection dialog into a testable factory with session and approved-client modes; the latter explicitly reports that setup-key service support is not connected yet.

**Tech Stack:** C# 14, .NET 10, Windows App SDK / WinUI 3, existing executable Navigation regression test.

**Spec:** `docs/superpowers/specs/2026-09-15-approved-clients-design.md`

## Global Constraints

- Use **approved client** terminology; never use binding or bound in visible UI.
- The Clients navigation item sits between Sessions and Access.
- Do not add an Active sessions section; show live state as green **Connected** text in the approved-client row.
- Pending rows expose device name, username, browser/platform, network context, and Approve/Reject controls, but never password or client-secret data.
- Both connection-key types remain exactly `AAAA-BBBB`; this UI slice must not generate a setup key without authoritative server support.
- Session details and disconnect actions remain on the Sessions page.

---

### Task 1: Clients navigation and page state

**Files:**
- Create: `apps/windows-host/HostWindow.Clients.cs`
- Modify: `apps/windows-host/HostWindow.Layout.cs`
- Modify: `apps/windows-host/tests/Navigation/App.xaml.cs`

**Interfaces:**
- Consumes: future owner status JSON through `void UpdateClients(JsonElement status)` with `pending` and `approved` arrays.
- Produces: `void RenderClients()`, Clients navigation entry, summary/pending/approved visuals, and stable tags used by the integration test.

- [x] **Step 1: Write the failing navigation and rendering test**

Extend the Navigation fixture to require a `Clients` item between `Sessions` and `Access`, invoke `UpdateClients` with one pending row and two approved rows, and assert the rendered page has one pending approval, two approved clients, a green `Connected` status on the live client, muted last-connected text on the inactive client, and no `Active sessions` heading. Assert that password and client-secret fixture values do not appear in the visual tree.

- [x] **Step 2: Run the test to verify it fails**

Run the Navigation executable through the command in `apps/windows-host/tests/Navigation/README.md`.

Expected: FAIL because the Clients navigation item and `UpdateClients` method do not exist.

- [x] **Step 3: Implement the minimal Clients page**

Add `HostWindow.Clients.cs` with immutable parsed row records, `UpdateClients(JsonElement)`, `RenderClients()`, pending and approved row factories, semantic connection coloring, empty states, and disabled backend-pending action controls. Add Clients to `BuildShell()` and route it in `RenderPage()`.

- [x] **Step 4: Run the test to verify it passes**

Run the Navigation executable again.

Expected: PASS with all Clients assertions satisfied.

- [x] **Step 5: Commit**

```powershell
git add apps/windows-host/HostWindow.Clients.cs apps/windows-host/HostWindow.Layout.cs apps/windows-host/tests/Navigation/App.xaml.cs
git commit -m "feat: add Windows host clients page"
```

### Task 2: Shared connection-dialog modes

**Files:**
- Modify: `apps/windows-host/HostWindow.Layout.cs`
- Modify: `apps/windows-host/HostWindow.Clients.cs`
- Modify: `apps/windows-host/tests/Navigation/App.xaml.cs`

**Interfaces:**
- Consumes: existing `address.Text` and `password.Text` for `connect-once`; `approved-client` has no setup key until server support exists.
- Produces: `ContentDialog CreateConnectionDialog(string initialMode)`, `Task ShowConnection(string initialMode = "connect-once")`, and a Clients-header command that opens `approved-client` mode.

- [x] **Step 1: Write the failing dialog-mode test**

Inspect dialogs from `CreateConnectionDialog`. Assert session mode selects **Connect once** and contains the existing address and Session password; approved-client mode selects **Approve this client**, contains the connection address, does not expose the Session password, and presents a disabled setup-key area with an explicit server-support message. Assert the Clients page header command is labeled **Connect a device** and uses the approved-client mode.

- [x] **Step 2: Run the test to verify it fails**

Run the Navigation executable.

Expected: FAIL because `CreateConnectionDialog(string)` and the Clients header action do not exist.

- [x] **Step 3: Implement the dialog factory and mode switching**

Refactor the current dialog body into `CreateConnectionDialog`. Add a `Connection type` selector with **Connect once** and **Approve this client**. Rebuild only the mode-specific panel on selection: session mode retains the current copyable address/password controls, while approval mode shows the address and a disabled explanatory setup-key panel. Keep the footer action opening session mode and make the Clients header action open approval mode.

- [x] **Step 4: Run the test to verify it passes**

Run the Navigation executable, then run `dotnet build apps/windows-host/VidVnc.Host.csproj`.

Expected: both commands succeed with no new warnings or failures.

- [x] **Step 5: Commit**

```powershell
git add apps/windows-host/HostWindow.Layout.cs apps/windows-host/HostWindow.Clients.cs apps/windows-host/tests/Navigation/App.xaml.cs docs/superpowers/plans/2026-09-15-windows-host-clients-ui.md
git commit -m "feat: add approved-client connection dialog mode"
```
