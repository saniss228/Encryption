@echo off
title Encryption - messenger server
cd /d "%~dp0"
set PORT=%~1
if "%PORT%"=="" set PORT=6000
set SITEPORT=%~2
if "%SITEPORT%"=="" set SITEPORT=8080
where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell not found. Windows 10/11 includes it by default.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-encryption.ps1" -Port %PORT% -SitePort %SITEPORT%
if errorlevel 1 pause
