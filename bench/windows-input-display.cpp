#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

constexpr LONG radius = 8;
constexpr UINT side = radius * 2 + 1;
constexpr UINT minimumPixels = 3;
constexpr auto sampleTimeout = std::chrono::milliseconds(750);

long long ticks() {
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return value.QuadPart;
}

void require(bool ok, const char* operation) {
    if (!ok) {
        throw std::runtime_error(std::string(operation) + " failed");
    }
}

void check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        char detail[20]{};
        std::snprintf(detail, sizeof(detail), " (0x%08lx)", static_cast<unsigned long>(result));
        throw std::runtime_error(std::string(operation) + detail);
    }
}

struct Options {
    DWORD pid = 0;
    HWND hwnd = nullptr;
    std::filesystem::path output;
    RECT roi{};
    unsigned rgb = 0;
    unsigned samples = 20;
    unsigned warmup = 3;
    unsigned seconds = 120;
    unsigned tolerance = 16;
    bool gdi = false;
};

unsigned number(const std::wstring& value, unsigned maximum, int base = 10) {
    require(!value.empty() && value.front() != L'-', "numeric argument");
    wchar_t* end = nullptr;
    errno = 0;
    const auto parsed = std::wcstoul(value.c_str(), &end, base);
    require(errno != ERANGE && end == value.c_str() + value.size() && parsed <= maximum,
            "numeric argument");
    return parsed;
}

HWND window_handle(const std::wstring& value) {
    require(!value.empty() && value.front() >= L'0' && value.front() <= L'9', "window handle");
    wchar_t* end = nullptr;
    errno = 0;
    const auto parsed = std::wcstoull(value.c_str(), &end, 10);
    require(errno != ERANGE && end == value.c_str() + value.size() && parsed != 0 &&
                parsed <= std::numeric_limits<std::uintptr_t>::max(), "window handle");
    return reinterpret_cast<HWND>(static_cast<std::uintptr_t>(parsed));
}

RECT rectangle(const std::wstring& value) {
    const auto first = value.find(L',');
    const auto second = value.find(L',', first == value.npos ? first : first + 1);
    const auto third = value.find(L',', second == value.npos ? second : second + 1);
    require(third != value.npos, "ROI must be x,y,width,height");
    const auto x = static_cast<LONG>(number(value.substr(0, first), 32768));
    const auto y = static_cast<LONG>(number(value.substr(first + 1, second - first - 1), 32768));
    const auto w = static_cast<LONG>(number(value.substr(second + 1, third - second - 1), 32768));
    const auto h = static_cast<LONG>(number(value.substr(third + 1), 32768));
    require(w >= side && h >= side, "ROI dimensions");
    return {x, y, x + w, y + h};
}

bool gdi_mode(const std::wstring& value) {
    require(value == L"dxgi" || value == L"gdi", "capture mode");
    return value == L"gdi";
}

Options parse(int argc, wchar_t** argv) {
    Options options;
    bool hasColor = false;
    for (int i = 1; i < argc; i += 2) {
        require(i + 1 < argc, "missing argument value");
        const std::wstring name = argv[i];
        const std::wstring value = argv[i + 1];
        if (name == L"--pid") {
            options.pid = number(value, MAXDWORD);
        } else if (name == L"--hwnd") {
            options.hwnd = window_handle(value);
        } else if (name == L"--out") {
            options.output = value;
        } else if (name == L"--roi") {
            options.roi = rectangle(value);
        } else if (name == L"--rgb") {
            const auto color = value.starts_with(L"#") ? value.substr(1) : value;
            require(color.size() == 6, "RGB must be RRGGBB");
            options.rgb = number(color, 0xffffff, 16);
            hasColor = true;
        } else if (name == L"--samples") {
            options.samples = number(value, 1000);
        } else if (name == L"--warmup") {
            options.warmup = number(value, 100);
        } else if (name == L"--seconds") {
            options.seconds = number(value, 1800);
        } else if (name == L"--tolerance") {
            options.tolerance = number(value, 48);
        } else if (name == L"--mode") {
            options.gdi = gdi_mode(value);
        } else {
            throw std::runtime_error("unknown option");
        }
    }
    require(options.pid != 0 && !options.output.empty() && !IsRectEmpty(&options.roi) &&
                hasColor && options.samples != 0 && options.seconds != 0, "required arguments");
    return options;
}

