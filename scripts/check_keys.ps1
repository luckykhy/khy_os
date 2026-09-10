$apk = "D:\Portable\khy-os\apps\khy-os-client-app\build\app\outputs\flutter-apk\app-release.apk"
$bytes = [System.IO.File]::ReadAllBytes($apk)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)

$checks = @(
    "sk-kxfDu1UuUz4na6gNnoTy9",
    "user_QduohLPx5gneWbdfWEwd",
    "844986c572bf414489be6f7d",
    "sk-GfGfEeMHAP9OqViis7N6",
    "sk-ZqZmy6xPoGTJhAiAVe7",
    "sk-TDyXYtuXXCUrw42bDqtz"
)

Write-Host "=== Plaintext Key Scan ==="
$leaked = 0
foreach ($check in $checks) {
    if ($ascii.Contains($check)) {
        Write-Host "[LEAKED] $check"
        $leaked++
    } else {
        Write-Host "[SAFE]   $check not found"
    }
}
if ($leaked -eq 0) {
    Write-Host "`nAll keys are encrypted. Safe."
} else {
    Write-Host "`nWARNING: $leaked keys leaked in plaintext!"
}
