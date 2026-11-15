param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$digest = [Security.Cryptography.SHA256]::Create()
$launchId = [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '')
$digest.Dispose()
$launchMutex = New-Object Threading.Mutex($false, "Local\MinutesLauncher_$launchId")
$ownsMutex = $false
function Test-Minutes {
    try {
        $health = Invoke-RestMethod -Uri "$script:appUrl/api/health" -TimeoutSec 2
        return ($health.status -eq 'ok' -and $health.database -eq 'connected')
    } catch { return $false }
}
function Test-LocalPort([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(700) -and $client.Connected) }
    catch { return $false }
    finally { $client.Dispose() }
}
function Repair-StoppedDatabaseLock([string]$DataDirectory) {
    $lockPath = "$DataDirectory.lock"
    if (!(Test-Path -LiteralPath $lockPath)) { return }
    $original = Get-Content -LiteralPath $lockPath -Raw
    try { $owner = $original | ConvertFrom-Json } catch { throw "The database lock is unreadable. It was left untouched: $lockPath" }
    if ($owner.version -ne 1 -or $owner.pid -notmatch '^\d+$' -or [long]$owner.pid -le 0 -or $owner.token -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw "Unknown database lock; left untouched: $lockPath" }
    # Windows can report EPERM instead of ESRCH for a stopped PID. Verify using
    # both Windows process inventories before recovering a previous app session.
    $processes = @(Get-Process)
    if ($processes.Id -contains [int]$owner.pid) { throw "Another process owns the database (PID $($owner.pid)). Close the other Minutes server first." }
    if (Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.pid)") { throw 'The previous database owner still exists.' }
    if ((Get-Content -LiteralPath $lockPath -Raw) -ne $original) { throw 'The database lock changed; no recovery was performed.' }
    $archive = Join-Path $projectRoot ".local\launcher\stale-lock-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-ffff')).json"
    Copy-Item -LiteralPath $lockPath -Destination $archive
    Remove-Item -LiteralPath $lockPath
    Write-Host 'Recovered a stopped app session. Your database has been preserved.'
}
try {
    try { $ownsMutex = $launchMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { Write-Host 'Minutes is already starting. Please wait for the browser to open.'; exit 0 }
    Write-Host "`nStarting Minutes - AI Meeting Assistant`n" -ForegroundColor Cyan
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $nodeVersion = [Version]((& $node --version).TrimStart('v'))
    if ($nodeVersion -lt [Version]'22.12.0') { throw 'Install Node.js 22.12 or newer, then double-click Start Minutes again.' }
    if (!(Test-Path -LiteralPath 'node_modules\tsx\package.json') -or !(Test-Path -LiteralPath 'node_modules\dotenv\package.json')) {
        Write-Host 'Installing project dependencies (internet required on first run)...'
        & $npm ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your internet connection and try again.' }
    }
    if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
    # Print only non-secret configuration into this script; never print the key.
    $configJson = & $node (Join-Path $PSScriptRoot 'launcher-config.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the application configuration.' }
    $config = $configJson | ConvertFrom-Json
    $appPort = 0
    if (![int]::TryParse([string]$config.port, [ref]$appPort) -or $appPort -lt 1024 -or $appPort -gt 65535) { throw 'PORT in .env must be between 1024 and 65535.' }
    $script:appUrl = "http://127.0.0.1:$appPort"
    $logDirectory = Join-Path $projectRoot '.local\launcher'
    [void](New-Item -ItemType Directory -Path $logDirectory -Force)

    # Build only when the frontend is missing or relevant sources changed.
    $index = Join-Path $projectRoot 'dist\index.html'
    $buildNeeded = !(Test-Path -LiteralPath $index)
    if (!$buildNeeded) {
        $built = (Get-Item -LiteralPath $index).LastWriteTimeUtc
        $sources = @(Get-ChildItem -LiteralPath 'src','shared','server','public' -File -Recurse)
        $sources += @(Get-Item -LiteralPath 'package.json','package-lock.json','vite.config.ts','tsconfig.json','index.html')
        $buildNeeded = @($sources | Where-Object { $_.LastWriteTimeUtc -gt $built }).Count -gt 0
    }
    if ($buildNeeded) {
        Write-Host 'Building the app...'
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw 'The build failed. The error is shown above; the app was not started.' }
    } else { Write-Host 'The app build is up to date.' }

    # Ollama is optional. Reuse a running service and never download a model.
    try {
        $ollamaUrl = [Uri]$config.ollama
        $localOllama = $ollamaUrl.Scheme -eq 'http' -and $ollamaUrl.Host -in @('localhost','127.0.0.1','[::1]','::1')
        if ($localOllama) {
            $ollamaReady = $false
            try { $null = Invoke-RestMethod -Uri "$($ollamaUrl.GetLeftPart([UriPartial]::Authority))/api/tags" -TimeoutSec 2; $ollamaReady = $true } catch { }
            if (!$ollamaReady) {
                $ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
                $ollamaExecutable = if ($ollamaCommand) { $ollamaCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
                if (Test-Path -LiteralPath $ollamaExecutable) {
                    $env:OLLAMA_HOST = "127.0.0.1:$($ollamaUrl.Port)"
                    if (Test-Path -LiteralPath (Join-Path $projectRoot '.local\ollama-models')) { $env:OLLAMA_MODELS = Join-Path $projectRoot '.local\ollama-models' }
                    $env:OLLAMA_NO_CLOUD = 'true'
                    $null = Start-Process -FilePath $ollamaExecutable -ArgumentList 'serve' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'ollama-out.log') -RedirectStandardError (Join-Path $logDirectory 'ollama-error.log') -PassThru
                    Write-Host 'Starting optional Ollama in the background; no models are downloaded.'
                } else { Write-Host 'Ollama is not installed. Groq and demo mode remain available.' }
            } else { Write-Host 'Ollama is already running.' }
        }
    } catch { Write-Host 'Optional Ollama could not start. You can still use Groq or demo mode.' -ForegroundColor Yellow }

    if (!(Test-Minutes)) {
        if (Test-LocalPort $appPort) { throw "Port $appPort is occupied by another service. Close it or change PORT in .env." }
        $dataDirectory = if ([IO.Path]::IsPathRooted([string]$config.data)) { [IO.Path]::GetFullPath([string]$config.data) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot ([string]$config.data))) }
        Repair-StoppedDatabaseLock $dataDirectory
        Write-Host 'Starting the local server...'
        $serverProcess = Start-Process -FilePath $node -ArgumentList @('--import','tsx','server/index.ts') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'server-out.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log') -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while (!(Test-Minutes)) {
            $serverProcess.Refresh()
            if ($serverProcess.HasExited) { throw "The server could not start. Read $logDirectory\server-error.log for details." }
            if ([DateTime]::UtcNow -gt $deadline) { throw "Startup is taking longer than expected. Check $logDirectory\server-error.log before trying again." }
            Start-Sleep -Milliseconds 400
        }
    } else { Write-Host 'Minutes is already running; reusing the existing server.' }
    if (!$NoBrowser) { Start-Process $appUrl }
    Write-Host "Ready: $appUrl" -ForegroundColor Green
    Write-Host 'The server runs in the background. You can close this launcher window.'
} catch {
    Write-Host "`nMinutes could not start: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Your meeting data has not been deleted. Keep this message when asking for help.'
    exit 1
} finally {
    if ($ownsMutex) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