bool fits(POINT position, RECT bounds) {
    return position.x >= bounds.left + radius && position.x < bounds.right - radius &&
           position.y >= bounds.top + radius && position.y < bounds.bottom - radius;
}

HWND root_window(HWND window) {
    return GetAncestor(window, GA_ROOT);
}

struct TargetWindows {
    DWORD pid;
    std::vector<HWND> found;
};

BOOL CALLBACK count_windows(HWND window, LPARAM data) {
    auto& windows = *reinterpret_cast<TargetWindows*>(data);
    DWORD owner = 0;
    GetWindowThreadProcessId(window, &owner);
    if (owner == windows.pid && IsWindowVisible(window) && !GetWindow(window, GW_OWNER)) {
        windows.found.push_back(window);
    }
    return TRUE;
}

HWND target_window(DWORD pid, HWND supplied) {
    if (supplied) {
        DWORD owner = 0;
        require(IsWindow(supplied) && root_window(supplied) == supplied &&
                    GetWindowThreadProcessId(supplied, &owner) && owner == pid,
                "explicit HWND must be a root window owned by the target PID");
        return supplied;
    }
    HWND active = root_window(GetForegroundWindow());
    DWORD owner = 0;
    GetWindowThreadProcessId(active, &owner);
    if (active && owner == pid) {
        return active;
    }
    TargetWindows windows{pid, {}};
    EnumWindows(count_windows, reinterpret_cast<LPARAM>(&windows));
    require(windows.found.size() == 1, "PID must have one visible top-level window or be in foreground");
    return windows.found.front();
}

struct Reading {
    long long presented;
    long long observed;
    unsigned frames;
    unsigned matched;
};

class Screen {
public:
    Screen(HMONITOR monitor, bool gdi, unsigned rgb, unsigned tolerance)
        : gdi_(gdi), red_(rgb >> 16), green_((rgb >> 8) & 255), blue_(rgb & 255),
          tolerance_(static_cast<int>(tolerance)) {
        MONITORINFO info{};
        info.cbSize = sizeof(info);
        require(GetMonitorInfoW(monitor, &info), "GetMonitorInfoW");
        bounds = info.rcMonitor;
        if (!gdi_) {
            open_dxgi(monitor);
            return;
        }
        display_ = GetDC(nullptr);
        require(display_ != nullptr, "GetDC");
        buffer_ = CreateCompatibleDC(display_);
        BITMAPINFO bitmap{};
        bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bitmap.bmiHeader.biWidth = side;
        bitmap.bmiHeader.biHeight = -static_cast<LONG>(side);
        bitmap.bmiHeader.biPlanes = 1;
        bitmap.bmiHeader.biBitCount = 32;
        bitmap.bmiHeader.biCompression = BI_RGB;
        bitmap_ = CreateDIBSection(display_, &bitmap, DIB_RGB_COLORS, &bits_, nullptr, 0);
        if (buffer_ && bitmap_) {
            selected_ = SelectObject(buffer_, bitmap_);
        }
        if (!selected_ || selected_ == HGDI_ERROR || !bits_) {
            close_gdi();
            throw std::runtime_error("create GDI capture buffer failed");
        }
    }

    ~Screen() {
        discard_frame();
        close_gdi();
    }

    Screen(const Screen&) = delete;
    Screen& operator=(const Screen&) = delete;

    void probe() {
        if (gdi_) {
            return;
        }
        require(wait_frame(300), "initial desktop frame");
        discard_frame();
    }

    bool wait_frame(UINT timeout) {
        if (!frame_) {
            const auto result = duplication_->AcquireNextFrame(timeout, &frameInfo_, &frame_);
            if (result == DXGI_ERROR_WAIT_TIMEOUT) {
                return false;
            }
            check(result, "AcquireNextFrame");
        }
        return true;
    }

