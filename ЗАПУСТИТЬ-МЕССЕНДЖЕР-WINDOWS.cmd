@echo off
chcp 65001 >nul
title Encryption - запуск мессенджера
cd /d "%~dp0"
set PORT=%~1
if "%PORT%"=="" set PORT=8080
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-encryption.ps1" -Port %PORT%
if errorlevel 1 pause
