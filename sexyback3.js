#!/usr/bin/env node
/**
 * Instant-start mixer: mic + MP3 -> mix -> default playback (set to "CABLE Input")
 * Music is always decoded; we live-toggle its volume via FFmpeg `azmq`.
 * - No native addons
 * - Windows webcam detection via registry
 * - Requires: ffmpeg + ffplay in PATH, npm i zeromq
 */

const { spawn } = require("child_process");
const zmq = require("zeromq");
const { setTimeout: sleep } = require("timers/promises");

// --------------- CONFIG ---------------
const MP3_PATH = "sexyback.mp3"; // your track
const MIC_DSHOW_NAME = "Microphone (2- HyperX SoloCast)"; // exact name from `ffmpeg -list_devices true -f dshow -i dummy`
const MIC_GAIN = 1.0; // 0..2
const MUSIC_GAIN_ACTIVE = 0.35; // 0..2 when camera ON
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const CAM_POLL_MS = 150; // camera check interval
const ZMQ_ENDPOINT = "tcp://127.0.0.1:5555"; // ffmpeg azmq default
// --------------------------------------

// Globals
let procFfmpeg = null;
let procFfplay = null;
let zmqSock = null;
let stopping = false;

// ---- Camera detection (Windows registry) ----
async function isWebcamInUse() {
  return new Promise((resolve) => {
    const ps = `
$paths = @(
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged"
)
$active = $false
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem $p -ErrorAction SilentlyContinue | ForEach-Object {
      $k = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      $start = $k.LastUsedTimeStart
      $stop  = $k.LastUsedTimeStop
      if ($start -and (-not $stop -or [int64]$start -gt [int64]$stop)) { $active = $true }
    }
    $kroot = Get-ItemProperty $p -ErrorAction SilentlyContinue
    if ($kroot) {
      $start = $kroot.LastUsedTimeStart
      $stop  = $kroot.LastUsedTimeStop
      if ($start -and (-not $stop -or [int64]$start -gt [int64]$stop)) { $active = $true }
    }
  }
}
if ($active) { "True" } else { "False" }
`.trim();

    const pwsh = spawn("powershell", ["-NoProfile", "-Command", ps], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    pwsh.stdout.on("data", (d) => (out += d.toString()));
    pwsh.on("close", () => resolve(out.trim().toLowerCase().includes("true")));
    pwsh.on("error", () => resolve(false));
  });
}

// ---- FFmpeg pipeline (always running) ----
function startPipeline() {
  stopping = false;

  // We tag the music volume filter as @mus so we can live-update it over ZMQ.
  // The azmq filter listens on tcp://127.0.0.1:5555 and passes commands to tagged filters.
  const filter =
    `[1:a]volume@mus=0.0[aMus];` + // start muted; we’ll bump to MUSIC_GAIN_ACTIVE when camera is on
    `[0:a]volume=${MIC_GAIN}[aMic];` + // apply mic gain
    `[aMic][aMus]amix=inputs=2:duration=longest:dropout_transition=0,` +
    `aresample=${SAMPLE_RATE}:async=1:min_comp=0.001:first_pts=0,` +
    `azmq`; // <-- enable ZeroMQ control

  // ffmpeg: read mic (dshow) + mp3, mix, write WAV to stdout
  procFfmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "warning",

      // dshow mic input (smaller buffers for lower latency)
      "-f",
      "dshow",
      "-rtbufsize",
      "32M",
      "-audio_buffer_size",
      "50",
      "-i",
      `audio=${MIC_DSHOW_NAME}`,

      // mp3 input (loop forever)
      "-stream_loop",
      "-1",
      "-i",
      MP3_PATH,

      // low-latency demux/decoder hints
      "-flags",
      "low_delay",
      "-fflags",
      "nobuffer",
      "-probesize",
      "32k",
      "-analyzeduration",
      "0",
      "-use_wallclock_as_timestamps",
      "1",
      "-reorder_queue_size",
      "0",

      // mixing
      "-filter_complex",
      filter,
      "-ac",
      String(CHANNELS),
      "-ar",
      String(SAMPLE_RATE),

      // stream to stdout as WAV (ffplay will auto-detect format)
      "-flush_packets",
      "1",
      "-f",
      "wav",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );

  procFfmpeg.on("error", (e) =>
    console.error("ERROR: ffmpeg failed to start:", e.message)
  );

  // ffplay: play to DEFAULT playback device (set that to CABLE Input)
  procFfplay = spawn(
    "ffplay",
    [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-probesize",
      "32k",
      "-analyzeduration",
      "0",
      "-",
    ],
    { stdio: ["pipe", "inherit", "inherit"] }
  );

  // Wire ffmpeg -> ffplay, guard EPIPE
  procFfmpeg.stdout.pipe(procFfplay.stdin);
  procFfplay.stdin?.on("error", (e) => {
    if (e?.code !== "EPIPE") console.error("ffplay stdin error:", e.message);
  });
  procFfmpeg.stdout?.on("error", (e) => {
    if (e?.code !== "EPIPE") console.error("ffmpeg stdout error:", e.message);
  });

  procFfplay.on("close", () => {
    if (!stopping && procFfmpeg && !procFfmpeg.killed)
      try {
        procFfmpeg.kill("SIGTERM");
      } catch {}
  });

  console.log(
    `[pipeline] running. Default playback MUST be "CABLE Input (VB-Audio Virtual Cable)".`
  );
}

