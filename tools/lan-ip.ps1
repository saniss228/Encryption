# ============================================================================
#  Encryption — определение адреса для телефона (Wi-Fi / Ethernet).
#
#  Зачем отдельный файл: логику выбора адреса нужно проверять тестом
#  (tools/tests/test_lan_ip.ps1), а сам скрипт запуска — только использовать.
#
#  Почему не «первый попавшийся адрес»: на компьютере кроме Wi-Fi и Ethernet
#  обычно есть виртуальные адаптеры — Radmin VPN, Tailscale, Hyper-V, WSL,
#  VMware, а также «хот-спот» Windows с адресом 192.168.137.1. Телефон по таким
#  адресам не подключится, поэтому они получают штраф и идут в конец списка.
# ============================================================================

function Get-LanCandidates {
    <#
      Возвращает список адресов компьютера с оценкой пригодности (Score: меньше — лучше).
      Порядок поиска: Get-NetIPConfiguration (Windows) → .NET DNS → hostname -I (Linux/macOS).
    #>
    [CmdletBinding()]
    param()
    $list = @()

    # ── 1. Windows: настоящие сетевые интерфейсы системы ────────────────────
    try {
        foreach ($cfg in (Get-NetIPConfiguration -ErrorAction Stop)) {
            if (-not $cfg.IPv4Address) { continue }
            if ($cfg.NetAdapter) {
                if ($cfg.NetAdapter.Status -and $cfg.NetAdapter.Status -ne 'Up') { continue }
            }
            $alias = [string]$cfg.InterfaceAlias
            $desc  = ''
            $virt  = $false
            $gw    = [bool]$cfg.IPv4DefaultGateway
            if ($cfg.NetAdapter) {
                $desc = [string]$cfg.NetAdapter.InterfaceDescription
                $virt = [bool]$cfg.NetAdapter.Virtual
            }
            $label = $alias
            if ($desc -and $desc -ne $alias) { $label = "$alias ($desc)" }
            foreach ($a in $cfg.IPv4Address) {
                $ip = [string]$a.IPAddress
                if (-not $ip) { continue }
                if ($ip -like '127.*' -or $ip -like '169.254.*') { continue }
                $score = 0
                if ($virt) { $score += 100 }                     # VPN и виртуальные адаптеры
                if ($ip -like '192.168.137.*') { $score += 50 }  # хот-спот Windows
                if (-not $gw) { $score += 20 }                   # без выхода в сеть
                $list += [pscustomobject]@{ Ip = $ip; Label = $label; Score = $score; Source = 'адаптер' }
            }
        }
    } catch { }

    # ── 2. Запасной способ через .NET (работает и на Linux/macOS) ───────────
    if ($list.Count -eq 0) {
        try {
            $hostName = [System.Net.Dns]::GetHostName()
            foreach ($addr in [System.Net.Dns]::GetHostAddresses($hostName)) {
                if ($addr.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
                $ip = $addr.IPAddressToString
                if (-not $ip) { continue }
                if ($ip -like '127.*' -or $ip -like '169.254.*') { continue }
                $score = 30
                if ($ip -like '192.168.137.*') { $score += 50 }
                $list += [pscustomobject]@{ Ip = $ip; Label = 'системный адрес'; Score = $score; Source = 'dns' }
            }
        } catch { }
    }

    # ── 3. Linux/macOS: первый обычный адрес из hostname -I ─────────────────
    if ($list.Count -eq 0) {
        try {
            $out = & hostname '-I' 2>$null
            if ($out) {
                foreach ($ip in ("$out" -split '\s+')) {
                    if (-not $ip) { continue }
                    if ($ip -like '127.*' -or $ip -like '169.254.*') { continue }
                    $list += [pscustomobject]@{ Ip = $ip; Label = 'основной интерфейс'; Score = 40; Source = 'hostname' }
                }
            }
        } catch { }
    }

    return @($list)
}

function Get-BestLan {
    <#
      Выбирает лучший адрес из списка: возвращает Ip, Label и Others (остальные).
      Отдельной функцией — чтобы проверять правила тестом на «выдуманных» адаптерах.
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()][array] $Candidates = @()
    )
    $result = [pscustomobject]@{ Ip = $null; Label = ''; Others = @() }
    if (-not $Candidates -or $Candidates.Count -eq 0) { return $result }
    $sorted = @($Candidates | Sort-Object -Property Score, Ip)
    $result.Ip    = [string]$sorted[0].Ip
    $result.Label = [string]$sorted[0].Label
    if ($sorted.Count -gt 1) { $result.Others = @($sorted[1..($sorted.Count - 1)]) }
    return $result
}
