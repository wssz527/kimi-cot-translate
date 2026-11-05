param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Discover', 'Signature', 'PortOwner', 'Install', 'Start', 'Restart', 'Reload', 'Disable', 'Watch')]
    [string]$Action,
    [string]$NodePath,
    [string]$RuntimePath,
    [string]$DataDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A caller running PowerShell 7 can otherwise pass incompatible modules to Windows PowerShell.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
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
        # The subject lets the loader accept a rotated certificate by publisher
        # while the pinned thumbprints are updated.
        $subject = if ($null -ne $signature.SignerCertificate) {
            $signature.SignerCertificate.Subject
        } else { '' }
        @{ status = $signature.Status.ToString(); thumbprint = $thumbprint;
           subject = $subject } | ConvertTo-Json -Compress
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
        # The previous watcher is a long-lived process (`-ExecutionTimeLimit 0`),
        # so waiting for it to stop can only ever time out — that wait used to
        # burn 24 seconds and fail the install. `-Force` replaces the registration
        # regardless; the caller stops the old watcher by writing the stop file,
        # which happens before this runs.
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
    'Restart' {
        # A watcher cannot replace the task it is running in: `-MultipleInstances
        # IgnoreNew` drops a start issued while it is alive, and stopping it by
        # force would kill the attachment the user is looking at. A delayed helper
        # waits for it to exit on its own, then re-registers the task against
        # whatever `enabled.json` points at and starts it. Doing the registration
        # in the helper (rather than trusting the earlier Install) keeps the task
        # and the deployed bundle in step even if that registration did not take.
        $delay = 10
        if ($null -ne $request -and $request.PSObject.Properties['delaySeconds'] -and $request.delaySeconds) {
            $delay = [int]$request.delaySeconds
        }
        $taskName = $request.taskName
        $dataDir = if ($null -ne $request -and $request.PSObject.Properties['dataDir']) { $request.dataDir } else { '' }
        $node = $request.nodePath
        $helper = @"
Start-Sleep -Seconds $delay
`$enabled = Join-Path '$dataDir' 'enabled.json'
if (-not (Test-Path `$enabled)) { exit 0 }
`$entry = (Get-Content `$enabled -Raw | ConvertFrom-Json).entry
if (-not `$entry -or -not (Test-Path `$entry)) { exit 1 }
`$bridge = Join-Path (Split-Path `$entry -Parent) 'windows-bridge.ps1'
`$env:KCT_WINDOWS_REQUEST = (@{ taskName = '$taskName' } | ConvertTo-Json -Compress)
& `$bridge -Action Reload -NodePath '$node' -RuntimePath `$entry -DataDir '$dataDir'
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
            -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $encoded) `
            -WindowStyle Hidden | Out-Null
        '{"restartScheduled":true}'
    }
    'Reload' {
        # Registers this task against the bundle named by -RuntimePath, then starts
        # it. Called by the delayed helper once the old watcher has exited.
        $taskName = $request.taskName
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $shell = Join-Path $PSHOME 'powershell.exe'
        $run = "& '$RuntimePath' -Action Watch -NodePath '$NodePath' -RuntimePath '$RuntimePath'" +
            $(if ($DataDir) { " -DataDir '$DataDir'" } else { '' }) + '; exit $LASTEXITCODE'
        $taskAction = New-ScheduledTaskAction -Execute $shell -Argument (
            '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ' +
            [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($run)))
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger `
            -Principal $principal -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        '{"reloaded":true}'
    }

    'Disable' {
        $taskName = if ($null -ne $request -and $request.PSObject.Properties['taskName']) { $request.taskName } else { $null }
        $task = if ($taskName) { Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } else { $null }
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