    void discard_frame() {
        if (frame_) {
            frame_.Reset();
            duplication_->ReleaseFrame();
        }
    }

    std::optional<Reading> sample(POINT position) {
        if (gdi_) {
            require(BitBlt(buffer_, 0, 0, side, side, display_,
                           position.x - radius, position.y - radius, SRCCOPY | CAPTUREBLT),
                    "BitBlt");
            GdiFlush();
            const auto observed = ticks();
            return Reading{0, observed, 0, matches(bits_, side * 4)};
        }
        if (!wait_frame(16)) return std::nullopt;
        struct ReleaseFrame {
            Screen& screen;
            ~ReleaseFrame() { screen.discard_frame(); }
        } release{*this};
        if (!frameInfo_.LastPresentTime.QuadPart || frameInfo_.ProtectedContentMaskedOut) {
            return std::nullopt;
        }
        ComPtr<ID3D11Texture2D> texture;
        check(frame_.As(&texture), "desktop texture");
        const auto x = static_cast<UINT>(position.x - bounds.left - radius);
        const auto y = static_cast<UINT>(position.y - bounds.top - radius);
        D3D11_BOX box{x, y, 0, x + side, y + side, 1};
        context_->CopySubresourceRegion(staging_.Get(), 0, 0, 0, 0, texture.Get(), 0, &box);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map click ROI");
        const auto observed = ticks();
        const auto matched = matches(mapped.pData, mapped.RowPitch);
        context_->Unmap(staging_.Get(), 0);
        return Reading{frameInfo_.LastPresentTime.QuadPart, observed, frameInfo_.AccumulatedFrames, matched};
    }

    RECT bounds{};

private:
    void open_dxgi(HMONITOR monitor) {
        ComPtr<IDXGIFactory1> factory;
        check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");
        for (UINT a = 0;; ++a) {
            ComPtr<IDXGIAdapter1> adapter;
            const auto nextAdapter = factory->EnumAdapters1(a, &adapter);
            if (nextAdapter == DXGI_ERROR_NOT_FOUND) {
                break;
            }
            check(nextAdapter, "EnumAdapters1");
            for (UINT o = 0;; ++o) {
                ComPtr<IDXGIOutput> output;
                const auto nextOutput = adapter->EnumOutputs(o, &output);
                if (nextOutput == DXGI_ERROR_NOT_FOUND) {
                    break;
                }
                check(nextOutput, "EnumOutputs");
                DXGI_OUTPUT_DESC desc{};
                check(output->GetDesc(&desc), "get output description");
                if (desc.Monitor != monitor || !desc.AttachedToDesktop) {
                    continue;
                }
                require(desc.Rotation == DXGI_MODE_ROTATION_IDENTITY, "unrotated display");
                check(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                                        &device_, nullptr, &context_), "D3D11CreateDevice");
                ComPtr<IDXGIOutput1> output1;
                check(output.As(&output1), "IDXGIOutput1");
                check(output1->DuplicateOutput(device_.Get(), &duplication_), "DuplicateOutput");
                D3D11_TEXTURE2D_DESC staging{};
                staging.Width = side;
                staging.Height = side;
                staging.MipLevels = 1;
                staging.ArraySize = 1;
                staging.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
                staging.SampleDesc.Count = 1;
                staging.Usage = D3D11_USAGE_STAGING;
                staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                check(device_->CreateTexture2D(&staging, nullptr, &staging_), "CreateTexture2D");
                return;
            }
        }
        throw std::runtime_error("no attached DXGI output for target monitor");
    }

    unsigned matches(const void* bits, UINT stride) const {
        unsigned count = 0;
        const auto* pixels = static_cast<const std::uint8_t*>(bits);
        for (UINT y = 0; y < side; ++y) {
            for (UINT x = 0; x < side; ++x) {
                const auto* pixel = pixels + y * stride + x * 4;
                if (std::abs(pixel[0] - blue_) <= tolerance_ &&
                    std::abs(pixel[1] - green_) <= tolerance_ &&
                    std::abs(pixel[2] - red_) <= tolerance_) {
                    ++count;
                }
            }
        }
        return count;
    }

    void close_gdi() {
        if (selected_ && selected_ != HGDI_ERROR) SelectObject(buffer_, selected_);
        if (bitmap_) DeleteObject(bitmap_);
        if (buffer_) DeleteDC(buffer_);
        if (display_) ReleaseDC(nullptr, display_);
    }

    bool gdi_;
    int red_, green_, blue_, tolerance_;
    HDC display_ = nullptr, buffer_ = nullptr;
    HBITMAP bitmap_ = nullptr;
    HGDIOBJ selected_ = nullptr;
    void* bits_ = nullptr;
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> duplication_;
    ComPtr<ID3D11Texture2D> staging_;
    ComPtr<IDXGIResource> frame_;
    DXGI_OUTDUPL_FRAME_INFO frameInfo_{};
};

