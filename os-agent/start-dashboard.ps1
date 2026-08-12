Param()

Write-Host "Installing dependencies for os-agent..." -ForegroundColor Cyan
Push-Location -Path $PSScriptRoot
if (Test-Path package.json) {
    npm install
} else {
    Write-Host "package.json not found in $PSScriptRoot" -ForegroundColor Yellow
}

Write-Host "Starting dashboard-server.js on 127.0.0.1:4173" -ForegroundColor Cyan
# Start in a new process so the script doesn't block
Start-Process -FilePath "node" -ArgumentList "dashboard-server.js" -WorkingDirectory $PSScriptRoot
Pop-Location

Write-Host "Dashboard started (check http://127.0.0.1:4173)" -ForegroundColor Green
