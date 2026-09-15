# Shared packaging ownership

Place reusable staging, dependency inventory, notices/SBOM generation and payload
verification here when implemented. Keep installer-specific logic in the OS folder.

The staging contract must consume a target ID, configuration, version, architecture
and explicit build/runtime inputs. It must produce a file manifest with hashes and
origins, reject missing inputs and keep output inside its designated staging root.
Signing secrets are supplied externally; they never belong in manifests or logs.

Server payload assembly is shared by full-host and CLI products. Project-specific
native libraries are bundled; general runtimes (Visual C++ runtime, Node.js, .NET)
are declared prerequisites, never copied from outside the project.
`pe-dependencies.mjs` resolves DLL imports from project directories and reports
prerequisite DLLs; `staging.mjs` keeps outputs under `out/` as plain directories.
