param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Discover', 'Signature', 'PortOwner', 'Install', 'Start', 'Disable', 'Watch')]
    [string]$Action,
    [string]$NodePath,
    [string]$RuntimePath,
    [string]$DataDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = if ($env:KCT_WINDOWS_REQUEST) {
    $env:KCT_WINDOWS_REQUEST | ConvertFrom-Json
} else { $null }

switch ($Action) {
    'Discover' {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Kimi Code.exe'" | ForEach-Object {
            $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
            if ($owner.ReturnValue -ne 0) { throw 'Cannot determine Kimi process ownership' }
            if ($owner.Sid -eq $sid) {
                [pscustomobject]@{
                    pid = [int]$_.ProcessId
                    ownerSid = $owner.Sid
                    executable = $_.ExecutablePath
                    commandLine = $_.CommandLine
                    started = $_.CreationDate.ToUniversalTime().ToString('o')
                }
            }
        })
        @{ sid = $sid; processes = $processes } | ConvertTo-Json -Depth 5 -Compress
    }
    'Signature' {
        $signature = Get-AuthenticodeSignature -LiteralPath $request.executable
        $thumbprint = if ($null -ne $signature.SignerCertificate) {
            $signature.SignerCertificate.Thumbprint
        } else { '' }
        @{ status = $signature.Status.ToString(); thumbprint = $thumbprint } | ConvertTo-Json -Compress
    }
    'PortOwner' {
        $listeners = @(Get-NetTCPConnection -State Listen | Where-Object {
            $_.LocalPort -eq [int]$request.port
        } | ForEach-Object {
            @{ pid = [int]$_.OwningProcess; address = $_.LocalAddress }
        })
        ConvertTo-Json -InputObject $listeners -Compress
    }
    'Install' {
        # The Node watcher releases its lock just before its parent PowerShell exits.
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            $existing = Get-ScheduledTask -TaskName $request.taskName -ErrorAction SilentlyContinue
            if ($null -eq $existing -or $existing.State -ne 'Running') { break }
            Start-Sleep -Milliseconds 100
        }
        if ($null -ne $existing -and $existing.State -eq 'Running') {
            throw 'Previous scheduled watcher is still exiting; retry installation later'
        }
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $powershell = Join-Path $PSHOME 'powershell.exe'
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $request.arguments
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $request.taskName -Action $taskAction `
            -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        '{"installed":true}'
    }
    'Start' {
        Start-ScheduledTask -TaskName $request.taskName
        '{"started":true}'
    }
    'Disable' {
        $task = Get-ScheduledTask -TaskName $request.taskName -ErrorAction SilentlyContinue
        if ($null -ne $task) {
            Unregister-ScheduledTask -TaskName $request.taskName -Confirm:$false
        }
        '{"disabled":true}'
    }
    'Watch' {
        if (-not $NodePath -or -not $RuntimePath) { throw 'Watch requires NodePath and RuntimePath' }
        if ($DataDir) { $env:KCT_WINDOWS_DATA_DIR = $DataDir }
        $env:NODE_OPTIONS = ''
        $env:NODE_PATH = ''
        & $NodePath $RuntimePath '--watch'
        exit $LASTEXITCODE
    }
}
