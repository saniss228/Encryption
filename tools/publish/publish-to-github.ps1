# ENCRYPTION 3.1.0 -> GitHub  (Windows / PowerShell)
#
# Отправляет версию 3.1.0 в репозиторий saniss228/Encryption.
#   1) если есть git — заливает готовую историю из бандла (одним коммитом);
#   2) если git нет — загружает файлы через GitHub API (нужен только PowerShell).
#
# Запуск:  правый клик по отправить-на-github.ps1 -> «Выполнить с помощью PowerShell»
#          либо двойной клик по ЗАПУСТИТЬ-WINDOWS.cmd
# Токен:   скрипт спросит его (ввод скрыт), либо передайте -Token или переменную GITHUB_TOKEN.
# Токен нигде не сохраняется.
#
# Примеры:
#   .\publish-to-github.ps1
#   .\publish-to-github.ps1 -Token ghp_xxx
#   .\publish-to-github.ps1 -ApiOnly            # только через API, без git
#   .\publish-to-github.ps1 -Tag v3.1.1 -Branch main

[CmdletBinding()]
param(
    [string] $Token   = $env:GITHUB_TOKEN,
    [string] $Repo    = 'saniss228/Encryption',
    [string] $Branch  = 'main',
    [string] $Tag     = 'v3.1.0',
    [string] $GitUrl  = '',
    [string] $ApiBase = '',
    [switch] $ApiOnly,
    [switch] $GitOnly,
    [switch] $Release
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
function Pick-Path([string[]] $candidates) {
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    return $candidates[0]
}
$Bundle = Pick-Path @(
    (Join-Path $Root 'encryption-3.1.0-github.bundle'),
    (Join-Path $Root '..\encryption-3.1.0-github.bundle'),
    (Join-Path $Root '..\release\encryption-3.1.0-github.bundle'),
    (Join-Path $Root '..\..\release\encryption-3.1.0-github.bundle'))
$Files = Pick-Path @(
    (Join-Path $Root 'files'),
    (Join-Path $Root '..\files'),
    (Join-Path $Root '..\..\files'))
if (-not $GitUrl)  { $GitUrl = "https://github.com/$Repo.git" }
if (-not $ApiBase) { $ApiBase = if ($env:GH_API_BASE) { $env:GH_API_BASE } else { 'https://api.github.com' } }
$ApiBase = $ApiBase.TrimEnd('/')

$CommitSubject = 'Encryption 3.1.0 — третья версия мессенджера'
$CommitBody = @'
Что внутри:
- сервер FastAPI: REST API + WebSocket + раздача сайта (server/)
- сайт-клиент, общий с приложениями ПК и Android (web/)
- оболочка для Windows (desktop/) и Android (android/) + скрипты сборки (tools/)
- документация: docs/API.md (REST + WebSocket, примеры curl), SECURITY, DEPLOY, RECOVERY, FEATURES
- сборка релиза одной командой: bash tools/build_release.sh
- тесты: bash tools/run_tests.sh (крипто, API, «только локально», админ-панель, интерфейс)

Шифрование: каждое сообщение шифруется дважды (AES-256-GCM + RSA-4096-OAEP),
плюс ECDH P-256 для forward secrecy и подпись ECDSA. Сервер видит только шифротекст.

Клиенты: сайт (запускается вместе с сервером), приложение для ПК, приложение для Android.
Файлы живут ровно 24 часа и удаляются с сервера сразу после скачивания получателем
(метка «Только локально / Local only»). Интерфейс переведён на 4 языка.

Админ-панель (аккаунт saniss): обзор сервера, блокировки, группы, файлы, журнал,
рассылка объявлений, настройки. Переписку администратор прочитать не может.
'@
$CommitMessage = $CommitSubject + "`n`n" + $CommitBody
$TagMessage = 'Encryption 3.1.0 — третья версия: API + документация, «только локально», 4 языка, админ-панель saniss'

function Say([string] $m) { Write-Host $m }
function Hr { Write-Host ('=' * 70) }

function Ask-Token {
    Say ''
    Say 'Нужен токен GitHub с правом записи в репозиторий:'
    Say '  GitHub -> Settings -> Developer settings -> Personal access tokens ->'
    Say "  Fine-grained tokens -> доступ к $Repo -> Contents: Read and write"
    Say ''
    Say 'Если git уже хранит вход в GitHub (GitHub Desktop, менеджер учётных данных),'
    Say 'можно просто нажать Enter — отправим через git без токена.'
    $sec = Read-Host 'Токен (ввод скрыт)'
    if ($sec) { return $sec.Trim() } else { return '' }
}

function Invoke-GitHub {
    param([string] $Method, [string] $Path, $Body = $null, [int] $Retries = 3)
    $uri = if ($Path -like 'http*') { $Path } else { $ApiBase + $Path }
    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'encryption-publish/1.0'
    }
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            if ($null -ne $Body) {
                $json  = $Body | ConvertTo-Json -Depth 8 -Compress
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers `
                                         -Body $bytes -ContentType 'application/json; charset=utf-8'
            }
            return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
        } catch {
            $resp = $_.Exception.Response
            $code = 0
            if ($resp) { try { $code = [int] $resp.StatusCode } catch { $code = 0 } }
            if (($code -in 429, 500, 502, 503) -and $i -lt $Retries) { Start-Sleep -Seconds (2 * $i); continue }
            $msg = $_.Exception.Message
            if ($resp) {
                try {
                    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
                    $txt = $sr.ReadToEnd()
                    $obj = $txt | ConvertFrom-Json
                    if ($obj.message) { $msg = $obj.message }
                } catch { }
            }
            throw "HTTP $code — $msg"
        }
    }
}

function Get-BlobSha([byte[]] $bytes) {
    $header = [System.Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
    $all = New-Object byte[] ($header.Length + $bytes.Length)
    [Array]::Copy($header, 0, $all, 0, $header.Length)
    [Array]::Copy($bytes, 0, $all, $header.Length, $bytes.Length)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $hash = $sha.ComputeHash($all)
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Try-PushWithGit {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git)     { Say '  • git не найден — этот способ пропускаю'; return $false }
    if (-not (Test-Path $Bundle)) { Say '  • не найден бандл encryption-3.1.0-github.bundle — этот способ пропускаю'; return $false }
    Say ''
    Say '① Отправляю через git (готовая история из бандла)'
    Say "   бандл: $Bundle"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('enc-publish-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        & git clone -q $Bundle $tmp 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Say '  • не удалось развернуть бандл'; return $false }
        & git -C $tmp checkout -q github-main 2>&1 | Out-Null
        & git -C $tmp remote set-url origin $GitUrl 2>&1 | Out-Null
        $pushUrl = if ($Token) { $GitUrl -replace 'https://', "https://x-access-token:$Token@" } else { $GitUrl }
        $env:GIT_TERMINAL_PROMPT = '0'
        $out = & git -C $tmp push $pushUrl "github-main:$Branch" --tags 2>&1
        $rc = $LASTEXITCODE
        if ($rc -eq 0) {
            Say '  ✓ история отправлена'
            Say ''
            ($out | Select-Object -Last 4) | ForEach-Object { Say ('    ' + $_) }
            return $true
        }
        Say '  • через git не получилось:'
        ($out | Select-Object -Last 4) | ForEach-Object { Say ('    ' + $_) }
        return $false
    } catch {
        Say ('  • через git не получилось: ' + $_.Exception.Message)
        return $false
    } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}

function Send-ViaApi {
    Say ''
    Say '② Отправляю файлы через GitHub API (git не нужен)…'

    $me = Invoke-GitHub -Method GET -Path '/user'
    Say "→ Токен принят: $($me.login)"

    $info = Invoke-GitHub -Method GET -Path "/repos/$Repo"
    Say "→ Репозиторий: $($info.full_name) (ветка по умолчанию: $($info.default_branch))"
    if ($info.permissions -and ($info.permissions.push -eq $false)) {
        throw 'У токена нет права на запись в этот репозиторий (Contents: Read and write).'
    }
    if (-not $Branch) { $Branch = $info.default_branch }

    $parent = $null; $baseTree = $null
    try {
        $ref = Invoke-GitHub -Method GET -Path "/repos/$Repo/git/ref/heads/$Branch"
        $parent = $ref.object.sha
        $pc = Invoke-GitHub -Method GET -Path "/repos/$Repo/git/commits/$parent"
        $baseTree = $pc.tree.sha
        Say "→ Текущая вершина ${Branch}: $($parent.Substring(0,7))"
    } catch {
        Say "→ Ветка $Branch пустая — создаём первую версию"
    }

    $existing = @{}
    if ($baseTree) {
        try {
            $tr = Invoke-GitHub -Method GET -Path "/repos/$Repo/git/trees/$baseTree`?recursive=1"
            foreach ($e in $tr.tree) { if ($e.type -eq 'blob') { $existing[$e.path] = $e.sha } }
        } catch { }
    }

    if (-not (Test-Path $Files)) { throw "Нет каталога с файлами: $Files" }
    $local = Get-ChildItem -Path $Files -Recurse -File -Force | Sort-Object FullName
    Say "→ Файлов к отправке: $($local.Count)"

    $entries  = New-Object System.Collections.ArrayList
    $uploaded = 0; $skipped = 0
    foreach ($f in $local) {
        $rel  = $f.FullName.Substring($Files.Length + 1).Replace('\', '/')
        $data = [System.IO.File]::ReadAllBytes($f.FullName)
        $sha  = Get-BlobSha $data
        if ($existing.ContainsKey($rel) -and $existing[$rel] -eq $sha) { $skipped++; continue }
        $blob = Invoke-GitHub -Method POST -Path "/repos/$Repo/git/blobs" -Body @{
            content  = [Convert]::ToBase64String($data)
            encoding = 'base64'
        }
        $mode = if ($rel.EndsWith('.sh')) { '100755' } else { '100644' }
        [void] $entries.Add(@{ path = $rel; mode = $mode; type = 'blob'; sha = $blob.sha })
        $uploaded++
        if ($uploaded % 10 -eq 1) { Say "   … $uploaded из $($local.Count) файлов" }
    }

    $removed = 0
    foreach ($path in $existing.Keys) {
        $localPath = Join-Path $Files ($path.Replace('/', '\'))
        if (-not (Test-Path $localPath)) {
            [void] $entries.Add(@{ path = $path; mode = '100644'; type = 'blob'; sha = $null })
            $removed++
        }
    }
    Say "→ Отправлено файлов: $uploaded, без изменений: $skipped, удалено: $removed"

    $treeBody = @{ tree = @($entries) }
    if ($baseTree) { $treeBody['base_tree'] = $baseTree }
    $tree = Invoke-GitHub -Method POST -Path "/repos/$Repo/git/trees" -Body $treeBody

    $commitBody = @{ message = $CommitMessage; tree = $tree.sha }
    if ($parent) { $commitBody['parents'] = @($parent) }
    $commit = Invoke-GitHub -Method POST -Path "/repos/$Repo/git/commits" -Body $commitBody
    $commitSha = $commit.sha

    if ($parent) {
        [void] (Invoke-GitHub -Method PATCH -Path "/repos/$Repo/git/refs/heads/$Branch" -Body @{ sha = $commitSha; force = $false })
    } else {
        [void] (Invoke-GitHub -Method POST -Path "/repos/$Repo/git/refs" -Body @{ ref = "refs/heads/$Branch"; sha = $commitSha })
    }
    $short = if ($parent) { $parent.Substring(0,7) + '..' + $commitSha.Substring(0,7) } else { $commitSha.Substring(0,7) }
    Say "✓ Ветка $Branch обновлена: $short"

    try {
        $null = Invoke-GitHub -Method GET -Path "/repos/$Repo/git/ref/tags/$Tag"
        Say "• Тег $Tag уже существует — оставляю как есть"
    } catch {
        $tagObj = Invoke-GitHub -Method POST -Path "/repos/$Repo/git/tags" -Body @{
            tag     = $Tag
            message = $TagMessage
            object  = $commitSha
            type    = 'commit'
            tagger  = @{ name = 'Encryption'; email = 'dev@encryption.local' }
        }
        [void] (Invoke-GitHub -Method POST -Path "/repos/$Repo/git/refs" -Body @{ ref = "refs/tags/$Tag"; sha = $tagObj.sha })
        Say "✓ Тег $Tag создан"
    }

    if ($Release) {
        try {
            $rel = Invoke-GitHub -Method POST -Path "/repos/$Repo/releases" -Body @{
                tag_name = $Tag; name = 'Encryption 3.1.0'; body = $CommitBody
                draft = $false; prerelease = $false
            }
            Say "✓ Релиз создан: $($rel.html_url)"
        } catch {
            Say ('• Релиз не создан: ' + $_.Exception.Message)
        }
    }

    Say ''
    Hr
    Say " ГОТОВО. Проверить: https://github.com/$Repo/tree/$Branch"
    Say " Коммит: https://github.com/$Repo/commit/$commitSha"
    Hr
}

# ── Запуск ─────────────────────────────────────────────────────────────────
Hr
Say ' ОТПРАВКА ENCRYPTION 3.1.0 В GITHUB'
Say " Репозиторий: https://github.com/$Repo   ветка: $Branch   тег: $Tag"
Hr

if (-not $Token) { $Token = Ask-Token }

if (-not $ApiOnly) {
    $ok = Try-PushWithGit
    if ($ok) {
        Hr
        Say " ГОТОВО. Откройте: https://github.com/$Repo"
        Hr
        exit 0
    }
    if ($GitOnly) { Say ''; Say '✗ git-отправка не прошла (см. сообщение выше).'; exit 1 }
}

if (-not $Token) {
    Say ''
    Say '✗ Для отправки через API нужен токен.'
    Say '  Запустите:  .\publish-to-github.ps1 -Token ВАШ_ТОКЕН'
    exit 1
}

try {
    Send-ViaApi
    exit 0
} catch {
    Say ''
    Say ('✗ Не удалось отправить: ' + $_.Exception.Message)
    Say '  Проверьте токен (Contents: Read and write) и имя репозитория.'
    exit 1
}
