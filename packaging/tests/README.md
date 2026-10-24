# Shared packaging tests

Own catalog validation, safe staging paths, runtime-manifest validation, required
dependency/notice inventory and client/server payload separation tests here.
These tests should be portable and not invoke installers or alter machine settings.
PE dependency resolution and staging-path safety tests are implemented and run in the
portable suite.

windows-package.test.mjs checks default MSI/ZIP versus explicit MSIX selection, removed
flags, missing shared checkout, bundled-Node launcher failure and shared final metadata/
native failure propagation. Windows-only adapter cases use temporary files and never
create keys, change trust or install products.

msi.test.mjs verifies the single scope-choice package, Just me default, compatible
v1-to-v2 identities, stable surviving components and invalid/ambiguous input rejection.
