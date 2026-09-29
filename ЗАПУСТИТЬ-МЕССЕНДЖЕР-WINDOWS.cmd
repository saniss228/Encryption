@echo off
chcp 65001 >nul
title Encryption - защищённый мессенджер
cd /d "%~dp0"
set PORT=%~1
if "%PORT%"=="" set PORT=6000
set SITEPORT=%~2
if "%SITEPORT%"=="" set SITEPORT=8080
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-encryption.ps1" -Port %PORT% -SitePort %SITEPORT%
if errorlevel 1 pause
