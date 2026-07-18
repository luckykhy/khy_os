try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 5
    Write-Output "HEALTH: $($r.StatusCode) $($r.Content)"
} catch {
    Write-Output "HEALTH-ERR: $($_.Exception.Message)"
}
try {
    $body = @{ model = 'minimax-m3'; messages = @(@{ role = 'user'; content = 'hi' }) } | ConvertTo-Json -Depth 5
    $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/v1/chat/completions' -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60
    Write-Output "CHAT: $($r2.StatusCode)"
    Write-Output $r2.Content
} catch {
    Write-Output "CHAT-ERR: $($_.Exception.Message)"
}
