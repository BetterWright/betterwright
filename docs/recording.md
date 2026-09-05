# Record a browser session

Record the current tab as an MP4 video while you use BetterWright. Recording preserves the page, its JavaScript state, and elapsed time. It captures the viewport without audio.

MP4 uses H.264 by default. An explicit `.webm` filename selects VP8/WebM. The default filename is `recording.mp4`.

FFmpeg must be available on `PATH`, with `libx264` for MP4 or `libvpx` for WebM. To use another installed binary, set `BETTERWRIGHT_FFMPEG_PATH` to its absolute path. Recording checks the encoder when it starts. Ordinary browsing does not require FFmpeg, and BetterWright does not install it automatically.

## Record from the CLI

Open the page in a named session, then start recording:

```sh
betterwright run --session demo -c "await page.goto('https://example.com')"
betterwright record start demo.mp4 --session demo --fps 60
```

Continue using `betterwright run --session demo` to interact with the page. Check recording progress and finish the video:

```sh
betterwright record status --session demo
betterwright record stop --session demo
```

Stop flushes the video and returns its path in the session artifact directory. Pass a filename such as `demo.mp4`, without a directory path. Use the same `--profile` and `--session` on each command.

To finish the current take and begin another, run:

```sh
betterwright record restart take-2.mp4 --session demo
```

The CLI requires the session daemon. It rejects `--no-daemon` and `--close`, which would end capture when the command exits. Starting an active recording fails. Stopping a completed recording returns its completed status again. Stopping before any recording returns `idle`.

## Set capture limits

To record a shorter take at a lower output rate, run:

```sh
betterwright record start short.mp4 --session demo --fps 30 --max-duration 30
```

`--max-duration` uses seconds and defaults to 300. `--fps` accepts 1 through 60 and defaults to 60. `--max-width` and `--max-height` default to 1280 and 720 pixels. `--quality` defaults to 80 on a scale of 1 through 100.

60 FPS is the requested output rate. Actual motion depends on how often the page renders and capture delivers frames. Static intervals repeat the last picture to preserve elapsed time. `capturedFrames` counts received captures, `outputFrames` includes repeated pictures, and `droppedFrames` reports captures the recorder discarded. A 60 FPS video file alone does not prove 60 distinct pictures per second.

## Record through a browser tool

Run these snippets in separate browser calls around the actions you want to capture:

```js
return recording.start({ name: "demo.mp4", fps: 60, maxDurationMs: 30_000 });
```

```js
return recording.status();
```

```js
return recording.stop();
```

The snippet option `maxDurationMs` uses milliseconds. The remaining options are `name`, `fps`, `maxWidth`, `maxHeight`, and `quality`. `recording.restart(options)` finishes the previous take before starting another. Recording stays attached to the tab where it started, including navigation within that tab.

MCP clients can use `browser_record` with `action` set to `start`, `stop`, `status`, or `restart`. Pass capture options only with `start` or `restart`, and set `session` to select the browser session. The result retains the video artifact path. Local video capture does not enable remote downloads.

Closing the tab through `page.close()` or `closePage()`, closing its session, and shutting down BetterWright finish the recording first. A browser crash or a failed encoder returns a failed status and removes the incomplete video.

Each recording reserves up to 50 MiB within the session artifact quota. If encoded output exceeds that limit, recording fails and removes the partial file. The default five-minute duration limit finishes a valid video. Smaller viewports are padded to the output size without upscaling.

The recorder loads only when requested. While recording, its tab stays awake between browser calls. FFmpeg uses one decoder thread, one filter thread, and two encoding threads, and the capture queue retains at most four JPEG frames within a 16 MiB limit, plus the last emitted frame and stream buffers. Recording consumes additional CPU while active.

MP4 output is fragmented so it can stream through the same bounded pipe while recording. The encoder uses x264’s `veryfast` preset, CRF 28, and zero-latency tuning. In identical-input comparisons, this used 16–40% less encoder CPU and about 12% less peak encoder memory than the WebM configuration, with higher measured SSIM. File size depended on the content: 59% smaller for text and scrolling, but 41% larger for a moving dashboard. See the [performance audit](performance-audit.md#recording-format-comparison) for the method and limits.
