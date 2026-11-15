# Windows input-to-display comparison

Run in the interactive Windows desktop that hosts the installed apps. The Windows SDK and an x64 Visual Studio Native Tools prompt provide the compiler and libraries:

```bat
cl /nologo /std:c++20 /EHsc /O2 /W4 /WX /utf-8 bench\windows-input-display.cpp user32.lib gdi32.lib d3d11.lib dxgi.lib
```

Run these read-only preflight commands on the same desktop:

```powershell
.\windows-input-display.exe --probe dxgi
.\windows-input-display.exe --probe gdi
.\windows-input-display.exe --devices
.\windows-input-display.exe --window $appPid
```

The probe checks capture resource availability. A pilot click checks the complete hook and marker path. The window command returns the physical screen origin, client size and DPI for one app PID. Subtract the origin from desktop pixel coordinates to get the client coordinates requested by `--roi`.

Supply `--window PID HWND` for geometry and `--hwnd HWND` for a benchmark when automatic window selection is ambiguous. Use the decimal `MainWindowHandle` from `Get-Process -Id $appPid`. The tool verifies that the handle identifies a root window owned by the specified PID and accepts input only while that window is foreground and under the click.

1. Use the same machine, monitor, Windows scaling, window dimensions, project dimensions, zoom, layer workload and brush parameters for both apps. Prepare a white drawing area with an opaque high-chroma brush color such as `1679EA`. Keep the pointer, overlays and selection guides free of that color inside the canvas.
2. Determine each app's physical client rectangle for the clean drawing area. Use that rectangle as `X,Y,W,H`. The tool accepts only clicks whose 17×17-pixel detection area fits inside the rectangle, and checks that the selected PID's root window is in the foreground and under the click during capture.
3. Run a pilot with `--warmup 0 --samples 1`. After the tool says `Armed`, focus the target, click a fresh canvas point and confirm that the mark and a valid CSV row both appear. If the desktop denies DXGI, pilot both apps in GDI mode.
4. Run both apps with the same capture mode, input source and sample schedule. Await each trial before the next click. Use fresh points at least 30 physical pixels apart for small brushes. Increase spacing for larger brushes. Repeat sessions with app order reversed.

```powershell
.\windows-input-display.exe --pid $appPid --out gpui-pilot.csv --roi 220,170,650,400 --rgb 1679EA --mode dxgi --warmup 0 --samples 1
.\windows-input-display.exe --pid $appPid --out gpui-run1.csv --roi 220,170,650,400 --rgb 1679EA --mode dxgi --warmup 3 --samples 30 --seconds 180
```

The start timestamp is QPC in the native `WH_MOUSE_LL` callback for left-button down. DXGI uses the desktop update's `LastPresentTime` from the first observed frame containing at least three pixels within the requested color tolerance. The tool keeps the duplication queue current and reads only the click-local region into CPU memory. The GDI mode uses QPC when a `BitBlt` poll reads back the region. A GDI observation includes time waiting for the next poll and capture time. Its CSV includes the maximum elapsed interval between polls per trial. The endpoint in both modes is a Windows compositor observation. Monitor scan-out and physical light emission require external instrumentation. [Mouse hook](https://learn.microsoft.com/windows/win32/winmsg/lowlevelmouseproc) · [DXGI frame timestamps](https://learn.microsoft.com/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info)

Record capture mode, input origin, sample count and invalid-trial counts with any median or percentile. Use only post-warmup `ok` rows with the agreed input origin. An `injected` value of `1` marks synthetic Windows input. DXGI `coalesced` rows combine multiple desktop updates and cannot identify the first matching frame precisely. Keep these rows, timeouts and incomplete runs in raw evidence. The CSV contains relative client click coordinates, timestamps and pixel counts. Captured pixel data is neither saved nor transferred.
