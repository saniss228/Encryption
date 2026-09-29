@echo off
chcp 65001 >nul
title Encryption - защищённый мессенджер
cd /d "%~dp0"
set PORT=%~1
if "%PORT%"=="" set PORT=3000
set LANIP=%~2
set LANARG=
if not "%LANIP%"=="" set LANARG=-LanIp %LANIP%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-encryption.ps1" -Port %PORT% %LANARG%
if errorlevel 1 pause
