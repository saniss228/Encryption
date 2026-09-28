# ============================================================================
#  Encryption — запуск мессенджера на Windows (сервер + сайт + API).
#
#  Что делает скрипт:
#    1. находит Python (или подсказывает, где установить);
#    2. первый раз создаёт окружение .venv и ставит зависимости сервера;
#    3. запускает сервер и открывает сайт в браузере;
#    4. показывает адрес для телефона в той же сети Wi-Fi.
#
#  Запуск:  START-ENCRYPTION-WINDOWS.cmd          (двойной клик, порт 8080)
#           START-ENCRYPTION-WINDOWS.cmd 9000     (свой порт)
#  Или напрямую из PowerShell:
#           powershell -ExecutionPolicy Bypass -File tools\start-encryption.ps1 -Port 8080
#
#  Остановка: Ctrl+C в окне либо просто закрыть окно.
#
#  Совместимо с PowerShell 5.1 (Windows 10/11) и PowerShell 7+.
# ============================================================================
[CmdletBinding()]
param(
    [int]    $Port     = 8080,              # порт сайта; 6000 браузеры блокируют (ERR_UNSAFE_PORT)
    [string] $BindHost = '0.0.0.0',         # 0.0.0.0 — доступно и с телефона в этой же сети
    [switch] $NoBrowser,                    # не открывать браузер
    [switch] $NoInstall,                    # не проверять/ставить зависимости
    [switch] $Reinstall                     # пересоздать окружение .venv
)

$ErrorActionPreference = 'Stop'
function Say([string] $m) { Write-Host $m }
function Ok([string] $m)  { Write-Host $m -ForegroundColor Green }
function Warn([string] $m){ Write-Host $m -ForegroundColor Yellow }
function Bad([string] $m) { Write-Host $m -ForegroundColor Red }

