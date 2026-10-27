@echo off
rem Launches HF Item Studio. The first run downloads the Electron runtime (about 100 MB).
setlocal
cd /d "%~dp0app"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\three" (
  echo Installing dependencies...
  call npm install || goto :fail
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading the Electron runtime, this happens once...
  call npm run setup || goto :fail
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo.
echo Setup failed. See the messages above.
pause
exit /b 1
