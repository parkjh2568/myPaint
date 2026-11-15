param(
    [Parameter(Mandatory)]
    [string]$InputExe,
    [Parameter(Mandatory)]
    [string]$OutputInstaller,
    [string]$MakeNsis = 'makensis.exe'
)

$ErrorActionPreference = 'Stop'

if (-not [IO.Path]::IsPathFullyQualified($InputExe) -or
    -not [IO.Path]::IsPathFullyQualified($OutputInstaller)) {
    throw 'Specify absolute paths for the application and installer.'
}

$application = Get-Item -LiteralPath $InputExe
$destination = [IO.Path]::GetFullPath($OutputInstaller)
if ($application.PSIsContainer -or $application.Extension -ne '.exe' -or
    [IO.Path]::GetExtension($destination) -ne '.exe' -or
    $application.FullName -eq $destination) {
    throw 'Specify different .exe files for the application and installer.'
}

$compiler = (Get-Command -Name $MakeNsis -CommandType Application -ErrorAction Stop).Source
$destinationFolder = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($destination))
if (-not $destinationFolder.PSIsContainer) {
    throw 'The installer output directory must exist.'
}

$recipe = Join-Path $PSScriptRoot 'installer.nsi'
$stagingName = '.mypaint-gpui-' + [Guid]::NewGuid().ToString('N') + '.exe'
$stagingPath = Join-Path $destinationFolder.FullName $stagingName
try {
    & $compiler '/V3' "/DINPUT_EXE=$($application.FullName)" "/DOUTPUT_INSTALLER=$stagingPath" $recipe
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $stagingPath -PathType Leaf)) {
        throw "NSIS failed to build the installer. Exit code $LASTEXITCODE."
    }
    [IO.File]::Move($stagingPath, $destination, $true)
    Get-Item -LiteralPath $destination
}
finally {
    if (Test-Path -LiteralPath $stagingPath -PathType Leaf) {
        Remove-Item -LiteralPath $stagingPath
    }
}
