# Licensing

Copyright (C) 2026 kiforsbe

VidVNC is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License version 3 as published by the Free Software
Foundation (AGPL-3.0-only), with the additional permission below. The full license
text is in [LICENSE](LICENSE).

VidVNC is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See the GNU Affero General Public License for more details.

## Additional permission under GNU AGPL version 3 section 7

If you modify this Program, or any covered work, by linking or combining it with the
Microsoft Windows App SDK (including the Windows App Runtime and WinUI), the Microsoft
Edge WebView2 Runtime, the Microsoft Visual C++ Redistributable, Microsoft Media
Foundation, or graphics driver components from NVIDIA, Intel or AMD (including their
hardware video encoding runtimes, such as NVENC, Intel Quick Sync and AMD AMF), or a
modified version of any of those libraries, containing parts covered by the terms of
their respective licenses, the licensors of this Program grant you additional
permission to convey the resulting work.

## Third-party components

VidVNC uses third-party components under their own licenses, including GStreamer, GLib
and libnice (LGPL), OpenSSL (Apache-2.0), Opus, libsrtp and other libraries (BSD, MIT,
Zlib), Node.js and .NET (MIT), and Microsoft runtimes under Microsoft's terms. The
Windows and macOS packages list every included component in `notices/THIRD-PARTY-NOTICES.txt`
(in the Mac app, `Contents/Resources/notices`) together with its license texts. Nothing in VidVNC's license limits your rights under
the licenses of those components.

The [website](site/README.md) uses the Instrument Sans and JetBrains Mono fonts under the SIL
Open Font License 1.1; their license texts are next to them in `site/fonts/`.

All Windows and Mac products bundle Node.js 24.22.1. Its complete LICENSE, including
third-party terms, is retained in product notices; the top-level MIT label does not
replace those terms. Windows build-time tools are the MIT-licensed
[winbuildtools](external/winbuildtools/LICENSE) v0.5.0 submodule retains its MIT terms;
its scripts/platform
tools are not copied into application packages. Installed Windows/SDK/PowerShell
components retain their own terms. Development-only Biome WebAssembly (MIT OR Apache-2.0) and clang-format also
contain separately licensed code; see the
[formatter review](docs/security/formatter-remediation-2026-10-23.md). They are excluded
from all shipped payloads; their upstream licenses do not relicense embedded libraries.

## Commercial licensing

If the AGPL does not suit your use, for example because you want to distribute or host
a modified VidVNC without publishing its source, a commercial license may be available
from the copyright holder, kiforsbe.

## Contributions

To keep commercial licensing possible, pull requests are not accepted at this time.
Bug reports and suggestions are welcome as issues; see [CONTRIBUTING.md](CONTRIBUTING.md).
