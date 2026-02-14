# install_python.ps1
# Downloads and installs Python 3.12 silently.
# Called automatically by run_primero.bat when Python is not found.

$ErrorActionPreference = "Stop"
$url = "https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe"
$dest = Join-Path $env:TEMP "python_installer.exe"

Write-Host "[INFO] Downloading Python 3.12 installer..."

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $client = New-Object Net.WebClient
    $client.DownloadFile($url, $dest)
    Write-Host "[OK] Download complete."
} catch {
    Write-Host "[ERROR] Download failed: $_"
    exit 1
}

Write-Host "[INFO] Running installer (this may take a minute)..."
$proc = Start-Process -FilePath $dest -ArgumentList "/passive", "PrependPath=1" -Wait -PassThru

if ($proc.ExitCode -ne 0) {
    Write-Host "[ERROR] Installer exited with code $($proc.ExitCode)"
    exit 1
}

Write-Host "[OK] Python installed successfully."
