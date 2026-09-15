@echo off
setlocal
set "BUILD_PRESET=windows-x64-release"
if not "%~2"=="" (
  echo Usage: build-native.cmd [Debug^|Release]
  exit /b 2
)
if /i "%~1"=="Debug" (
  set "BUILD_PRESET=windows-x64-debug"
) else if not "%~1"=="" if /i not "%~1"=="Release" (
  echo Usage: build-native.cmd [Debug^|Release]
  exit /b 2
)
cd /d "%~dp0"
node tools\format.mjs native
if errorlevel 1 exit /b 1
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
set "CMAKE=cmake"
set "CTEST=ctest"
if exist "%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" (
  set "CMAKE=%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  set "CTEST=%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe"
)
if exist "%~dp0.deps\cmake\bin\cmake.exe" (
  set "CMAKE=%~dp0.deps\cmake\bin\cmake.exe"
  set "CTEST=%~dp0.deps\cmake\bin\ctest.exe"
)
"%CMAKE%" --preset windows-x64
if errorlevel 1 exit /b 1
"%CMAKE%" --build --preset %BUILD_PRESET%
if errorlevel 1 exit /b 1
"%CTEST%" --preset %BUILD_PRESET%
exit /b %errorlevel%
