#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Re-narrate both demo books with real word alignment, then push storylark-dev.
# Runs fully detached; log: D:\git\storylark\storylark\.storylark\renarrate.log
Set-Location 'D:\git\storylark\storylark'
node packages/pipeline/publish.mjs --brand storylark-local --source examples/demo --parser examples/demo/parser.mjs --local 'D:\git\storylark\storylark-dev\content'
if ($LASTEXITCODE -ne 0) { throw "publish failed: $LASTEXITCODE" }
Set-Location 'D:\git\storylark\storylark-dev'
git add content
git -c core.safecrlf=false commit -m @'
feat(content): exact word-aligned narration for both books (Whisper forced alignment)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YXLRbeJBEyzJpHNP3HTkZd
'@
git push origin main
Write-Output "DONE $(Get-Date -Format o)"
