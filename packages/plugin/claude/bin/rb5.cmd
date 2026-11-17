@echo off
rem RuvNet Brain 5 launcher (Windows). The host runs it by its full path: rb5.cmd hook, rb5.cmd server or
rem rb5.cmd guard (the optional write guard: standard input and exit code pass through, 2 refuses).
rem Same rules as bin/rb5: Node only by full path, first the runtime recorded at install (checked again
rem now), then the first node.exe in an absolute PATH folder outside the current project; empty and
rem relative PATH entries and the current folder are never searched; with no usable Node, one DOWN line
rem and exit 0. Only cmd built-ins are used. UNVERIFIED: this file has not been run on Windows.
setlocal EnableExtensions DisableDelayedExpansion
set "NoDefaultCurrentDirectoryInExePath=1"
set "RB5_DOWN=[RuvNet Brain] DOWN: Node could not run. Search is unavailable. Fix: run 'node -v' in a terminal; reinstall Node if it fails."
set "RB5_MODE=%~1"
if not defined RB5_MODE set "RB5_MODE=hook"
if /i not "%RB5_MODE%"=="hook" if /i not "%RB5_MODE%"=="server" if /i not "%RB5_MODE%"=="guard" goto down
for %%I in ("%~dp0..") do set "RB5_PLUGIN=%%~fI"
for %%I in ("%~dp0..\..\..") do set "RB5_SHIM=%%~fI"
set "RB5_P1=%CD%"
set "RB5_P2=%CLAUDE_PROJECT_DIR%"

set "RB5_REC="
if exist "%RB5_SHIM%\node-runtime" if exist "%RB5_SHIM%\plugin\claude\bin\rb5.cmd" (
  set /p RB5_REC=<"%RB5_SHIM%\node-runtime"
  for %%I in ("%RB5_SHIM%\..") do set "RUVNET_BRAIN5_HOME=%%~fI"
)
if defined RB5_REC call :usable "%RB5_REC%" && call :run "%RB5_REC%" && exit /b 0

set "RB5_REST=%PATH%"
:next
if not defined RB5_REST goto down
rem An empty entry (a leading ;) is skipped here: for /f would read a leading ; as a comment.
if "%RB5_REST:~0,1%"==";" set "RB5_REST=%RB5_REST:~1%" & goto next
set "RB5_E="
for /f "tokens=1* delims=;" %%A in ("%RB5_REST%") do (
  set "RB5_E=%%~A"
  set "RB5_REST=%%B"
)
if not defined RB5_E goto down
if "%RB5_E:~-1%"=="\" set "RB5_E=%RB5_E:~0,-1%"
call :usable "%RB5_E%\node.exe" || goto next
if /i "%RB5_E%\node.exe"=="%RB5_REC%" goto down
call :run "%RB5_E%\node.exe" && exit /b 0
goto down

:down
if /i "%RB5_MODE%"=="server" (
  echo %RB5_DOWN% 1>&2
  exit /b 1
)
echo %RB5_DOWN%
exit /b 0

rem :usable FILE - a full path to a file (not a folder) outside the current project.
:usable
set "RB5_C=%~f1"
if not "%~1"=="%RB5_C%" exit /b 1
if not exist "%RB5_C%" exit /b 1
if exist "%RB5_C%\" exit /b 1
set "RB5_D=%~dp1"
call :within "%RB5_D%" "%RB5_P1%" && exit /b 1
call :within "%RB5_D%" "%RB5_P2%" && exit /b 1
exit /b 0

rem :within DIR PROJECT - DIR (ending in \) is PROJECT or below it. A project that holds the user's
rem profile or temporary folder counts only for itself.
:within
if "%~2"=="" exit /b 1
set "RB5_X=%~1"
set "RB5_Y=%~f2"
if not "%RB5_Y:~-1%"=="\" set "RB5_Y=%RB5_Y%\"
if /i "%RB5_X%"=="%RB5_Y%" exit /b 0
call :prefix "%USERPROFILE%\" "%RB5_Y%" && exit /b 1
call :prefix "%TEMP%\" "%RB5_Y%" && exit /b 1
call :prefix "%RB5_X%" "%RB5_Y%" && exit /b 0
exit /b 1

rem :prefix TEXT START - TEXT begins with START (case-insensitive).
:prefix
set "RB5_T=%~1"
set "RB5_S=%~2"
call set "RB5_R=%%RB5_T:*%RB5_S%=%%"
if /i "%RB5_S%%RB5_R%"=="%RB5_T%" exit /b 0
exit /b 1

rem :run NODE - returns only when that Node cannot run or is older than the minimum (exit 3).
:run
if /i "%RB5_MODE%"=="server" goto run_server
if /i "%RB5_MODE%"=="guard" goto run_guard
"%~1" "%RB5_PLUGIN%\health-line.mjs"
exit /b %ERRORLEVEL%
:run_guard
"%~1" "%RB5_PLUGIN%\runtime.mjs" <nul >nul 2>&1 || exit /b 1
rem Like exec: the guard's exit code (2 refuses the write) is this script's, and no other Node is tried.
"%~1" "%RB5_PLUGIN%\guard-hook.mjs"
exit %ERRORLEVEL%
:run_server
"%~1" "%RB5_PLUGIN%\runtime.mjs" <nul >nul 2>&1 || exit /b 1
rem Like exec: this cmd.exe ends with the server's exit code and never goes on to another Node.
"%~1" "%RB5_PLUGIN%\launch.mjs"
exit %ERRORLEVEL%
