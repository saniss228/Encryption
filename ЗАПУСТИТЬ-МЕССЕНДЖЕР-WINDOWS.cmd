@echo off
chcp 65001 >nul
title Encryption - защищённый мессенджер
cd /d "%~dp0"
set PORT=%~1
if "%PORT%"=="" set PORT=6000
set SITEPORT=%~2
if "%SITEPORT%"=="" set SITEPORT=8080
set LANIP=%~3
set LANARG=
if not "%LANIP%"=="" set LANARG=-LanIp %LANIP%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-encryption.ps1" -Port %PORT% -SitePort %SITEPORT% %LANARG%
if errorlevel 1 pause
