param(
 [string]$OutputDirectory,
 [string]$CacheDirectory
)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=(Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid package version'}
if(-not $OutputDirectory){$OutputDirectory=Join-Path $repoRoot 'dist'}
if(-not $CacheDirectory){$CacheDirectory=Join-Path $repoRoot '.build\downloads'}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$CacheDirectory=[IO.Path]::GetFullPath($CacheDirectory)
New-Item -ItemType Directory -Path $OutputDirectory,$CacheDirectory -Force | Out-Null
$manifest=Get-Content -LiteralPath (Join-Path $repoRoot 'runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-VerifiedArchive($entry){
 $uri=[Uri]$entry.url
 if($uri.Scheme -ne 'https' -or $uri.Host -notin @('nodejs.org','www.python.org')){throw 'Runtime download must use an official HTTPS origin'}
 if($entry.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid SHA-256'}
 $destination=Join-Path $CacheDirectory ([IO.Path]::GetFileName($uri.AbsolutePath))
 if(-not (Test-Path -LiteralPath $destination)){
  Write-Host ('Downloading '+$uri.AbsoluteUri)
  Invoke-WebRequest -Uri $uri -OutFile $destination -UseBasicParsing
 }
 if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Checksum mismatch: '+$destination)}
 return $destination
}
$nodeZip=Get-VerifiedArchive $manifest.node
$pythonZip=Get-VerifiedArchive $manifest.python
$buildRoot=Join-Path $repoRoot ('.build\release-'+[Guid]::NewGuid().ToString('N'))
$bundle=Join-Path $buildRoot 'GhostJob-Local'
New-Item -ItemType Directory -Path $bundle -Force | Out-Null
# Files are selected explicitly. A working user's database is never copied.
$names=@('server.mjs','package.json','README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','runtime-manifest.json','使用说明.txt','Start.cmd','Start.vbs','Stop.cmd','模拟演练.cmd','模拟演练.vbs','.gitignore','.gitattributes')
foreach($name in $names){Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $bundle $name)}
foreach($folder in @('lib','public','tests','scripts')){
 New-Item -ItemType Directory -Path (Join-Path $bundle $folder) -Force | Out-Null
 Get-ChildItem -LiteralPath (Join-Path $repoRoot $folder) -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $bundle $folder)}
}
New-Item -ItemType Directory -Path (Join-Path $bundle 'vendor') -Force | Out-Null
foreach($name in @('pypdf.zip','pypdf-LICENSE.txt')){Copy-Item -LiteralPath (Join-Path $repoRoot ('vendor\'+$name)) -Destination (Join-Path $bundle ('vendor\'+$name))}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtime=Join-Path $bundle 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$zip=[IO.Compression.ZipFile]::OpenRead($nodeZip)
try{
 foreach($pair in @(@('node.exe','node.exe'),@('LICENSE','NODE-LICENSE.txt'))){
  $entry=$zip.GetEntry('node-v'+$manifest.node.version+'-win-x64/'+$pair[0])
  if(-not $entry){throw 'Official Node archive is missing a required file'}
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $runtime $pair[1]),$false)
 }
}finally{$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($pythonZip,(Join-Path $runtime 'python'))
$output=Join-Path $OutputDirectory ('GhostJob-Local-v'+$version+'-windows-x64.zip')
if(Test-Path -LiteralPath $output){throw ('Output already exists: '+$output)}
[IO.Compression.ZipFile]::CreateFromDirectory($buildRoot,$output,[IO.Compression.CompressionLevel]::Optimal,$false)
$sha=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
$line=$sha+'  '+[IO.Path]::GetFileName($output)
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'),$line+"`n",[Text.UTF8Encoding]::new($false))
Write-Host ('Built: '+$output)
Write-Host ('SHA-256: '+$sha)
