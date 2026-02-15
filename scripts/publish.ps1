param(
  [string]$Token = $env:NPM_TOKEN,
  [string]$Otp = $env:NPM_OTP
)

if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Error "NPM_TOKEN is required. Set it in the environment before publishing."
  exit 1
}

$npmrcPath = Join-Path $PSScriptRoot "..\.npmrc"
$npmrcPath = [System.IO.Path]::GetFullPath($npmrcPath)
$authLine = "//registry.npmjs.org/:_authToken=$Token"

try {
  Set-Content -Path $npmrcPath -Value $authLine -NoNewline
  if ([string]::IsNullOrWhiteSpace($Otp)) {
    npm publish --access public
  } else {
    npm publish --access public --otp=$Otp
  }
} finally {
  if (Test-Path $npmrcPath) {
    Remove-Item $npmrcPath -Force
  }
}