struct Click {
    long long received;
    POINT screen;
    POINT client;
    bool injected;
};

struct Input {
    HWND window;
    DWORD pid;
    RECT roi;
    RECT display;
    std::mutex mutex;
    std::condition_variable changed;
    std::optional<Click> click;
    bool stopping = false;
    bool busy = false;
    unsigned overlapping = 0;

    Input(HWND window, DWORD pid, RECT roi, RECT display)
        : window(window), pid(pid), roi(roi), display(display) {}

    bool foreground() const {
        DWORD owner = 0;
        return root_window(GetForegroundWindow()) == window && !IsIconic(window) &&
               GetWindowThreadProcessId(window, &owner) && owner == pid;
    }

    bool visible_at(POINT screen) const {
        return foreground() && root_window(WindowFromPoint(screen)) == window;
    }
};

Input* activeInput = nullptr;

LRESULT CALLBACK mouse_hook(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION && message == WM_LBUTTONDOWN) {
        const auto received = ticks();
        const auto& event = *reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
        Input& input = *activeInput;
        POINT client = event.pt;
        if (fits(event.pt, input.display) && input.visible_at(event.pt) &&
            ScreenToClient(input.window, &client) && fits(client, input.roi)) {
            std::lock_guard lock(input.mutex);
            if (input.busy) {
                ++input.overlapping;
            } else if (!input.stopping) {
                input.busy = true;
                input.click = Click{received, event.pt, client, (event.flags & LLMHF_INJECTED) != 0};
                input.changed.notify_one();
            }
        }
    }
    return CallNextHookEx(nullptr, code, message, data);
}

struct Trial {
    const char* status;
    Reading reading{};
    double maxPollMs = 0;
};

std::optional<Click> next_click(Input& input, Screen& screen, bool gdi) {
    while (true) {
        {
            std::unique_lock lock(input.mutex);
            if (gdi) input.changed.wait(lock, [&] { return input.click || input.stopping; });
            if (input.stopping) return std::nullopt;
            if (input.click) {
                auto result = input.click;
                input.click.reset();
                return result;
            }
        }
        // Drain desktop updates while idle. When a hook fires during AcquireNextFrame,
        // hand that frame to the observer before advancing to the next update.
        screen.discard_frame();
        screen.wait_frame(16);
    }
}

Trial observe(Screen& screen, const Input& input, const Click& click, bool gdi, long long frequency) {
    using namespace std::chrono;
    const auto deadline = steady_clock::now() + sampleTimeout;
    auto lastPoll = click.received;
    double maxPollMs = 0;
    do {
        POINT expected = click.client;
        if (!input.visible_at(click.screen) || !ClientToScreen(input.window, &expected) ||
            expected.x != click.screen.x || expected.y != click.screen.y) {
            return {"target_changed"};
        }
        if (auto reading = screen.sample(click.screen)) {
            if (gdi) {
                const auto pollMs = 1000.0 * (reading->observed - lastPoll) / frequency;
                maxPollMs = (std::max)(maxPollMs, pollMs);
                lastPoll = reading->observed;
            }
            if (reading->matched >= minimumPixels) {
                if (!input.visible_at(click.screen)) {
                    return {"target_changed"};
                }
                if (!gdi && reading->presented < click.received) {
                    return {"existing_mark", *reading};
                }
                return {reading->frames > 1 ? "coalesced" : "ok", *reading, maxPollMs};
            }
        }
        if (gdi) Sleep(1);
    } while (steady_clock::now() < deadline);
    return {"timeout", {}, maxPollMs};
}

