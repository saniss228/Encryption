@echo off
title Encryption 3.1.0 - otpravka v GitHub
cd /d "%~dp0"
where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell not found. Windows 10/11 includes it by default.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-to-github.ps1" %*
echo.
pause
