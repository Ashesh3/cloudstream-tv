param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

$review = Join-Path $RepositoryRoot ".impeccable\review"
New-Item -ItemType Directory -Force -Path $review | Out-Null

Copy-Item -LiteralPath (Join-Path $RepositoryRoot "e2e\enrollment.spec.ts-snapshots\admin-admin-wide-admin-wide-win32.png") -Destination (Join-Path $review "desktop.png") -Force
Copy-Item -LiteralPath (Join-Path $RepositoryRoot "e2e\enrollment.spec.ts-snapshots\admin-admin-mobile-admin-mobile-win32.png") -Destination (Join-Path $review "mobile.png") -Force
Copy-Item -LiteralPath (Join-Path $RepositoryRoot "e2e\enrollment.spec.ts-snapshots\tv-enrollment-waiting-tv-1920-win32.png") -Destination (Join-Path $review "tv-1920.png") -Force
Copy-Item -LiteralPath (Join-Path $RepositoryRoot "e2e\browse-viewer.spec.ts-snapshots\tv-viewer-image-tv-1920-win32.png") -Destination (Join-Path $review "tv-viewer.png") -Force

Get-ChildItem -LiteralPath $review -Filter "*.png" | Sort-Object Name | Select-Object Name, Length, LastWriteTime