class Csv {
public:
    explicit Csv(const std::filesystem::path& path)
        : file_(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL, nullptr)) {
        require(file_ != INVALID_HANDLE_VALUE, "create new CSV");
    }

    ~Csv() {
        CloseHandle(file_);
    }

    Csv(const Csv&) = delete;
    Csv& operator=(const Csv&) = delete;

    bool append(const std::string& row) {
        const auto size = static_cast<DWORD>(row.size());
        DWORD written = 0;
        return WriteFile(file_, row.data(), size, &written, nullptr) && written == size;
    }

private:
    HANDLE file_;
};

int benchmark(const Options& options) {
    const HWND window = target_window(options.pid, options.hwnd);
    RECT client{};
    require(GetClientRect(window, &client) && options.roi.right <= client.right &&
                options.roi.bottom <= client.bottom, "ROI inside target client");
    Screen screen(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), options.gdi,
                  options.rgb, options.tolerance);
    screen.probe();
    Input input(window, options.pid, options.roi, screen.bounds);
    LARGE_INTEGER frequency{};
    require(QueryPerformanceFrequency(&frequency), "QueryPerformanceFrequency");
    Csv csv(options.output);
    require(csv.append("sample,warmup,status,mode,injected,client_x,client_y,hook_qpc,"
                       "dxgi_present_qpc,readback_qpc,qpc_frequency,frames_accumulated,"
                       "matched_pixels,max_poll_ms,latency_ms\n"), "write CSV header");
    activeInput = &input;
    const auto hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_hook, GetModuleHandleW(nullptr), 0);
    require(hook != nullptr, "SetWindowsHookExW(WH_MOUSE_LL)");

    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!done) {
        UnhookWindowsHookEx(hook);
        throw std::runtime_error("CreateEventW failed");
    }
    int exitCode = 0;
    std::thread worker([&] {
        for (unsigned sample = 1; sample <= options.warmup + options.samples; ++sample) {
            std::optional<Click> accepted;
            try {
                accepted = next_click(input, screen, options.gdi);
            } catch (const std::exception& error) {
                std::cerr << error.what() << '\n';
                exitCode = 1;
                break;
            }
            if (!accepted) break;
            const auto click = *accepted;
            Trial result{};
            try {
                result = observe(screen, input, click, options.gdi, frequency.QuadPart);
            } catch (const std::exception& error) {
                std::cerr << error.what() << '\n';
                result.status = "capture_error";
                exitCode = 1;
            }
            const auto& reading = result.reading;
            const auto endpoint = options.gdi ? reading.observed : reading.presented;
            std::ostringstream row;
            row << sample << ',' << (sample <= options.warmup) << ',' << result.status << ','
                << (options.gdi ? "gdi" : "dxgi") << ',' << click.injected << ',' << click.client.x
                << ',' << click.client.y << ',' << click.received << ',' << reading.presented << ','
                << reading.observed << ',' << frequency.QuadPart << ',' << reading.frames << ','
                << reading.matched << ',' << std::fixed << std::setprecision(3) << result.maxPollMs
                << ',';
            if (endpoint >= click.received) {
                row << 1000.0 * (endpoint - click.received) / frequency.QuadPart;
            }
            row << '\n';
            if (!csv.append(row.str())) {
                std::cerr << "write CSV trial failed\n";
                exitCode = 1;
            }
            std::cerr << "Trial " << sample << ": " << result.status << '\n';
            {
                std::lock_guard lock(input.mutex);
                input.busy = false;
            }
            if (exitCode) break;
        }
        screen.discard_frame();
        SetEvent(done);
    });

    std::cerr << "Armed PID " << options.pid << ". Focus the target and click on clean canvas points.\n";
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(options.seconds);
    bool expired = false;
    while (true) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) {
            expired = true;
            break;
        }
        const auto result = MsgWaitForMultipleObjects(1, &done, FALSE, static_cast<DWORD>(remaining),
                                                      QS_ALLINPUT);
        if (result == WAIT_OBJECT_0) break;
        if (result == WAIT_TIMEOUT || result == WAIT_FAILED) {
            expired = true;
            break;
        }
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    UnhookWindowsHookEx(hook);
    {
        std::lock_guard lock(input.mutex);
        input.stopping = true;
        input.changed.notify_one();
    }
    worker.join();
    CloseHandle(done);
    if (input.overlapping) {
        std::cerr << "Ignored overlapping clicks: " << input.overlapping << '\n';
    }
    if (expired) std::cerr << "Run ended before reaching the requested trial count.\n";
    return exitCode || expired ? 1 : 0;
}

