<#
  Reads what Windows thinks is playing, and passes transport commands back.

  When an iPhone is paired over Bluetooth A2DP, Windows publishes the phone's
  track as a system media session — the same one the volume flyout shows — and
  routes play/pause/next back out over AVRCP. That session is the only way a
  browser-based head unit can see what the phone is doing, so this script is the
  whole bridge to it.

  Protocol: one compact JSON object per line on stdout whenever the state
  changes; one command word per line on stdin (play, pause, playpause, next,
  previous). Errors go out as {"error": "..."} and exit non-zero, so the caller
  can say "no source" instead of guessing.

  MUST run under Windows PowerShell 5.1 (powershell.exe), not PowerShell 7
  (pwsh.exe): awaiting a WinRT IAsyncOperation depends on the
  System.Runtime.WindowsRuntime AsTask extension, which .NET Core dropped.
#>

$ErrorActionPreference = 'Stop'

# A track title is not necessarily ASCII, and it is going straight into JSON.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Line($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Fail($message) {
  Write-Line @{ error = $message }
  exit 1
}

# ── WinRT plumbing ─────────────────────────────────────────────────────────
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
} catch {
  Fail "this build of Windows has no media session API: $($_.Exception.Message)"
}

# WinRT hands back IAsyncOperation<T>; PowerShell has no await. The AsTask
# extension converts one to a Task<T> we can block on, but it is generic and
# resolved by reflection because PowerShell cannot call it as an extension.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

if ($null -eq $asTaskGeneric) { Fail 'could not bind WindowsRuntimeSystemExtensions.AsTask' }

function Await($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(5000)) { throw 'the media session API did not answer within 5s' }
  $task.Result
}

try {
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  Fail "could not open the media session manager: $($_.Exception.Message)"
}

# ── Reading the current session ────────────────────────────────────────────
# Closed/Opened/Stopped all mean "nothing to show". Changing is the gap during a
# track skip: it is reported as its own state so the UI can hold the previous
# track on screen instead of blinking through an empty one.
$STATUS = @{ 0 = 'stopped'; 1 = 'stopped'; 2 = 'changing'; 3 = 'stopped'; 4 = 'playing'; 5 = 'paused' }

function NullIfBlank($value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  $value
}

function Get-Snapshot {
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) {
    return @{ state = 'none'; sourceApp = $null }
  }

  $props = Await ($session.TryGetMediaPropertiesAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $session.GetPlaybackInfo()
  $timeline = $session.GetTimelineProperties()

  # Position is measured from StartTime, not from zero — a station or a chapter
  # can begin partway along the timeline.
  $position = [int64]($timeline.Position - $timeline.StartTime).TotalMilliseconds
  $duration = [int64]($timeline.EndTime - $timeline.StartTime).TotalMilliseconds

  # Windows says when it last measured the position. Trusting that instead of
  # "now" is what keeps the interpolated progress bar honest across a slow poll.
  $measuredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($timeline.LastUpdatedTime.Year -gt 2000) {
    $measuredAt = $timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
  }

  $out = @{}
  $out.state       = $STATUS[[int]$info.PlaybackStatus]
  $out.title       = NullIfBlank $props.Title
  $out.artist      = NullIfBlank $props.Artist
  $out.album       = NullIfBlank $props.AlbumTitle
  $out.position    = $null
  $out.duration    = $null
  if ($position -ge 0) { $out.position = $position }
  if ($duration -gt 0) { $out.duration = $duration }
  $out.positionAt  = $measuredAt
  $out.canPlay     = [bool]$info.Controls.IsPlayEnabled
  $out.canPause    = [bool]$info.Controls.IsPauseEnabled
  $out.canNext     = [bool]$info.Controls.IsNextEnabled
  $out.canPrevious = [bool]$info.Controls.IsPreviousEnabled
  $out.sourceApp   = NullIfBlank $session.SourceAppUserModelId
  $out
}

function Invoke-Transport($verb) {
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) { return }
  try {
    switch ($verb) {
      'play'      { [void](Await ($session.TryPlayAsync()) ([bool])) }
      'pause'     { [void](Await ($session.TryPauseAsync()) ([bool])) }
      'playpause' { [void](Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
      'next'      { [void](Await ($session.TrySkipNextAsync()) ([bool])) }
      'previous'  { [void](Await ($session.TrySkipPreviousAsync()) ([bool])) }
    }
  } catch {
    # A phone that refuses a command is normal — AVRCP advertises more than it
    # honours. Losing the poll loop over it would not be.
    [Console]::Error.WriteLine("command '$verb' refused: $($_.Exception.Message)")
  }
}

# Position moves on its own, so it cannot be part of a plain equality check or
# every poll would look like news. Quantising it re-syncs a drifting or seeked
# client within a couple of seconds without emitting a line per tick.
function Get-Signature($snap) {
  $bucket = if ($null -ne $snap.position) { [math]::Floor($snap.position / 2000) } else { 'x' }
  "$($snap.state)|$($snap.title)|$($snap.artist)|$($snap.album)|$($snap.duration)|$bucket|" +
  "$($snap.canPlay)$($snap.canPause)$($snap.canNext)$($snap.canPrevious)|$($snap.sourceApp)"
}

# ── Loop ───────────────────────────────────────────────────────────────────
# Read stdin off the raw stream rather than [Console]::In. Console.In is a
# SyncTextReader, whose ReadLineAsync is asynchronous in name only — it blocks
# the calling thread until a line arrives, which would stall the poll loop until
# somebody pressed a button. ReadAsync on the underlying stream really does
# return immediately, so state keeps flowing whether or not commands come.
$stdinStream = [Console]::OpenStandardInput()
$readBuffer = New-Object byte[] 512
$pendingRead = $null
$partial = ''
$last = $null
$lastPoll = [datetime]::MinValue

while ($true) {
  if ($null -eq $pendingRead) { $pendingRead = $stdinStream.ReadAsync($readBuffer, 0, $readBuffer.Length) }
  if ($pendingRead.IsCompleted) {
    if ($pendingRead.IsFaulted) { break }
    $count = $pendingRead.Result
    $pendingRead = $null
    if ($count -le 0) { break }   # stdin closed: the shell is gone, so are we

    # A command can arrive split across reads, or several at once in one.
    $partial += [System.Text.Encoding]::UTF8.GetString($readBuffer, 0, $count)
    while ($partial.Contains("`n")) {
      $break = $partial.IndexOf("`n")
      $verb = $partial.Substring(0, $break).Trim().ToLowerInvariant()
      $partial = $partial.Substring($break + 1)
      if ($verb) {
        Invoke-Transport $verb
        # Report the result of the tap immediately rather than up to a second
        # later, so the button on screen does not look like it missed.
        $lastPoll = [datetime]::MinValue
      }
    }
  }

  if (([datetime]::UtcNow - $lastPoll).TotalMilliseconds -ge 1000) {
    $lastPoll = [datetime]::UtcNow
    try {
      $snap = Get-Snapshot
      $signature = Get-Signature $snap
      if ($signature -ne $last) {
        $last = $signature
        Write-Line $snap
      }
    } catch {
      [Console]::Error.WriteLine("poll failed: $($_.Exception.Message)")
    }
  }

  # Short enough that a transport command leaves within a tenth of a second,
  # while the session itself is still only read once a second.
  Start-Sleep -Milliseconds 100
}
