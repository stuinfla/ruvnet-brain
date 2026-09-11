@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo TriSmart Skill needs Node.js 18 or newer. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 2
)
set "HAS_PROJECT="
for %%A in (%*) do if /I "%%~A"=="--project" set "HAS_PROJECT=1"
for %%A in (%*) do echo %%~A | findstr /b /i "--project=" >nul && set "HAS_PROJECT=1"
if defined HAS_PROJECT (node "%~dp0install.mjs" %*) else (node "%~dp0install.mjs" %* --project="%USERPROFILE%")
if errorlevel 1 pause
endlocal
