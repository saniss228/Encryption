# ============================================================================
#  Encryption — запуск мессенджера на Windows (сервер + сайт + API).
#
#  Что делает скрипт:
#    1. находит Python (или подсказывает, где установить);
#    2. первый раз создаёт окружение .venv и ставит зависимости сервера;
#    3. запускает сервер и открывает сайт в браузере;
#    4. показывает адрес для телефона в той же сети Wi-Fi.
#
#  Запуск:  START-ENCRYPTION-WINDOWS.cmd          (двойной клик)
#           START-ENCRYPTION-WINDOWS.cmd 6000     (основной порт; 2-й аргумент — порт для браузера)
#  Или напрямую из PowerShell:
#           powershell -ExecutionPolicy Bypass -File tools\start-encryption.ps1
#
#  Порты: 6000 — приложения (ПК и Android) и API (как на сервере проекта);
#         8080 — сайт в браузере на этом компьютере, потому что порт 6000
#         Chrome/Edge блокируют как «небезопасный» (ERR_UNSAFE_PORT).
#         Оба порта обслуживает один и тот же процесс — данные общие.
#
#  Остановка: Ctrl+C в окне либо просто закрыть окно.
#
#  Совместимо с PowerShell 5.1 (Windows 10/11) и PowerShell 7+.
# ============================================================================
[CmdletBinding()]
param(
    [int]    $Port     = 6000,              # основной порт: приложения и API
    [int]    $SitePort = 8080,              # порт для браузера (6000 браузеры блокируют)
    [string] $BindHost = '0.0.0.0',         # 0.0.0.0 — доступно и с телефона в этой же сети
    [string] $LanIp    = '',                # адрес для телефона вручную, если автоопределение ошиблось
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
if ($SitePort -and $SitePort -ne $Port) { $env:ENC_ALT_PORTS = "$SitePort" } else { $env:ENC_ALT_PORTS = '' }
$env:ENC_DATA_DIR    = $DataDir
$env:ENC_WEB_DIR     = $WebDir
$env:ENC_PUBLIC_IP   = '127.0.0.1'
$env:ENC_ADMINS      = if ($env:ENC_ADMINS) { $env:ENC_ADMINS } else { 'saness' }   # админ-панель
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

$hasSite = [bool]($SitePort -and $SitePort -ne $Port)
if (-not $hasSite) {
    Warn '⚠ Один порт и для приложений, и для браузера. Если это 6000 — сайт на этом компьютере в браузере не откроется.'
}

# ── 5. Проверяем, что порты свободны ───────────────────────────────────────
function Test-PortBusy([int] $p) {
    $busy = $null
    try { $busy = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop } catch { $busy = $null }
    if (-not $busy -and -not $IsWin) {
        # Linux/macOS: проверяем порт через ss либо lsof
        try {
            if (Get-Command ss -ErrorAction SilentlyContinue) {
                $busy = (ss -ltn 2>$null | Select-String ":$p\s")
            } elseif (Get-Command lsof -ErrorAction SilentlyContinue) {
                $busy = (lsof -iTCP:$p -sTCP:LISTEN 2>$null)
            }
        } catch { $busy = $null }
    }
    return [bool]$busy
}
$portsToCheck = @($Port)
if ($hasSite) { $portsToCheck += $SitePort }
foreach ($p in $portsToCheck) {
    if (Test-PortBusy $p) {
        Bad "✗ Порт $p уже занят (возможно, мессенджер уже запущен)."
        Say "  Откройте http://127.0.0.1:$SitePort/ — или запустите с другими портами:"
        Say "     START-ENCRYPTION-WINDOWS.cmd 6000 8080"
        Read-Host 'Нажмите Enter, чтобы закрыть'
        exit 5
    }
}

# ── 6. Локальный и сетевой адреса ──────────────────────────────────────────
# Адрес для телефона: только настоящий Wi-Fi/Ethernet, без VPN и «хот-спота»
# Windows (192.168.137.1) — правила поиска и оценка адаптеров в tools/lan-ip.ps1,
# их проверяет тест tools/tests/test_lan_ip.ps1. Свой адрес задаётся ключом
# -LanIp 192.168.1.50, если автоопределение на этом компьютере ошибается.
$lanModule = Join-Path $PSScriptRoot 'lan-ip.ps1'
if (Test-Path $lanModule) {
    . $lanModule
} else {
    Warn '⚠ Не найден tools\lan-ip.ps1 — определяю адрес упрощённо.'
    Warn '  Обновите файлы запуска целиком: распакуйте архив заново или скачайте'
    Warn '  tools\lan-ip.ps1 рядом с tools\start-encryption.ps1.'
}
if (-not (Get-Command Get-LanCandidates -ErrorAction SilentlyContinue)) {
    function Get-LanCandidates {
        $list = @()
        try {
            foreach ($addr in [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())) {
                if ($addr.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
                $ip = $addr.IPAddressToString
                if (-not $ip) { continue }
                if ($ip -like '127.*' -or $ip -like '169.254.*') { continue }
                $score = 30
                if ($ip -like '192.168.137.*') { $score += 50 }
                $list += [pscustomobject]@{ Ip = $ip; Label = 'системный адрес'; Score = $score }
            }
        } catch { }
        return @($list)
    }
}
if (-not (Get-Command Get-BestLan -ErrorAction SilentlyContinue)) {
    function Get-BestLan {
        param([AllowEmptyCollection()][array] $Candidates = @())
        $r = [pscustomobject]@{ Ip = $null; Label = ''; Others = @() }
        if (-not $Candidates -or $Candidates.Count -eq 0) { return $r }
        $s = @($Candidates | Sort-Object -Property Score, Ip)
        $r.Ip = [string]$s[0].Ip
        $r.Label = [string]$s[0].Label
        if ($s.Count -gt 1) { $r.Others = @($s[1..($s.Count - 1)]) }
        return $r
    }
}

if ($LanIp) {
    $lan = [pscustomobject]@{ Ip = $LanIp; Label = 'указан вручную (-LanIp)'; Others = @() }
} else {
    $lanCandidates = @(Get-LanCandidates)
    $lan = Get-BestLan -Candidates $lanCandidates
}
$lanIp     = $lan.Ip
$lanLabel  = $lan.Label
$lanOthers = @($lan.Others)

Say ''
Ok  '✓ Сервер запускается.'
Say "    сайт на этом компьютере:   http://127.0.0.1:$SitePort/"
if ($lanIp) { Say "    сайт с телефона (Wi-Fi):   http://${lanIp}:$SitePort/" }
if ($hasSite) { Say "    порт приложений и API:     $Port" }
if ($lanIp) { Say "    адрес для приложения:      http://${lanIp}:$Port" }
Say "    данные и файлы:            $DataDir"
Say "    администратор:             $env:ENC_ADMINS  (раздел «Админ-панель» в настройках)"
if ($lanIp -and $lanLabel) { Say "    сетевой адаптер:           $lanLabel" }
if ($lanOthers.Count -gt 0) {
    Say '    другие адреса этого компьютера — если телефон не подключается,'
    Say '    попробуйте один из них (VPN и хот-спот для телефона не подходят):'
    foreach ($o in $lanOthers) { Say "        $($o.Ip)  — $($o.Label)" }
}
Say ''
Say '  Остановка сервера — Ctrl+C в этом окне.'
if ($lanIp) {
    Say '  Windows может спросить про доступ в сеть — разрешите для частных сетей,'
    Say '  иначе телефон не подключится.'
}
if ($lanOthers.Count -gt 0) {
    Say '  Свой адрес можно указать вручную:'
    Say '      START-ENCRYPTION-WINDOWS.cmd 6000 8080 192.168.1.50'
}
Say '══════════════════════════════════════════════════════════════════════'
Say ''

# ── 7. Запускаем сервер и открываем браузер ────────────────────────────────
$url    = "http://127.0.0.1:$SitePort/"
$logOut = Join-Path $DataDir 'server.log'
$logErr = Join-Path $DataDir 'server-error.log'
Remove-Item $logOut, $logErr -Force -ErrorAction SilentlyContinue

# Сервер запускается ОТДЕЛЬНЫМ процессом, а весь его вывод пишется в файлы.
# Раньше сервер запускался заданием PowerShell (Start-Job), и в PowerShell 5.1
# каждая строка журнала («INFO: Started server process…») превращалась в
# NativeCommandError — скрипт падал и останавливал сервер сразу после старта.
# Теперь ошибка невозможна: в консоль попадает только прочитанный текст.
try {
    $spArgs = @{
        FilePath               = $VenvPy
        ArgumentList           = @('-m', 'server.app')
        WorkingDirectory       = $Root
        PassThru               = $true
        RedirectStandardOutput = $logOut
        RedirectStandardError  = $logErr
    }
    if ($IsWin) { $spArgs['NoNewWindow'] = $true }   # на Windows — без второго окна
    $proc = Start-Process @spArgs
} catch {
    Bad "✗ Не удалось запустить сервер: $($_.Exception.Message)"
    Read-Host 'Нажмите Enter, чтобы закрыть'
    exit 6
}

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/v1/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}

$siteOk = $true
if ($ready -and $hasSite) {
    # Порт для браузера поднимается тем же процессом — даём ему пару секунд
    $siteOk = $false
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $rS = Invoke-WebRequest "http://127.0.0.1:$SitePort/api/v1/health" -UseBasicParsing -TimeoutSec 2
            if ($rS.StatusCode -eq 200) { $siteOk = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $siteOk) { Warn "⚠ Порт для браузера $SitePort не ответил — откройте сайт по адресу приложения." }
}

if (-not $ready) {
    Bad '✗ Сервер не запустился. Последние строки журнала:'
    foreach ($f in @($logErr, $logOut)) {
        if (Test-Path $f) { Get-Content $f -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" } }
    }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Read-Host 'Нажмите Enter, чтобы закрыть'
    exit 6
}

Ok '✓ Сервер работает.'
if (-not $NoBrowser -and $siteOk) {
    Say "→ Открываю $url"
    try { Start-Process $url } catch { }
}
Say ''
Say "  Журнал сервера: $logErr"
Say '  Это окно можно свернуть — мессенджер работает, пока оно открыто.'
Say ''

# Показываем новые строки журнала по мере появления и ждём закрытия сервера
$posMap = @{}
foreach ($f in @($logErr, $logOut)) { $posMap[$f] = 0 }
try {
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 600
        foreach ($f in @($logErr, $logOut)) {
            if (-not (Test-Path $f)) { continue }
            $txt = $null
            try { $txt = [System.IO.File]::ReadAllText($f) } catch { continue }
            if (-not $txt) { continue }
            $seen = [int]$posMap[$f]
            if ($txt.Length -gt $seen) {
                Write-Host $txt.Substring($seen)
                $posMap[$f] = $txt.Length
            }
        }
    }
    Warn '⚠ Сервер завершился. Последние строки журнала:'
    if (Test-Path $logErr) { Get-Content $logErr -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" } }
    Read-Host 'Нажмите Enter, чтобы закрыть'
} finally {
    if ($proc -and -not $proc.HasExited) {
        Say ''
        Say 'Останавливаю сервер…'
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
        Ok '✓ Сервер остановлен.'
    }
}
