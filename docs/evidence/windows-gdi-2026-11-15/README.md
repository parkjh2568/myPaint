# Windows GDI brush input measurements

On 2026-11-15, the two installed Windows apps received the same 33 synthetic mouse clicks at matched document coordinates. Each run contains three warmup rows and 30 measured rows. Latency starts at the Windows mouse hook and ends at the first GDI readback containing the brush color. The endpoint includes polling and screen readback time. [Comparison report](../../GPUI_WINDOWS_COMPARISON.md) · [Measurement procedure](../../../bench/windows-input-display.md)

| Component | Source commit |
| --- | --- |
| Tauri application | `04a2c5d71416aa4442623519969e7c391b13e479` |
| GPUI application | `f4e2095bd782d6b7de25a162725af7d9d104f003` |
| Shared Windows observer | `ea24e7214d1108359ee2359420ff36a205195f60` |

The conditions file records the executable hashes, the observer file's Git blob, the brush and viewport configuration, and the document coordinates. The summary uses post-warmup `ok` rows and calculates milliseconds as `(readback_qpc - hook_qpc) * 1000 / qpc_frequency`. The p95 is the nearest rank. [Conditions](gdi-conditions.json) · [Summary](gdi-formal-summary.json) · [GPUI CSV](gpui-gdi-formal.csv) · [Tauri CSV](tauri-gdi-formal.csv) · [GPUI GUI observations](gpui-gui-verification.json)

The SHA-256 manifest covers UTF-8 text with LF line endings. From this directory, run `sha256sum -c SHA256SUMS.txt` in an LF checkout. To verify a Windows checkout that uses CRLF, normalize the line endings before hashing. [Checksums](SHA256SUMS.txt)

```powershell
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    foreach ($entry in Get-Content -LiteralPath SHA256SUMS.txt) {
        $expected, $file = $entry -split '  ', 2
        $path = (Resolve-Path -LiteralPath $file).Path
        $text = [System.IO.File]::ReadAllText($path).Replace("`r`n", "`n")
        $digest = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
        $actual = [System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
        if ($actual -ne $expected) { throw "SHA-256 mismatch for $file" }
        Write-Output "$file OK"
    }
} finally {
    $sha256.Dispose()
}
```