// ---- Safe teardown ----
function stopPipeline() {
  stopping = true;
  try {
    if (procFfmpeg?.stdout && procFfplay?.stdin) {
      try {
        procFfmpeg.stdout.unpipe(procFfplay.stdin);
      } catch {}
      try {
        procFfplay.stdin.end();
      } catch {}
      try {
        procFfplay.stdin.destroy();
      } catch {}
    }
  } catch {}
  try {
    procFfplay?.kill("SIGTERM");
  } catch {}
  try {
    procFfmpeg?.kill("SIGTERM");
  } catch {}
  procFfplay = null;
  procFfmpeg = null;
  console.log("[pipeline] stopped.");
}

// ---- ZMQ control: set music gain instantly ----
async function initZmq() {
  zmqSock = new zmq.Request();
  await zmqSock.connect(ZMQ_ENDPOINT);
  // sanity: ping
  // (FFmpeg's azmq replies with "OK" on any well-formed command; we’ll send real commands below)
}

// Send a command like:  volume@mus volume 0.35
async function setMusicVolume(vol) {
  if (!zmqSock) return;
  const cmd = `volume@mus volume ${vol}`;
  try {
    await zmqSock.send(cmd);
    // read reply to complete REQ/REP handshake (even if we ignore it)
    await zmqSock.receive().catch(() => {});
  } catch (e) {
    // ignore transient errors if ffmpeg is starting up
  }
}

// ---- Main loop ----
async function main() {
  console.log("Mixed virtual-mic (instant start via azmq).");
  console.log(
    '- Set Windows *default playback* to:  "CABLE Input (VB-Audio Virtual Cable)".'
  );
  console.log(
    '- In Zoom/Meet select mic:            "CABLE Output (VB-Audio Virtual Cable)".\n'
  );

  startPipeline(); // keep running
  await sleep(350); // small warm-up so azmq is ready
  await initZmq(); // connect to azmq control
  await setMusicVolume(0.0); // start muted

  // initial state
  let camWasActive = false;
  let stopTimer = null;

  for (;;) {
    const active = await isWebcamInUse();

    if (active && !camWasActive) {
      console.log("[camera] IN USE -> music ON");
      clearTimeout(stopTimer);
      await setMusicVolume(MUSIC_GAIN_ACTIVE);
    } else if (!active && camWasActive) {
      // tiny debounce to avoid flapping on device switches
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        console.log("[camera] idle -> music OFF");
        setMusicVolume(0.0);
      }, 300);
    }

    camWasActive = active;
    await sleep(CAM_POLL_MS);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  setMusicVolume(0.0).finally(() => {
    stopPipeline();
    process.exit(0);
  });
});
process.on("SIGTERM", () => {
  setMusicVolume(0.0).finally(() => {
    stopPipeline();
    process.exit(0);
  });
});

main().catch((err) => {
  console.error(err);
  try {
    setMusicVolume(0.0);
  } catch {}
  stopPipeline();
  process.exit(1);
});
