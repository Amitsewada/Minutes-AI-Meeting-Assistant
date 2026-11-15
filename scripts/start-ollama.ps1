$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_MODELS = Join-Path (Get-Location) '.local\ollama-models'
$env:OLLAMA_NO_CLOUD = 'true'
Write-Host 'Starting local Ollama. Keep this terminal open; Ctrl+C stops it.'
Write-Host 'Models are stored in .local\ollama-models. This script never downloads a model.'
ollama serve
