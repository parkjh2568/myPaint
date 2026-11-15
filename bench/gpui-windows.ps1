param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$Output,
    [ValidateRange(1, 16)][int]$Layers = 1,
    [ValidateRange(1, 30)][int]$Repeats = 3
)
$ErrorActionPreference = 'Stop'
$app = (Resolve-Path -LiteralPath $Binary).Path
$outputRoot = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $outputRoot) { throw 'Use a new output directory.' }
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$record = [Collections.Generic.List[object]]::new()
for ($iteration = 0; $iteration -lt $Repeats; $iteration++) {
    $run = Join-Path $outputRoot ('run-{0:d2}' -f $iteration)
    New-Item -ItemType Directory -Path $run | Out-Null
    $outputFile = Join-Path $run 'result.json'
    $options = [Diagnostics.ProcessStartInfo]::new($app)
    $options.UseShellExecute = $false
    $options.CreateNoWindow = $true
    $options.WorkingDirectory = $run
    foreach ($arg in @('--persistence-root', (Join-Path $run 'profile'), '--benchmark-result', $outputFile, '--benchmark-layers', "$Layers")) {
        $options.ArgumentList.Add($arg)
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($options)
    try {
        if (!$process.WaitForExit(120000)) {
            $process.Kill($true)
            throw "GPUI run $iteration timed out."
        }
        if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $outputFile)) {
            throw "GPUI run $iteration did not return a measurement (exit $($process.ExitCode))."
        }
        $result = Get-Content -LiteralPath $outputFile -Raw | ConvertFrom-Json
        if (!$result.ok -or $result.strokeSamples.Count -ne 20) { throw "GPUI run $iteration failed: $($result.error)" }
        $record.Add([ordered]@{ iteration = $iteration; processWallMs = $watch.Elapsed.TotalMilliseconds; samples = $result })
    } finally {
        $process.Dispose()
    }
}
[ordered]@{ app = $app; sha256 = (Get-FileHash -LiteralPath $app).Hash.ToLowerInvariant(); runs = $record } |
    ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $outputRoot 'results.json') -Encoding utf8
Get-Item -LiteralPath (Join-Path $outputRoot 'results.json')
