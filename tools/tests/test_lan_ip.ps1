# ============================================================================
#  Тест правил выбора адреса для телефона (tools/lan-ip.ps1).
#
#  Проверяются настоящие функции из lan-ip.ps1 на «выдуманных» наборах
#  адаптеров — так же, как они выглядят на Windows:
#     • Wi-Fi с выходом в интернет        → должен победить
#     • Radmin VPN / Tailscale (virtual)  → не должен выбираться первым
#     • «хот-спот» Windows 192.168.137.1  → не должен выбираться первым
#     • Hyper-V / WSL без шлюза           → не должен выбираться первым
#
#  Запуск:  pwsh -NoProfile -File tools/tests/test_lan_ip.ps1
#           (или powershell -ExecutionPolicy Bypass -File …)
# ============================================================================
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'lan-ip.ps1')

$pass = 0; $fail = 0
function Check([string] $name, [bool] $ok, [string] $extra = '') {
    if ($ok) { Write-Host "  ✅ $name $extra" -ForegroundColor Green; $script:pass++ }
    else     { Write-Host "  ❌ $name $extra" -ForegroundColor Red;   $script:fail++ }
}

Write-Host ''
Write-Host '── 1. Типичный компьютер: Wi-Fi + Radmin VPN + хот-спот + WSL ──'
$typical = @(
    [pscustomobject]@{ Ip = '26.14.77.3';     Label = 'Radmin VPN (Famatech)';            Score = 100 },
    [pscustomobject]@{ Ip = '192.168.137.1';  Label = 'Локальное подключение (хот-спот)'; Score = 50 },
    [pscustomobject]@{ Ip = '172.20.32.1';    Label = 'vEthernet (WSL)';                  Score = 120 },
    [pscustomobject]@{ Ip = '192.168.1.42';   Label = 'Wi-Fi (Intel AX200)';              Score = 0 }
)
$best = Get-BestLan $typical
Check 'выбран адрес Wi-Fi' ($best.Ip -eq '192.168.1.42') "→ $($best.Ip)"
Check 'остальные адреса перечислены' ($best.Others.Count -eq 3) "→ $($best.Others.Count)"
Check 'Radmin VPN не первый' ($best.Ip -ne '26.14.77.3')

Write-Host '── 2. Есть только VPN и хот-спот ──'
$onlyVirtual = @(
    [pscustomobject]@{ Ip = '26.14.77.3';    Label = 'Radmin VPN'; Score = 100 },
    [pscustomobject]@{ Ip = '192.168.137.1'; Label = 'хот-спот';   Score = 50 }
)
$best2 = Get-BestLan $onlyVirtual
Check 'выбран хот-спот (он лучше VPN для телефона)' ($best2.Ip -eq '192.168.137.1') "→ $($best2.Ip)"

Write-Host '── 3. Два настоящих адаптера: Ethernet и Wi-Fi ──'
$twoReal = @(
    [pscustomobject]@{ Ip = '192.168.1.42'; Label = 'Wi-Fi';    Score = 0 },
    [pscustomobject]@{ Ip = '10.0.0.7';     Label = 'Ethernet'; Score = 0 }
)
$best3 = Get-BestLan $twoReal
Check 'при равных условиях выбор устойчив (по возрастанию адреса)' ($best3.Ip -eq '10.0.0.7') "→ $($best3.Ip)"
Check 'второй адрес попал в «другие»' (@($best3.Others).Count -eq 1)

Write-Host '── 4. Пустой список (нет сети) ──'
$best4 = Get-BestLan @()
Check 'адрес не выбран, ошибки нет' ($null -eq $best4.Ip)

Write-Host '── 5. Живой опрос системы (на этом компьютере) ──'
$live = @(Get-LanCandidates)
Check 'функция вернула список без ошибок' ($null -ne $live)
if ($live.Count -gt 0) {
    Write-Host "     найдено адресов: $($live.Count) → $(($live | ForEach-Object { $_.Ip }) -join ', ')"
    $liveBest = Get-BestLan $live
    Check 'из найденных адресов выбран один' ([bool]$liveBest.Ip) "→ $($liveBest.Ip)"
} else {
    Write-Host '     (на этом компьютере обычных адресов нет — только локальный)'
}

Write-Host ''
if ($fail -eq 0) {
    Write-Host "Пройдено: $pass   Провалено: 0" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Пройдено: $pass   Провалено: $fail" -ForegroundColor Red
    exit 1
}
