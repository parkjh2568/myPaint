param(
    [Parameter(Mandatory)]
    [string]$TauriExe,
    [Parameter(Mandatory)]
    [string]$GpuiExe,
    [Parameter(Mandatory)]
    [string]$RunDirectory,
    [ValidateRange(1, 100)]
    [int]$Iterations = 8,
    [ValidateRange(0, 20)]
    [int]$Warmups = 1,
    [ValidateRange(500, 60000)]
    [int]$SettleMilliseconds = 1500,
    [ValidateRange(5, 300)]
    [int]$StartupTimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$script:startupCimAvailable = $true

function Get-ProcessInventory {
    if ($script:startupCimAvailable) {
        try {
            return @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)
        }
        catch {
            $script:startupCimAvailable = $false
        }
    }
    if (-not ('MyPaint.BenchProcessInventory' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace MyPaint {
    public static class BenchProcessInventory {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Entry {
            public uint Size, Usage, ProcessId;
            public UIntPtr DefaultHeap;
            public uint ModuleId, ThreadCount, ParentProcessId;
            public int Priority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string Path;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern bool Process32FirstW(IntPtr handle, ref Entry entry);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern bool Process32NextW(IntPtr handle, ref Entry entry);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public sealed class ProcessLink {
            public uint ProcessId, ParentProcessId;
            public string Name;
            public string CommandLine { get { return null; } }
            public DateTime? CreationDate { get { return null; } }
        }

        public static ProcessLink[] Snapshot() {
            IntPtr handle = CreateToolhelp32Snapshot(2, 0);
            if (handle == new IntPtr(-1)) throw new Win32Exception();
            try {
                Entry entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
                List<ProcessLink> links = new List<ProcessLink>();
                if (!Process32FirstW(handle, ref entry)) throw new Win32Exception();
                do {
                    links.Add(new ProcessLink {
                        ProcessId = entry.ProcessId,
                        ParentProcessId = entry.ParentProcessId,
                        Name = entry.Path
                    });
                } while (Process32NextW(handle, ref entry));
                return links.ToArray();
            } finally {
                CloseHandle(handle);
            }
        }
    }
}
'@
    }
    return [MyPaint.BenchProcessInventory]::Snapshot()
}

function Get-ProcessMemory {
    param(
        [Diagnostics.Process]$Application,
        [string]$Profile,
        [Diagnostics.Stopwatch]$Clock
    )
    $rootId = $Application.Id
    $started = $Application.StartTime.ToUniversalTime().AddSeconds(-1)
    $processes = @(Get-ProcessInventory)
    $included = [Collections.Generic.HashSet[int]]::new()
    [void]$included.Add($rootId)
    $profilePids = [Collections.Generic.HashSet[int]]::new()
    foreach ($record in $processes) {
        if ($Profile -and $record.Name -ieq 'msedgewebview2.exe' -and $record.CommandLine -and
            $record.CommandLine.IndexOf($Profile, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            [void]$profilePids.Add([int]$record.ProcessId)
            [void]$included.Add([int]$record.ProcessId)
        }
    }
    do {
        $count = $included.Count
        foreach ($record in $processes) {
            if ($included.Contains([int]$record.ParentProcessId) -and
                (-not $record.CreationDate -or $record.CreationDate.ToUniversalTime() -ge $started)) {
                [void]$included.Add([int]$record.ProcessId)
            }
        }
    } while ($included.Count -ne $count)

    $rows = @(
        foreach ($processId in ($included | Sort-Object)) {
            try {
                $process = [Diagnostics.Process]::GetProcessById($processId)
            }
            catch [ArgumentException] {
                continue
            }
            try {
                $process.Refresh()
                if ($processId -ne $rootId -and $process.StartTime.ToUniversalTime() -lt $started) {
                    continue
                }
                [pscustomobject][ordered]@{
                    pid = $process.Id
                    name = $process.ProcessName
                    source = if ($process.Id -eq $rootId) { 'app' } elseif ($profilePids.Contains($process.Id)) { 'webview-profile' } else { 'descendant' }
                    privateBytes = $process.PrivateMemorySize64
                    cpuMs = $process.TotalProcessorTime.TotalMilliseconds
                }
            }
            catch [InvalidOperationException] {
                continue
            }
            catch [ComponentModel.Win32Exception] {
                continue
            }
            finally {
                $process.Dispose()
            }
        }
    )
    if (-not ($rows | Where-Object { $_.pid -eq $rootId })) {
        throw 'App exited before memory sampling.'
    }
    $helpers = @($rows | Where-Object { $_.name -ieq 'msedgewebview2' })
    [pscustomobject][ordered]@{
        elapsedMs = $Clock.Elapsed.TotalMilliseconds
        privateBytes = [long](($rows | Measure-Object -Property privateBytes -Sum).Sum)
        webViewHelperCount = $helpers.Count
        processes = $rows
    }
}

function Get-Median {
    param([double[]]$Values)
    if ($Values.Count -eq 0) { return $null }
    $ordered = @($Values | Sort-Object)
    $middle = [int][Math]::Floor($ordered.Count / 2)
    if ($ordered.Count % 2 -eq 0) {
        return ($ordered[$middle - 1] + $ordered[$middle]) / 2
    }
    return $ordered[$middle]
}

function Measure-InstalledApp {
    param(
        [string]$App,
        [string]$Binary,
        [string]$IterationDirectory,
        [bool]$Warmup,
        [int]$Round
    )

    $persistence = Join-Path $IterationDirectory 'persistence'
    [void][IO.Directory]::CreateDirectory($persistence)
    $profile = ''
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Binary
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($Binary)
    $startInfo.UseShellExecute = $false
    [void]$startInfo.ArgumentList.Add('--persistence-root')
    [void]$startInfo.ArgumentList.Add($persistence)
    if ($App -eq 'tauri') {
        $profile = Join-Path $IterationDirectory 'webview'
        [void][IO.Directory]::CreateDirectory($profile)
        $startInfo.Environment['WEBVIEW2_USER_DATA_FOLDER'] = $profile
        [void]$startInfo.Environment.Remove('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
    }
    $measurement = [ordered]@{
        app = $App
        round = $Round
        warmup = $Warmup
        processId = $null
        firstWindowMs = $null
        firstInputIdleMs = $null
        privateBytesAfterSettle = $null
        idlePrivateBytes = $null
        stableProcessSet = $false
        settledCpuPercentOfOneCore = $null
        memorySamples = @()
        exit = $null
        error = $null
    }
    $process = $null
    try {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $process = [Diagnostics.Process]::Start($startInfo)
        $measurement.processId = $process.Id
        $inputIdleAvailable = $true
        while ($clock.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds) {
            $process.Refresh()
            if ($process.HasExited) {
                throw "App exited before its window was detected. Exit code $($process.ExitCode)."
            }
            if ($null -eq $measurement.firstWindowMs -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
                $measurement.firstWindowMs = $clock.Elapsed.TotalMilliseconds
            }
            if ($null -ne $measurement.firstWindowMs -and
                $null -eq $measurement.firstInputIdleMs -and $inputIdleAvailable) {
                try {
                    if ($process.WaitForInputIdle(0)) {
                        $measurement.firstInputIdleMs = $clock.Elapsed.TotalMilliseconds
                    }
                }
                catch [InvalidOperationException] {
                    $inputIdleAvailable = $false
                }
            }
            if ($null -ne $measurement.firstWindowMs -and
                ($null -ne $measurement.firstInputIdleMs -or -not $inputIdleAvailable -or
                    $clock.Elapsed.TotalMilliseconds -ge $measurement.firstWindowMs + 1000)) {
                break
            }
            Start-Sleep -Milliseconds 12
        }
        if ($null -eq $measurement.firstWindowMs) {
            throw "Main window was absent after $StartupTimeoutSeconds seconds."
        }
        if (-not $Warmup) {
            $remaining = [int][Math]::Max(0, $measurement.firstWindowMs + $SettleMilliseconds - $clock.Elapsed.TotalMilliseconds)
            Start-Sleep -Milliseconds $remaining
            $samples = @(
                for ($sample = 0; $sample -lt 3; $sample++) {
                    if ($sample -gt 0) { Start-Sleep -Milliseconds 250 }
                    Get-ProcessMemory -Application $process -Profile $profile -Clock $clock
                }
            )
            $measurement.memorySamples = $samples
            $measurement.privateBytesAfterSettle = [long](Get-Median -Values @($samples | ForEach-Object { $_.privateBytes }))
            $processSignature = $samples[0].processes.pid -join ','
            $measurement.stableProcessSet = -not ($samples | Where-Object { ($_.processes.pid -join ',') -ne $processSignature })
            if ($measurement.stableProcessSet) {
                $first = $samples[0]
                $last = $samples[-1]
                $cpuDelta = ($last.processes | Measure-Object -Property cpuMs -Sum).Sum - ($first.processes | Measure-Object -Property cpuMs -Sum).Sum
                $measurement.settledCpuPercentOfOneCore = 100 * $cpuDelta / ($last.elapsedMs - $first.elapsedMs)
                $spread = [double](($samples.privateBytes | Measure-Object -Maximum).Maximum - ($samples.privateBytes | Measure-Object -Minimum).Minimum)
                if ($measurement.settledCpuPercentOfOneCore -le 5 -and
                    $spread -le [Math]::Max(1048576, 0.02 * $measurement.privateBytesAfterSettle) -and
                    ($App -ne 'tauri' -or $samples[0].webViewHelperCount -gt 0)) {
                    $measurement.idlePrivateBytes = $measurement.privateBytesAfterSettle
                }
            }
        }
    }
    catch {
        $measurement.error = $_.Exception.Message
    }
    finally {
        if ($null -ne $process) {
            try {
                $process.Refresh()
                if ($process.HasExited) {
                    $measurement.exit = 'already-exited'
                }
                elseif ($process.CloseMainWindow() -and $process.WaitForExit(4500)) {
                    $measurement.exit = 'closed'
                }
                else {
                    $process.Kill($true)
                    [void]$process.WaitForExit(4500)
                    $measurement.exit = 'terminated'
                }
            }
            catch {
                $measurement.exit = 'error: ' + $_.Exception.Message
            }
            finally {
                $process.Dispose()
            }
        }
    }
    return $measurement
}

if (-not $IsWindows) {
    throw 'The benchmark requires an interactive Windows desktop.'
}
$binaries = [ordered]@{
    tauri = (Resolve-Path -LiteralPath $TauriExe -ErrorAction Stop).Path
    gpui = (Resolve-Path -LiteralPath $GpuiExe -ErrorAction Stop).Path
}
if ($binaries.tauri -eq $binaries.gpui) {
    throw 'Supply the separately installed Tauri and GPUI executables.'
}
$root = Join-Path ([IO.Path]::GetFullPath($RunDirectory)) ('startup-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$null = @(Get-ProcessInventory)
$timings = @(
    for ($round = 0; $round -lt $Warmups + $Iterations; $round++) {
        $apps = if ($round % 2 -eq 0) { @('tauri', 'gpui') } else { @('gpui', 'tauri') }
        foreach ($app in $apps) {
            $folder = Join-Path $root ('{0:D2}-{1}' -f ($round + 1), $app)
            $value = Measure-InstalledApp -App $app -Binary $binaries[$app] -IterationDirectory $folder `
                -Warmup ($round -lt $Warmups) -Round ($round + 1)
            Write-Host ('{0} {1}/{2}: {3:n1} ms {4}' -f $app, ($round + 1), ($Warmups + $Iterations), $value.firstWindowMs, $value.error)
            $value
        }
    }
)
$summary = [ordered]@{}
foreach ($app in $binaries.Keys) {
    $valid = @($timings | Where-Object { $_.app -eq $app -and -not $_.warmup -and -not $_.error })
    $idle = @($valid | Where-Object { $null -ne $_.idlePrivateBytes })
    $inputIdle = @($valid | Where-Object { $null -ne $_.firstInputIdleMs })
    $summary[$app] = [ordered]@{
        measuredRoundsCompleted = $valid.Count
        firstWindowMedianMs = Get-Median -Values @($valid | ForEach-Object { $_.firstWindowMs })
        firstInputIdleMedianMs = Get-Median -Values @($inputIdle | ForEach-Object { $_.firstInputIdleMs })
        privateBytesAfterSettleMedian = Get-Median -Values @($valid | ForEach-Object { $_.privateBytesAfterSettle })
        stableIdleRounds = $idle.Count
        idlePrivateBytesMedian = Get-Median -Values @($idle | ForEach-Object { $_.idlePrivateBytes })
    }
}
$cpuName = @($env:PROCESSOR_IDENTIFIER)
$gpuDetails = @()
if ($script:startupCimAvailable) {
    try {
        $cpuName = @(Get-CimInstance Win32_Processor -Property Name | ForEach-Object { $_.Name })
        $gpuDetails = @(Get-CimInstance Win32_VideoController -Property Name, DriverVersion, CurrentRefreshRate | ForEach-Object {
            [ordered]@{ name = $_.Name; driver = $_.DriverVersion; refreshHz = $_.CurrentRefreshRate }
        })
    }
    catch {
        Write-Verbose ('WMI machine metadata is unavailable. ' + $_.Exception.Message)
    }
}
$result = [ordered]@{
    scope = 'Installed app launch to detectable main HWND and optional Win32 input queue idle. Warm OS process starts with fresh app persistence and WebView profiles. Window detection and queue idle do not measure first displayed pixels or editing readiness.'
    memoryScope = 'Windows private committed bytes for app and descendants. CIM also includes msedgewebview2.exe matching the isolated profile. Idle requires stable PID set, <=5% of one CPU core, and private byte range within max(1 MiB, 2%). GPU memory is separate.'
    inventory = if ($script:startupCimAvailable) { 'CIM process ancestry and WebView profile' } else { 'Win32 Toolhelp process ancestry' }
    machine = [ordered]@{
        os = [Environment]::OSVersion.VersionString
        processorCount = [Environment]::ProcessorCount
        processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        cpu = $cpuName
        gpu = $gpuDetails
    }
    binaries = [ordered]@{
        tauri = @{ path = $binaries.tauri; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaries.tauri).Hash.ToLowerInvariant() }
        gpui = @{ path = $binaries.gpui; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaries.gpui).Hash.ToLowerInvariant() }
    }
    warmupsPerApp = $Warmups
    measuredIterationsPerApp = $Iterations
    settleMilliseconds = $SettleMilliseconds
    results = $summary
    samples = $timings
}
$output = Join-Path $root 'startup-results.json'
[IO.File]::WriteAllText($output, ($result | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Get-Item -LiteralPath $output
if ($summary.tauri.measuredRoundsCompleted -ne $Iterations -or $summary.gpui.measuredRoundsCompleted -ne $Iterations) {
    throw 'One or more benchmark launches failed. See startup-results.json for individual results.'
}
