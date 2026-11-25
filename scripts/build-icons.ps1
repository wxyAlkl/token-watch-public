# Render the SVG paths to native-size Windows and Chromium assets (Windows PowerShell, STA).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore,WindowsBase
$dir = Join-Path $PSScriptRoot '../public/icons'
[xml]$source = Get-Content -Raw -LiteralPath (Join-Path $dir 'token-watch.svg')
function Render-Icon([int]$size, [string]$signal) {
  $visual = [Windows.Media.DrawingVisual]::new()
  $dc = $visual.RenderOpen()
  $dc.PushTransform([Windows.Media.ScaleTransform]::new($size / 64.0, $size / 64.0))
  foreach ($p in $source.svg.path) {
    $color = if ($signal -and $p.id -eq 'signal') { $signal } else { $p.fill }
    $brush = [Windows.Media.SolidColorBrush]::new([Windows.Media.ColorConverter]::ConvertFromString($color))
    $dc.DrawGeometry($brush, $null, [Windows.Media.Geometry]::Parse($p.d))
  }
  $dc.Pop()
  $dc.Close()
  $bmp = [Windows.Media.Imaging.RenderTargetBitmap]::new($size,$size,96,96,[Windows.Media.PixelFormats]::Pbgra32)
  $bmp.Render($visual)
  $enc = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
  $stream = [IO.MemoryStream]::new()
  try { $enc.Save($stream); return ,$stream.ToArray() } finally { $stream.Dispose() }
}
$sizes = @(16,20,24,32,40,48,64,128,256)
$images = @{}
foreach ($size in $sizes) { $images[$size] = Render-Icon $size }
[IO.File]::WriteAllBytes((Join-Path $dir 'token-watch.png'), $images[256])
$states = @{ online=$null; syncing='#82B2FF'; warning='#FFC666'; offline='#A6B4B8' }
foreach ($name in $states.Keys) {
  [IO.File]::WriteAllBytes((Join-Path $dir "tray-$name.png"), (Render-Icon 32 $states[$name]))
}
$stream = [IO.MemoryStream]::new()
$writer = [IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  foreach ($size in $sizes) {
    $edge = [byte]($size % 256)
    $writer.Write($edge); $writer.Write($edge); $writer.Write([uint16]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$size].Length); $writer.Write([uint32]$offset)
    $offset += $images[$size].Length
  }
  foreach ($size in $sizes) { $writer.Write([byte[]]$images[$size]) }
  [IO.File]::WriteAllBytes((Join-Path $dir 'token-watch.ico'), $stream.ToArray())
} finally { $writer.Dispose(); $stream.Dispose() }
