# Native Windows viewer

Status: ownership scaffold only; no runnable WinUI project yet.

Own the WinUI 3 viewer, decoding/playback integration and client-side remote input
here. Keep MSBuild/Visual Studio project files and app-owned tests in this module.
The viewer-only installer includes its runtime dependencies, not server/capture code.

Provide Visual Studio Debug/F5 launch when the project is implemented. Native decoder
symbols and mixed managed/native debugging must be supported where applicable.