int devices() {
    UINT32 count = 0;
    require(GetPointerDevices(&count, nullptr), "count GetPointerDevices");
    require(count <= 256, "pointer device count");
    std::vector<POINTER_DEVICE_INFO> list(count);
    if (count) require(GetPointerDevices(&count, list.data()), "list GetPointerDevices");
    UINT32 pens = 0, touch = 0, pads = 0;
    for (const auto& device : list) {
        if (device.pointerDeviceType == POINTER_DEVICE_TYPE_EXTERNAL_PEN ||
            device.pointerDeviceType == POINTER_DEVICE_TYPE_INTEGRATED_PEN) ++pens;
        if (device.pointerDeviceType == POINTER_DEVICE_TYPE_TOUCH) ++touch;
        if (device.pointerDeviceType == POINTER_DEVICE_TYPE_TOUCH_PAD) ++pads;
    }
    std::cout << "pen_devices=" << pens << " touch_devices=" << touch
              << " touchpads=" << pads << " digitizer_flags=" << GetSystemMetrics(SM_DIGITIZER)
              << " simultaneous_touches=" << GetSystemMetrics(SM_MAXIMUMTOUCHES) << '\n';
    return 0;
}

int describe(DWORD pid, HWND hwnd) {
    const HWND window = target_window(pid, hwnd);
    RECT client{};
    POINT origin{};
    require(GetClientRect(window, &client) && ClientToScreen(window, &origin), "target geometry");
    MONITORINFO display{};
    display.cbSize = sizeof(display);
    require(GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &display),
            "target monitor");
    std::cout << "client_origin=" << origin.x << ',' << origin.y
              << " client_size=" << client.right << ',' << client.bottom
              << " dpi=" << GetDpiForWindow(window)
              << " monitor=" << display.rcMonitor.left << ',' << display.rcMonitor.top << ','
              << display.rcMonitor.right << ',' << display.rcMonitor.bottom << '\n';
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        const std::wstring first = argc >= 2 ? argv[1] : L"--help";
        if (first == L"--help") {
            std::cout << "windows-input-display --pid PID --out NEW.csv --roi X,Y,W,H --rgb RRGGBB\n"
                         "    [--samples 20] [--warmup 3] [--seconds 120] [--tolerance 16]\n"
                         "    [--mode dxgi|gdi] [--hwnd HWND]\n"
                         "windows-input-display --probe [dxgi|gdi]\n"
                         "windows-input-display --window PID [HWND]\n"
                         "windows-input-display --devices\n";
            return 0;
        }
        if (first == L"--window" && (argc == 3 || argc == 4)) {
            return describe(number(argv[2], MAXDWORD), argc == 4 ? window_handle(argv[3]) : nullptr);
        }
        if (first == L"--devices" && argc == 2) return devices();
        if (first == L"--probe" && argc <= 3) {
            const bool gdi = argc == 3 && gdi_mode(argv[2]);
            Screen screen(MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY), gdi, 0, 0);
            screen.probe();
            std::cout << (gdi ? "gdi desktop DC and staging available\n" : "dxgi desktop duplication available\n");
            return 0;
        }
        return benchmark(parse(argc, argv));
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