# ── Запуск внешних программ ────────────────────────────────────────────────
# В PowerShell 5.1 любая запись внешней программы в stderr превращается в
# исключение (NativeCommandError), а кавычки внутри аргументов съедаются.
# Поэтому: (1) никакого кода с кавычками в аргументах, (2) запускаем через
# этот помощник, который глушит такое поведение и отдаёт код возврата.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]   $File,
        [Parameter(Mandatory)][string[]] $Arguments
    )
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = $null
    $code = -1
    try {
        $out  = & $File @Arguments 2>&1
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    } catch {
        $out  = @($_.Exception.Message)
        $code = -1
    } finally {
        $ErrorActionPreference = $saved
    }
    $text = (($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) | ForEach-Object { "$_" }) -join "`n"
    [pscustomobject]@{ Text = "$text".Trim(); Code = [int]$code; Lines = @($out) }
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # корень проекта
Set-Location $Root
# Windows ($IsWindows пусто в PowerShell 5.1 — считаем, что это Windows) или Linux/macOS
$IsWin     = if ($null -eq (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) { $true } else { $IsWindows }
$Venv      = Join-Path $Root '.venv'
$VenvPy    = if ($IsWin) { Join-Path $Venv 'Scripts\python.exe' } else { Join-Path $Venv 'bin/python' }
$Req       = Join-Path $Root 'server\requirements.txt'
$DataDir   = Join-Path $Root 'data'
$WebDir    = Join-Path $Root 'web'

Say '══════════════════════════════════════════════════════════════════════'
Say '  ENCRYPTION — запуск мессенджера (сервер + сайт)'
Say "  Каталог проекта: $Root"
Say '══════════════════════════════════════════════════════════════════════'
Say ''

# ── 1. Проверяем, что скрипт лежит в проекте ────────────────────────────────
foreach ($need in @('server\app.py', 'web\index.html')) {
    if (-not (Test-Path (Join-Path $Root $need))) {
        Bad "✗ Не найден файл $need."
        Bad '  Распакуйте архив целиком и запускайте скрипт из его корня (папка tools).'
        Read-Host 'Нажмите Enter, чтобы закрыть'
        exit 2
    }
}

# ── 2. Ищем Python ─────────────────────────────────────────────────────────
function Get-PyLauncher {
    foreach ($cand in @('py', 'python', 'python3')) {
        $cmd = Get-Command $cand -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $extra = @()
        if ($cand -eq 'py') { $extra = @('-3') }
        $r = Invoke-Native $cand ($extra + @('-c', 'import sys;print(sys.executable)'))
        if ($r.Code -eq 0) {
            $exe = ($r.Text -split "`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
            if ($exe) { $exe = $exe.Trim() }
            if ($exe -and (Test-Path $exe)) {
                return @{ Cmd = $cand; Args = $extra; Exe = $exe }
            }
        }
    }
    return $null
}

$py = Get-PyLauncher
if (-not $py) {
    Bad '✗ Python не найден.'
    Say ''
    Say '  Установите Python 3.10 или новее:'
    Say '    • откройте https://www.python.org/downloads/windows/'
    Say '    • при установке ОБЯЗАТЕЛЬНО поставьте галочку «Add python.exe to PATH»'
    Say '    • затем запустите этот файл снова'
    Say ''
    Say '  Открываю страницу загрузки Python…'
    try { Start-Process 'https://www.python.org/downloads/windows/' } catch { }
    Read-Host 'Нажмите Enter, чтобы закрыть'
    exit 3
}

# Версия: спрашиваем у самого Python («Python 3.12.4») — без хитрых кавычек
$rVer  = Invoke-Native $py.Cmd ($py.Args + @('--version'))
$major = 0; $minor = 0
if ($rVer.Text -match '(\d+)\.(\d+)') { $major = [int]$Matches[1]; $minor = [int]$Matches[2] }
$ver  = if ($major) { "$major.$minor" } else { 'неизвестно' }
$okPy = ($major -gt 3) -or (($major -eq 3) -and ($minor -ge 10))
Say "→ Python: $ver  ($($py.Exe))"
if (-not $okPy) {
    Bad "✗ Нужен Python 3.10 или новее (найден $ver)."
    Say '  Скачайте новую версию: https://www.python.org/downloads/windows/'
    Read-Host 'Нажмите Enter, чтобы закрыть'
    exit 3
}

# ── 3. Окружение .venv и зависимости ───────────────────────────────────────
if ($Reinstall -and (Test-Path $Venv)) {
    Say '→ Пересоздаю окружение .venv…'
    Remove-Item -Recurse -Force $Venv
}

if (-not (Test-Path $VenvPy)) {
    Say '→ Первый запуск: создаю окружение .venv (это одна минута)…'
    $r = Invoke-Native $py.Cmd ($py.Args + @('-m', 'venv', $Venv))
    if ((-not (Test-Path $VenvPy)) -or ($r.Code -ne 0)) {
        Bad '✗ Не удалось создать .venv.'
        if ($r.Text) { Say "  $($r.Text)" }
        Read-Host 'Нажмите Enter, чтобы закрыть'
        exit 4
    }
}

$needDeps = @('-c', 'import fastapi,uvicorn,aiosqlite,argon2,cryptography')
if (-not $NoInstall) {
    $check = Invoke-Native $VenvPy $needDeps
    if ($check.Code -ne 0) {
        Say '→ Устанавливаю зависимости сервера (один раз)…'
        $null = Invoke-Native $VenvPy @('-m', 'pip', 'install', '--upgrade', 'pip', '--quiet', '--disable-pip-version-check')
        $r = Invoke-Native $VenvPy @('-m', 'pip', 'install', '-r', $Req, '--quiet', '--disable-pip-version-check')
        $check = Invoke-Native $VenvPy $needDeps
        if ($check.Code -ne 0) {
            Bad '✗ Не удалось установить зависимости. Проверьте интернет и запустите снова.'
            if ($r.Text) { Say "  $($r.Text)" }
            Say '  Вручную: .venv\Scripts\python.exe -m pip install -r server\requirements.txt'
            Read-Host 'Нажмите Enter, чтобы закрыть'
            exit 4
        }
    } else {
        Say '→ Зависимости уже установлены.'
    }
}

# ── 4. Переменные окружения сервера ────────────────────────────────────────
$env:ENC_HOST        = $BindHost
$env:ENC_PORT        = "$Port"
$env:ENC_DATA_DIR    = $DataDir
$env:ENC_WEB_DIR     = $WebDir
$env:ENC_PUBLIC_IP   = '127.0.0.1'
$env:ENC_ADMINS      = if ($env:ENC_ADMINS) { $env:ENC_ADMINS } else { 'saniss' }   # админ-панель
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

if ($Port -eq 6000) {
    Warn '⚠ Порт 6000 браузеры блокируют (ERR_UNSAFE_PORT). Оставьте 8080 или укажите другой.'
}

# ── 5. Проверяем, что порт свободен ────────────────────────────────────────
$busy = $null
try { $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { $busy = $null }
if (-not $busy -and -not $IsWin) {
    # Linux/macOS: проверяем порт через ss либо lsof
    try {
        if (Get-Command ss -ErrorAction SilentlyContinue) {
            $busy = (ss -ltn 2>$null | Select-String ":$Port\s")
        } elseif (Get-Command lsof -ErrorAction SilentlyContinue) {
            $busy = (lsof -iTCP:$Port -sTCP:LISTEN 2>$null)
        }
    } catch { $busy = $null }
}
if ($busy) {
    Bad "✗ Порт $Port уже занят (возможно, мессенджер уже запущен)."
    Say "  Откройте http://127.0.0.1:$Port/ — или запустите скрипт с другим портом:"
    Say "     START-ENCRYPTION-WINDOWS.cmd 8090"
    Read-Host 'Нажмите Enter, чтобы закрыть'
    exit 5
}

# ── 6. Локальный и сетевой адреса ──────────────────────────────────────────
$lanIp = $null
try {
    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
              Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
                             $_.PrefixOrigin -ne 'WellKnown' } |
              Select-Object -First 1).IPAddress
} catch { }

Say ''
Ok  '✓ Сервер запускается:'
Say "    на этом компьютере:  http://127.0.0.1:$Port/"
if ($lanIp) { Say "    с телефона (та же сеть Wi-Fi): http://${lanIp}:$Port/" }
Say "    данные и файлы:      $DataDir"
Say "    администратор:       $env:ENC_ADMINS  (раздел «Админ-панель» в настройках)"
Say ''
Say '  Остановка сервера — Ctrl+C в этом окне.'
if ($lanIp) {
    Say '  Windows может спросить про доступ в сеть — разрешите для частных сетей,'
    Say '  иначе телефон не подключится.'
}
Say '══════════════════════════════════════════════════════════════════════'
Say ''

# ── 7. Ждём готовности сервера и открываем браузер ─────────────────────────
$url = "http://127.0.0.1:$Port/"
$job = Start-Job -ScriptBlock {
    param($py, $root)
    Set-Location $root
    & $py '-m' 'server.app'
} -ArgumentList $VenvPy, $Root

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/v1/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    if ($job.State -eq 'Failed' -or $job.State -eq 'Completed') { break }
}

if (-not $ready) {
    Bad '✗ Сервер не запустился. Вывод:'
    Receive-Job $job | ForEach-Object { Say "    $_" }
    Remove-Job $job -Force
    Read-Host 'Нажмите Enter, чтобы закрыть'
    exit 6
}

Ok '✓ Сервер работает.'
if (-not $NoBrowser) {
    Say "→ Открываю $url"
    try { Start-Process $url } catch { }
}
Say ''
Say 'Это окно можно свернуть — мессенджер работает, пока оно открыто.'
Say ''

# Показываем вывод сервера «в живую» и ждём Ctrl+C
try {
    while ($true) {
        Receive-Job $job | ForEach-Object { Write-Host $_ }
        if ($job.State -eq 'Completed' -or $job.State -eq 'Failed') { break }
        Start-Sleep -Milliseconds 700
    }
} finally {
    Say ''
    Say 'Останавливаю сервер…'
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Ok '✓ Сервер остановлен.'
}
