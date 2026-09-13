@echo off
setlocal enabledelayedexpansion

REM  Head Unit OS - first-time setup for Windows.
REM
REM  Everything this repo tracks is already here; what is missing is the
REM  third-party apps, which live under vendor\ and are deliberately not in
REM  git so each stays on its own upstream. This fetches them.
REM
REM  It only ever clones into empty places and installs dependencies. It does
REM  not delete anything. Re-running it is safe.

echo.
echo   Head Unit OS - setup
echo   ====================
echo.

REM ---- Node ----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node is not installed, or is not on PATH.
  echo       Install the LTS build from https://nodejs.org then run this again.
  goto :fail
)
for /f "delims=" %%v in ('node --version') do set "NODEV=%%v"
set "NODENUM=!NODEV:v=!"
for /f "tokens=1 delims=." %%a in ("!NODENUM!") do set "NODEMAJOR=%%a"
echo   [ok] Node !NODEV!

if !NODEMAJOR! LSS 20 (
  echo   [!] The shell needs Node 20.11 or newer. Please update Node.
  goto :fail
)

REM ---- git -----------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo   [!] git is not installed, or is not on PATH.
  echo       Install it from https://git-scm.com then run this again.
  goto :fail
)
echo   [ok] git is present

REM ---- the two vendored apps -----------------------------------------
if not exist "vendor" mkdir "vendor"

if exist "vendor\gods-eye-view\package.json" (
  echo   [ok] God's Eye View is already here
) else (
  echo   [..] cloning God's Eye View, roughly 90 MB
  git clone --depth 1 https://github.com/bilawalsidhu/gods-eye-view "vendor\gods-eye-view"
  if errorlevel 1 goto :fail
)

if exist "vendor\norcal-bite-index\index.html" (
  echo   [ok] Bite Index is already here
) else (
  echo   [..] cloning the Bite Index
  git clone --depth 1 https://github.com/timporachin/norcal-bite-index "vendor\norcal-bite-index"
  if errorlevel 1 goto :fail
)

REM ---- God's Eye View's own dependencies ------------------------------
REM  npm.cmd, not npm: PowerShell's execution policy blocks npm.ps1 on a
REM  default Windows install, which is exactly what happened here before.
if exist "vendor\gods-eye-view\node_modules" (
  echo   [ok] God's Eye View dependencies are already installed
) else (
  if !NODEMAJOR! LSS 24 (
    echo   [!] God's Eye View wants Node 24.14+ or 26.x and this is !NODEV!.
    echo       Everything else will run. The globe may not build or start.
  )
  echo   [..] installing God's Eye View dependencies - a few minutes, roughly 280 MB
  pushd "vendor\gods-eye-view"
  call npm.cmd ci
  if errorlevel 1 (
    popd
    echo   [!] npm ci failed inside vendor\gods-eye-view.
    goto :fail
  )
  popd
)

echo.
echo   Ready.
echo.
echo     npm start                 then open  http://localhost:4100
echo.
echo   See RUNNING.md for kiosk mode and for what to try when something sticks.
echo.
endlocal
exit /b 0

:fail
echo.
echo   Setup stopped. Nothing was deleted - fix the above and run it again.
echo.
endlocal
exit /b 1
