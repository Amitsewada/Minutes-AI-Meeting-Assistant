# Creates fictional speech locally; no microphone, network, or private meeting data.
# Run with Windows PowerShell 5.1: powershell.exe -NoProfile -File scripts/make-test-audio.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$audioDirectory = Join-Path $PSScriptRoot '..\.local\audio-verification'
[void](New-Item -ItemType Directory -Path $audioDirectory -Force)
$audioFile = [System.IO.Path]::GetFullPath((Join-Path $audioDirectory 'fictional-meeting.wav'))
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $englishVoice = $synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
    if (-not $englishVoice) { throw 'Install an English Windows text-to-speech voice before generating this test fixture.' }
    $synthesizer.SelectVoice($englishVoice.VoiceInfo.Name)
    $synthesizer.Rate = -1
    $synthesizer.SetOutputToWaveFile($audioFile)
    $synthesizer.Speak('This is a fictional meeting for testing. We decided to launch the pilot. Maya will send the brief by Friday.')
} finally { $synthesizer.Dispose() }
Write-Output "Created fictional speech: $audioFile"
