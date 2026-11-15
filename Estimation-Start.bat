@echo off
chcp 65001 >nul
title Trigon Estimation
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it now ^(one time only^)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. Close this window and double-click Estimation-Start.bat again.
  pause
  exit /b
)

rem reachable from the office network so the QS can open it; allow port 3100 on Private networks only ^(see README^)
set HOST=0.0.0.0
set PORT=3100

rem backup when the app starts (at most one copy per day); a failure is shown here and written to data\backups\backup-errors.log
node --no-warnings scripts\backup.js
if errorlevel 1 (
  echo WARNING: today's backup FAILED. See data\backups\backup-errors.log
  echo تحذير: فشل النسخ الاحتياطي اليوم. راجع الملف data\backups\backup-errors.log
)

start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3100"
echo Trigon Estimation is running at http://localhost:3100
echo The QS opens http://^<one of the addresses below^>:3100
ipconfig | findstr IPv4
echo Keep this window open while you work. Close it to stop the app.
:loop
node --no-warnings server.js
echo The app stopped. Restarting in 5 seconds... ^(close this window to quit^)
timeout /t 5 /nobreak >nul
goto loop
