param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('x86', 'x64', 'arm64')]
    [string]$Architecture
)

$ErrorActionPreference = 'Stop'
# VS 2022 runtime baseline; newer compatible v14 runtimes also satisfy it.
$minimumVersion = [version]'14.40.33810.0'
$registryView = if ($Architecture -eq 'x86') {
    [Microsoft.Win32.RegistryView]::Registry32
} else {
    [Microsoft.Win32.RegistryView]::Registry64
}
$baseKey = $null
$runtimeKey = $null
$downloadDirectory = $null
$operation = '/install'
try {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine, $registryView)
    $runtimeKey = $baseKey.OpenSubKey("SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\$Architecture")
    if ($null -ne $runtimeKey -and $runtimeKey.GetValue('Installed', 0) -eq 1) {
        $installedVersion = [version](([string]$runtimeKey.GetValue('Version', '0.0')).TrimStart('v', 'V'))
        $systemDirectory = Join-Path $env:WINDIR 'System32'
        if ([Environment]::Is64BitOperatingSystem) {
            if ($Architecture -eq 'x86') {
                $systemDirectory = Join-Path $env:WINDIR 'SysWOW64'
            } elseif (-not [Environment]::Is64BitProcess) {
                $systemDirectory = Join-Path $env:WINDIR 'Sysnative'
            }
        }
        $hasRuntimeFiles = (Test-Path -LiteralPath (Join-Path $systemDirectory 'msvcp140.dll')) -and
            (Test-Path -LiteralPath (Join-Path $systemDirectory 'vcruntime140.dll'))
        if ($installedVersion -ge $minimumVersion -and $hasRuntimeFiles) {
            Write-Output "Visual C++ $Architecture runtime $installedVersion is already installed."
            exit 0
        }
        if ($installedVersion -ge $minimumVersion -and -not $hasRuntimeFiles) {
            $operation = '/repair'
        }
    }

    $downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('NexusDesk-vcredist-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
    $installer = Join-Path $downloadDirectory "vc_redist.$Architecture.exe"
    # Microsoft's official permalink redirects to the Microsoft download CDN.
    $url = "https://aka.ms/vs/17/release/vc_redist.$Architecture.exe"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Output "Downloading Visual C++ runtime from $url"
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -TimeoutSec 300

    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw 'The downloaded runtime does not have a valid Microsoft signature.'
    }

    Write-Output 'Installing Visual C++ runtime silently...'
    $process = Start-Process -FilePath $installer -ArgumentList $operation, '/quiet', '/norestart' -Wait -PassThru
    switch ($process.ExitCode) {
        0 { Write-Output 'Visual C++ runtime installation completed.'; exit 0 }
        3010 { Write-Output 'Visual C++ runtime installed; Windows restart required.'; exit 3010 }
        default { throw "Visual C++ runtime installer exited with code $($process.ExitCode)." }
    }
} catch {
    Write-Output "Visual C++ runtime setup failed: $($_.Exception.Message)"
    exit 1603
} finally {
    if ($null -ne $runtimeKey) { $runtimeKey.Dispose() }
    if ($null -ne $baseKey) { $baseKey.Dispose() }
    if ($null -ne $downloadDirectory -and (Test-Path -LiteralPath $downloadDirectory)) {
        Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
