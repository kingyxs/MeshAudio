#include "device_enumerator.h"
#include "mix_engine.h"
#include "wasapi_capture_source.h"
#include "wasapi_render_sink.h"
#include "windows_support.h"

#include <avrt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <limits>
#include <numbers>
#include <span>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr uint32_t kSampleRate = 48000;
constexpr uint32_t kChannels = 2;
constexpr uint32_t kToneBlockFrames = 480;
constexpr uint32_t kMaxInputFrames = 1'048'576;

std::string json_escape(const std::string& value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (const unsigned char character : value) {
    switch (character) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (character < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          result += "\\u00";
          result += hex[character >> 4];
          result += hex[character & 0x0f];
        } else {
          result += static_cast<char>(character);
        }
    }
  }
  return result;
}

void print_capabilities() {
  std::cout << "{\"wasapi_render\":true,\"wasapi_capture\":true,\"shared_mode\":true,"
               "\"virtual_capture_available\":false,"
               "\"virtual_capture_diagnostic\":\"No virtual capture driver/device is included; install a separately signed virtual audio driver to expose a recording endpoint.\"}"
            << std::endl;
}

const char* flow_name(meshaudio::AudioDataFlow flow) {
  return flow == meshaudio::AudioDataFlow::Render ? "render" : "capture";
}

void print_device_json(const meshaudio::AudioDevice& device) {
  std::cout << "{\"id\":\"" << json_escape(meshaudio::detail::wide_to_utf8(device.id))
            << "\",\"name\":\"" << json_escape(meshaudio::detail::wide_to_utf8(device.name))
            << "\",\"data_flow\":\"" << flow_name(device.data_flow)
            << "\",\"default\":" << (device.is_default ? "true" : "false") << "}" << std::endl;
}

int list_endpoints() {
  std::vector<meshaudio::AudioDevice> renders;
  std::vector<meshaudio::AudioDevice> captures;
  std::string error;
  if (!meshaudio::enumerate_audio_devices(meshaudio::AudioDataFlow::Render, renders, error)) {
    std::cerr << "error: " << error << '\n';
    return 2;
  }
  if (!meshaudio::enumerate_audio_devices(meshaudio::AudioDataFlow::Capture, captures, error)) {
    std::cerr << "error: " << error << '\n';
    return 2;
  }
  std::cout << "{\"type\":\"endpoints\",\"render_count\":" << renders.size()
            << ",\"capture_count\":" << captures.size() << ",\"devices\":[";
  bool first = true;
  for (const auto& device : renders) {
    if (!first) std::cout << ',';
    first = false;
    std::cout << "{\"id\":\"" << json_escape(meshaudio::detail::wide_to_utf8(device.id))
              << "\",\"name\":\"" << json_escape(meshaudio::detail::wide_to_utf8(device.name))
              << "\",\"data_flow\":\"render\",\"default\":" << (device.is_default ? "true" : "false") << "}";
  }
  for (const auto& device : captures) {
    if (!first) std::cout << ',';
    first = false;
    std::cout << "{\"id\":\"" << json_escape(meshaudio::detail::wide_to_utf8(device.id))
              << "\",\"name\":\"" << json_escape(meshaudio::detail::wide_to_utf8(device.name))
              << "\",\"data_flow\":\"capture\",\"default\":" << (device.is_default ? "true" : "false") << "}";
  }
  std::cout << "]}" << std::endl;
  return 0;
}

bool contains_ci(const std::wstring& value, const wchar_t* needle) {
  std::wstring lowered = value;
  std::wstring target = needle;
  for (auto& character : lowered) character = static_cast<wchar_t>(::towlower(character));
  for (auto& character : target) character = static_cast<wchar_t>(::towlower(character));
  return lowered.find(target) != std::wstring::npos;
}

bool is_cable_id(const std::wstring& id) {
  return contains_ci(id, L"vb-audio") || contains_ci(id, L"vb-cable") || contains_ci(id, L"cable");
}

int detect_vbcable() {
  std::vector<meshaudio::AudioDevice> renders;
  std::vector<meshaudio::AudioDevice> captures;
  std::string error;
  if (!meshaudio::enumerate_audio_devices(meshaudio::AudioDataFlow::Render, renders, error) ||
      !meshaudio::enumerate_audio_devices(meshaudio::AudioDataFlow::Capture, captures, error)) {
    std::cout << "{\"type\":\"vb_cable_detection\",\"available\":false,\"diagnostic\":\""
              << json_escape(error) << "\"}" << std::endl;
    return 2;
  }
  std::vector<const meshaudio::AudioDevice*> inputs;
  std::vector<const meshaudio::AudioDevice*> outputs;
  for (const auto& device : renders) {
    if (contains_ci(device.name, L"cable input") && (is_cable_id(device.id) || contains_ci(device.name, L"vb-audio"))) inputs.push_back(&device);
  }
  for (const auto& device : captures) {
    if (contains_ci(device.name, L"cable output") && (is_cable_id(device.id) || contains_ci(device.name, L"vb-audio"))) outputs.push_back(&device);
  }
  const bool available = inputs.size() == 1 && outputs.size() == 1;
  std::string diagnostic;
  if (available) {
    diagnostic = "VB-CABLE render input and capture output endpoints detected.";
  } else if (inputs.empty() && outputs.empty()) {
    diagnostic = "VB-CABLE was not detected. Install and enable the external VB-CABLE driver; MeshAudio does not install or emulate audio devices.";
  } else {
    diagnostic = "VB-CABLE detection is incomplete or ambiguous; expected exactly one CABLE Input render endpoint and one CABLE Output capture endpoint with a cable device ID.";
  }
  std::cout << "{\"type\":\"vb_cable_detection\",\"available\":" << (available ? "true" : "false")
            << ",\"diagnostic\":\"" << json_escape(diagnostic) << "\",\"render_input\":";
  if (inputs.size() == 1) print_device_json(*inputs.front()); else std::cout << "null";
  std::cout << ",\"capture_output\":";
  if (outputs.size() == 1) print_device_json(*outputs.front()); else std::cout << "null";
  std::cout << "}" << std::endl;
  return available ? 0 : 3;
}

int list_devices() {
  std::vector<meshaudio::AudioDevice> devices;
  std::string error;
  if (!meshaudio::enumerate_render_devices(devices, error)) {
    std::cerr << "error: " << error << '\n';
    return 2;
  }

  print_capabilities();
  for (const auto& device : devices) {
    print_device_json(device);
  }
  if (devices.empty()) {
    std::cerr << "status: no active render endpoints were found.\n";
  }
  return 0;
}

bool parse_unsigned(const wchar_t* text, uint32_t minimum, uint32_t maximum, uint32_t& value) {
  if (text == nullptr || text[0] == L'\0' || text[0] == L'-') {
    return false;
  }
  wchar_t* end = nullptr;
  const unsigned long parsed = std::wcstoul(text, &end, 10);
  if (end == text || *end != L'\0' || parsed < minimum || parsed > maximum) {
    return false;
  }
  value = static_cast<uint32_t>(parsed);
  return true;
}

bool parse_frequency(const wchar_t* text, double& frequency) {
  if (text == nullptr || text[0] == L'\0') {
    return false;
  }
  wchar_t* end = nullptr;
  const double parsed = std::wcstod(text, &end);
  if (end == text || *end != L'\0' || !std::isfinite(parsed) || parsed < 1.0 || parsed >= kSampleRate / 2.0) {
    return false;
  }
  frequency = parsed;
  return true;
}

bool open_sink(meshaudio::WasapiRenderSink& sink, const std::wstring& device_id,
               const meshaudio::AudioFormat& format) {
  const wchar_t* requested_id = device_id.empty() ? nullptr : device_id.c_str();
  if (!sink.open(format, requested_id)) {
    std::cerr << "error: " << sink.last_error() << '\n';
    return false;
  }
  return true;
}

bool read_exact(char* destination, size_t bytes) {
  std::cin.read(destination, static_cast<std::streamsize>(bytes));
  return static_cast<size_t>(std::cin.gcount()) == bytes;
}

uint16_t read_u16_le(const unsigned char* value) {
  return static_cast<uint16_t>(value[0] | (static_cast<uint16_t>(value[1]) << 8));
}

uint32_t read_u32_le(const unsigned char* value) {
  return static_cast<uint32_t>(value[0]) | (static_cast<uint32_t>(value[1]) << 8) |
         (static_cast<uint32_t>(value[2]) << 16) | (static_cast<uint32_t>(value[3]) << 24);
}

// RAII wrapper for MMCSS scheduling and thread priority. Design inspired by the
// Foundation Sunshine reference project, whose audio capture thread joins the
// "Pro Audio" MMCSS task so the Windows scheduler treats the audio loop as a
// real-time workload even while the host process is otherwise busy.
class AudioThreadProfile {
public:
  AudioThreadProfile() {
    task_index_ = 0;
    mmcss_handle_ = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index_);
    priority_raised_ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) != FALSE;
  }

  ~AudioThreadProfile() {
    if (mmcss_handle_ != nullptr) {
      AvRevertMmThreadCharacteristics(mmcss_handle_);
    }
    if (priority_raised_) {
      SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
    }
  }

  AudioThreadProfile(const AudioThreadProfile&) = delete;
  AudioThreadProfile& operator=(const AudioThreadProfile&) = delete;

  bool okay() const { return mmcss_handle_ != nullptr; }

private:
  DWORD task_index_ = 0;
  HANDLE mmcss_handle_ = nullptr;
  bool priority_raised_ = false;
};

int play_probe(const std::wstring& device_id, uint32_t duration_ms, double frequency) {
  AudioThreadProfile thread_profile;
  meshaudio::WasapiRenderSink sink;
  if (!open_sink(sink, device_id, {kSampleRate, kChannels})) return 2;
  std::cout << "status: playing deterministic " << frequency << " Hz tone for " << duration_ms
            << " ms at " << kSampleRate << " Hz, stereo; Ctrl+C to stop.\n";
  const uint64_t total_frames = (static_cast<uint64_t>(duration_ms) * kSampleRate + 999) / 1000;
  std::vector<float> samples(kToneBlockFrames * kChannels);
  uint64_t frame_offset = 0;
  while (frame_offset < total_frames) {
    const uint32_t frames = static_cast<uint32_t>(std::min<uint64_t>(kToneBlockFrames, total_frames - frame_offset));
    for (uint32_t frame = 0; frame < frames; ++frame) {
      const double phase = 2.0 * std::numbers::pi * frequency * (frame_offset + frame) / kSampleRate;
      const float sample = static_cast<float>(std::sin(phase) * 0.2);
      samples[frame * kChannels] = sample;
      samples[frame * kChannels + 1] = sample;
    }
    if (!sink.write(std::span<const float>(samples.data(), static_cast<size_t>(frames) * kChannels))) {
      std::cerr << "error: " << sink.last_error() << '\n';
      return 2;
    }
    frame_offset += frames;
  }
  if (!sink.drain()) {
    std::cerr << "error: " << sink.last_error() << '\n';
    return 2;
  }
  std::cerr << "{\"type\":\"probe.stats\",\"renderUnderruns\":" << sink.underruns()
            << ",\"bufferFrames\":" << sink.buffer_frames()
            << ",\"enginePeriodFrames\":" << sink.engine_period_frames() << "}" << std::endl;
  sink.close();
  std::cout << "status: probe completed.\n";
  return 0;
}

double steady_ms() {
  using clock = std::chrono::steady_clock;
  static const auto start = clock::now();
  return std::chrono::duration<double, std::milli>(clock::now() - start).count();
}

// Capture mode: prints one JSON line describing the endpoint, then streams
// interleaved S16LE to stdout. A consumer that closes the pipe ends the loop,
// which is how the Node side stops it.
int run_capture(const std::wstring& device_id, bool info_only, uint32_t duration_ms) {
  meshaudio::WasapiCaptureSource source;
  std::string error;
  if (!source.open(device_id.empty() ? nullptr : device_id.c_str(), error)) {
    std::cerr << "error: " << error << '\n';
    return 2;
  }

  const meshaudio::CaptureFormat format = source.format();
  std::ostringstream info;
  info << "{\"type\":\"capture-info\",\"sampleRate\":" << format.sample_rate
       << ",\"channels\":" << format.channels
       << ",\"encoding\":\"s16le\",\"sourceEncoding\":\"" << format.source_encoding << "\"}";
  if (info_only) {
    std::cout << info.str() << std::endl;
    source.close();
    return 0;
  }
  // Streaming mode keeps stdout byte-exact PCM: the descriptor goes to stderr so
  // a redirect to a file never gets a text header mixed into the samples.
  std::cerr << info.str() << std::endl;

  if (!source.start(error)) {
    std::cerr << "error: " << error << '\n';
    source.close();
    return 2;
  }

  AudioThreadProfile thread_profile;
  if (!thread_profile.okay()) {
    std::cerr << "warning: could not join the Pro Audio MMCSS task; capture loop keeps default scheduling.\n";
  }

  std::cout.flush();
  _setmode(_fileno(stdout), _O_BINARY);

  std::vector<int16_t> block;
  const double started_at = steady_ms();
  while (duration_ms == 0 || steady_ms() - started_at < duration_ms) {
    block.clear();
    if (!source.read(block, 200, error)) {
      std::cerr << "error: " << error << '\n';
      source.close();
      return 2;
    }
    if (block.empty()) continue;

    const size_t bytes = block.size() * sizeof(int16_t);
    if (std::fwrite(block.data(), 1, bytes, stdout) != bytes) {
      // The reader disappeared; exit quietly so a restarted bridge is not
      // fighting a stale capture process.
      source.close();
      return 0;
    }
    std::fflush(stdout);
  }

  std::cerr << "{\"type\":\"capture.stats\",\"discontinuities\":" << source.discontinuities()
            << ",\"missingFrames\":" << source.missing_frames() << "}" << std::endl;
  source.close();
  return 0;
}

uint64_t read_u64_le(const unsigned char* value) {
  return static_cast<uint64_t>(read_u32_le(value)) |
         (static_cast<uint64_t>(read_u32_le(value + 4)) << 32);
}

float read_f32_le(const unsigned char* value) {
  float result = 0.0f;
  std::memcpy(&result, value, sizeof(result));
  return result;
}

// MSMP v1 config record. Layout (little-endian):
//   u16 version | u16 channels | u32 sampleRate | u16 sourceCount | u16 busCount
//   sources: u32 hash | f32 gain | u8 muted | u8 stopped | u16 reserved | u64 busMask
//   buses:   f32 gain | u8 muted | u8 pad[3]
bool apply_engine_config(meshaudio::MixEngine& engine, const unsigned char* data, size_t size,
                         uint32_t channels, uint32_t sample_rate) {
  if (size < 12 || read_u16_le(data) != 1) return false;
  if (read_u16_le(data + 2) != channels || read_u32_le(data + 4) != sample_rate) return false;
  const uint16_t source_count = read_u16_le(data + 8);
  const uint16_t bus_count = read_u16_le(data + 10);
  const size_t required = 12 + static_cast<size_t>(source_count) * 20 + static_cast<size_t>(bus_count) * 8;
  if (size < required) return false;

  meshaudio::MixEngine::Config config;
  config.bus_gains.assign(bus_count, 1.0f);
  config.bus_muted.assign(bus_count, false);
  const unsigned char* cursor = data + 12;
  for (uint16_t index = 0; index < source_count; ++index) {
    meshaudio::MixEngine::SourceSettings settings;
    settings.hash = read_u32_le(cursor);
    settings.gain = read_f32_le(cursor + 4);
    settings.muted = cursor[8] != 0;
    settings.stopped = cursor[9] != 0;
    // Per-source flags: bit 0 = voice chain, bit 1 = voice enhanced (DeepVQE-S).
    const uint16_t flags = read_u16_le(cursor + 10);
    settings.voice = (flags & 0x1) != 0;
    settings.voice_enhanced = (flags & 0x2) != 0;
    settings.bus_mask = read_u64_le(cursor + 12);
    config.sources.push_back(settings);
    cursor += 20;
  }
  for (uint16_t index = 0; index < bus_count; ++index) {
    config.bus_gains[index] = read_f32_le(cursor);
    config.bus_muted[index] = cursor[4] != 0;
    cursor += 8;
  }
  engine.applyConfig(config);
  return true;
}

// Engine mode: the helper owns the mixer and jitter buffers. Node forwards raw
// per-source PCM and the route/gain configuration; this thread renders exactly
// one WASAPI engine period at a time, so production is paced by the device
// clock rather than by a host timer.
// Writes the rendered mix to a 16-bit WAV file instead of a device. This exists
// so the resampler can be checked objectively: a dropped sample shows up as a
// sample-to-sample step far larger than the signal's own slope, which is exactly
// what the old "skip a frame" clock compensation produced (audible buzz).
class WavSink {
public:
  bool open(const std::wstring& path, uint32_t rate, uint32_t channels) {
    if (_wfopen_s(&file_, path.c_str(), L"wb") != 0) {
      file_ = nullptr;
      return false;
    }
    channels_ = channels;
    unsigned char header[44] {};
    std::memcpy(header, "RIFF", 4);
    write_u32(header + 4, 36);
    std::memcpy(header + 8, "WAVE", 4);
    std::memcpy(header + 12, "fmt ", 4);
    write_u32(header + 16, 16);
    write_u16(header + 20, 1);
    write_u16(header + 22, static_cast<uint16_t>(channels));
    write_u32(header + 24, rate);
    write_u32(header + 28, rate * channels * 2);
    write_u16(header + 32, static_cast<uint16_t>(channels * 2));
    write_u16(header + 34, 16);
    std::memcpy(header + 36, "data", 4);
    write_u32(header + 40, 0);
    return std::fwrite(header, 1, sizeof(header), file_) == sizeof(header);
  }

  void write(const float* interleaved, uint32_t frames) {
    if (file_ == nullptr) return;
    converted_.resize(static_cast<size_t>(frames) * channels_);
    for (size_t index = 0; index < converted_.size(); ++index) {
      const float clamped = std::max(-1.0f, std::min(1.0f, interleaved[index]));
      converted_[index] = static_cast<int16_t>(std::lround(clamped * 32767.0f));
    }
    std::fwrite(converted_.data(), sizeof(int16_t), converted_.size(), file_);
    data_bytes_ += static_cast<uint32_t>(converted_.size() * sizeof(int16_t));
  }

  void close() {
    if (file_ == nullptr) return;
    unsigned char buffer[4];
    std::fseek(file_, 4, SEEK_SET);
    write_u32(buffer, 36 + data_bytes_);
    std::fwrite(buffer, 1, 4, file_);
    std::fseek(file_, 40, SEEK_SET);
    write_u32(buffer, data_bytes_);
    std::fwrite(buffer, 1, 4, file_);
    std::fclose(file_);
    file_ = nullptr;
  }

private:
  static void write_u16(unsigned char* destination, uint16_t value) {
    destination[0] = static_cast<unsigned char>(value & 0xff);
    destination[1] = static_cast<unsigned char>((value >> 8) & 0xff);
  }
  static void write_u32(unsigned char* destination, uint32_t value) {
    for (int index = 0; index < 4; ++index) {
      destination[index] = static_cast<unsigned char>((value >> (8 * index)) & 0xff);
    }
  }

  FILE* file_ = nullptr;
  uint32_t channels_ = 2;
  uint32_t data_bytes_ = 0;
  std::vector<int16_t> converted_;
};

int run_engine(const std::wstring& device_id, const std::wstring& wav_path, double target_ms) {
  unsigned char header[16] {};
  if (!read_exact(reinterpret_cast<char*>(header), sizeof(header))) {
    std::cerr << "error: stdin ended before the 16-byte MSMP header.\n";
    return 2;
  }
  if (std::memcmp(header, "MSMP", 4) != 0 || read_u16_le(header + 4) != 1) {
    std::cerr << "error: invalid MSMP header; expected version 1.\n";
    return 2;
  }
  const uint32_t channels = read_u16_le(header + 6);
  const uint32_t sample_rate = read_u32_le(header + 8);
  if (channels == 0 || channels > 8 || sample_rate < 8000 || sample_rate > 384000) {
    std::cerr << "error: invalid MSMP format; expected 8000..384000 Hz, 1..8 channels.\n";
    return 2;
  }

  const bool to_file = !wav_path.empty();
  meshaudio::WasapiRenderSink sink;
  WavSink wav;
  AudioThreadProfile thread_profile;
  double period_ms = 0.0;
  if (to_file) {
    if (!wav.open(wav_path, sample_rate, channels)) {
      std::cerr << "error: could not open the WAV output file.\n";
      return 2;
    }
    period_ms = 128.0 * 1000.0 / sample_rate;
    std::cout << "status: WAV sink, engine period " << period_ms << " ms.\n";
  } else {
    if (!open_sink(sink, device_id, {sample_rate, channels})) {
      return 2;
    }
    if (!thread_profile.okay()) {
      std::cerr << "warning: could not join the Pro Audio MMCSS task; render loop keeps default scheduling.\n";
    }
    period_ms = sink.engine_period_frames() * 1000.0 / sample_rate;
    const double buffer_ms = sink.buffer_frames() * 1000.0 / sample_rate;
    std::cout << "status: WASAPI " << (sink.low_latency_shared() ? "low-latency shared" : "shared")
              << " mode, engine period " << period_ms << " ms, buffer " << buffer_ms << " ms.\n";
  }
  std::cout << "status: engine mode (MSMP v1); mixing " << channels << " channels at " << sample_rate
            << " Hz in the helper.\n";

  meshaudio::MixEngine engine(channels, sample_rate);
  // The jitter target has to cover the render cadence: a block is produced from
  // a queue that must already hold at least one block. Endpoints that do not
  // support the low-latency path run a 10 ms engine period, so the 15 ms default
  // would leave less than two blocks of margin and starve on every hiccup.
  // Keep a small scheduling reserve for the Windows/Node reader as well as
  // packet jitter. --target-ms remains the explicit field override; display
  // refreshes never change this target.
  const double margin_ms = target_ms > 0.0 ? target_ms : 40.0;
  engine.setTargetMs(std::max(margin_ms, period_ms * 2.5));
  std::atomic<bool> running { true };

  std::thread reader([&engine, &running, channels, sample_rate]() {
    std::vector<unsigned char> payload;
    std::vector<float> pcm;
    while (running.load()) {
      unsigned char record[8] {};
      if (!read_exact(reinterpret_cast<char*>(record), sizeof(record))) break;
      const std::string tag(reinterpret_cast<char*>(record), 4);
      const uint32_t length = read_u32_le(record + 4);
      if (length > 16u * 1024u * 1024u) break;
      payload.resize(length);
      if (length > 0 && !read_exact(reinterpret_cast<char*>(payload.data()), length)) break;
      if (tag == "MCFG") {
        apply_engine_config(engine, payload.data(), payload.size(), channels, sample_rate);
        continue;
      }
      if (tag == "PCM ") {
        if (length < 16) continue;
        const uint32_t hash = read_u32_le(payload.data());
        const uint32_t sequence = read_u32_le(payload.data() + 4);
        const uint32_t frames = read_u32_le(payload.data() + 8);
        const size_t samples = static_cast<size_t>(frames) * channels;
        if (frames == 0 || length < 16 + samples * sizeof(float)) continue;
        pcm.resize(samples);
        std::memcpy(pcm.data(), payload.data() + 16, samples * sizeof(float));
        engine.push(hash, sequence, pcm.data(), frames, steady_ms());
        continue;
      }
      if (tag == "END ") break;
    }
    running.store(false);
  });
  reader.detach();

  const uint32_t period = to_file
    ? 128
    : (sink.engine_period_frames() > 0 ? sink.engine_period_frames()
                                       : std::max<uint32_t>(128, sample_rate / 200));
  std::vector<float> block(static_cast<size_t>(period) * channels);
  auto next_deadline = std::chrono::steady_clock::now();
  // Observability must not format JSON or wait for stdout on the WASAPI
  // render thread. A blocked consumer may delay metrics, never device writes.
  std::thread reporter([&engine, &sink, &running]() {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (running.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      if (!running.load()) break;
      if (std::chrono::steady_clock::now() >= deadline) {
        std::string stats = engine.statsJson();
        stats.pop_back();
        std::cout << stats << ",\"renderUnderruns\":" << sink.underruns() << "}" << std::endl;
        deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
      }
    }
  });
  int exit_code = 0;
  while (running.load()) {
    engine.render(block.data(), period, steady_ms());
    if (to_file) {
      // Pace the file sink at the same cadence as the audio device so the
      // engine sees realistic arrival versus consumption timing.
      wav.write(block.data(), period);
      next_deadline += std::chrono::microseconds(static_cast<int64_t>(period_ms * 1000.0));
      std::this_thread::sleep_until(next_deadline);
    } else if (!sink.write(std::span<const float>(block.data(), block.size()))) {
      std::cerr << "error: " << sink.last_error() << '\n';
      exit_code = 2;
      break;
    }
  }
  running.store(false);
  reporter.join();
  if (to_file) {
    wav.close();
  } else {
    sink.drain();
    sink.close();
  }
  std::cout << "status: engine playback completed.\n";
  std::cout.flush();
  std::cerr.flush();
  // The reader thread may still be blocked on stdin; skip static teardown so
  // process exit cannot race with it.
  std::_Exit(exit_code);
}

int play_stdin(const std::wstring& device_id) {
  unsigned char header[16]{};
  if (!read_exact(reinterpret_cast<char*>(header), sizeof(header))) {
    std::cerr << "error: stdin ended before the 16-byte MAPC header.\n";
    return 2;
  }
  if (std::string(reinterpret_cast<char*>(header), 4) != "MAPC" || read_u16_le(header + 4) != 1 ||
      read_u16_le(header + 6) == 0 || read_u16_le(header + 6) > 8 || read_u32_le(header + 8) < 8000 ||
      read_u32_le(header + 8) > 384000 || read_u32_le(header + 12) != 0) {
    std::cerr << "error: invalid MAPC v1 header; expected float32 PCM, 8000..384000 Hz, 1..8 channels, reserved=0.\n";
    return 2;
  }
  const meshaudio::AudioFormat format{read_u32_le(header + 8), read_u16_le(header + 6)};

  meshaudio::WasapiRenderSink sink;
  if (!open_sink(sink, device_id, format)) {
    return 2;
  }
  AudioThreadProfile thread_profile;
  if (!thread_profile.okay()) {
    std::cerr << "warning: could not join the Pro Audio MMCSS task; render loop keeps default scheduling.\n";
  }
  const double period_ms = sink.engine_period_frames() * 1000.0 / format.sample_rate;
  const double buffer_ms = sink.buffer_frames() * 1000.0 / format.sample_rate;
  std::cout << "status: WASAPI " << (sink.low_latency_shared() ? "low-latency shared" : "shared")
            << " mode, engine period " << period_ms << " ms, buffer " << buffer_ms << " ms.\n";
  std::cout << "status: reading MAPC v1 float32 PCM on stdin; a zero frame count ends playback.\n";

  std::vector<float> samples;
  while (true) {
    unsigned char frame_header[4]{};
    if (!read_exact(reinterpret_cast<char*>(frame_header), sizeof(frame_header))) {
      std::cerr << "error: stdin ended without a zero-frame terminator.\n";
      return 2;
    }
    const uint32_t frames = read_u32_le(frame_header);
    if (frames == 0) {
      break;
    }
    if (frames > kMaxInputFrames) {
      std::cerr << "error: PCM frame block exceeds the 1,048,576-frame limit.\n";
      return 2;
    }
    const size_t sample_count = static_cast<size_t>(frames) * format.channels;
    samples.resize(sample_count);
    if (!read_exact(reinterpret_cast<char*>(samples.data()), sample_count * sizeof(float))) {
      std::cerr << "error: stdin ended in the middle of a PCM frame block.\n";
      return 2;
    }
    if (!sink.write(samples)) {
      std::cerr << "error: " << sink.last_error() << '\n';
      return 2;
    }
  }
  if (!sink.drain()) {
    std::cerr << "error: " << sink.last_error() << '\n';
    return 2;
  }
  sink.close();
  std::cout << "status: stdin PCM playback completed.\n";
  return 0;
}

void print_usage() {
  std::cout << "MeshAudio Windows native audio helper\n"
               "Usage:\n"
               "  meshaudio-native.exe --list-devices\n"
               "  meshaudio-native.exe --list-endpoints\n"
               "  meshaudio-native.exe --detect-vbcable\n"
               "  meshaudio-native.exe --probe [--device ID] [--duration-ms N] [--frequency HZ]\n"
               "  meshaudio-native.exe --stdin-pcm [--device ID]\n"
               "  meshaudio-native.exe --capture-info [--device ID]\n"
               "  meshaudio-native.exe --capture [--device ID] [--duration-ms N]\n"
               "  meshaudio-native.exe --engine [--device ID] [--wav PATH] [--target-ms N]\n"
               "  meshaudio-native.exe --help\n";
}

}

int wmain(int argc, wchar_t* argv[]) {
  // PCM input must never flush or wait for the statistics output stream.
  // cin is tied to cout by default, which couples every binary read to stdout.
  std::cin.tie(nullptr);
  _setmode(_fileno(stdin), _O_BINARY);
  if (argc < 2 || std::wstring(argv[1]) == L"--help" || std::wstring(argv[1]) == L"-h") {
    print_usage();
    return argc < 2 ? 1 : 0;
  }

  const std::wstring mode = argv[1];
  if (mode == L"--capabilities") {
    print_capabilities();
    return 0;
  }
  if (mode == L"--list-devices") {
    return list_devices();
  }
  if (mode == L"--list-endpoints") {
    return list_endpoints();
  }
  if (mode == L"--detect-vbcable") {
    return detect_vbcable();
  }
  if (mode != L"--probe" && mode != L"--stdin-pcm" && mode != L"--engine" &&
      mode != L"--capture" && mode != L"--capture-info") {
    std::cerr << "error: unknown mode.\n";
    print_usage();
    return 1;
  }

  std::wstring device_id;
  std::wstring wav_path;
  double target_ms = 0.0;
  // Capture runs until its consumer goes away; probe keeps the 1 s default.
  uint32_t duration_ms = mode == L"--capture" ? 0 : 1000;
  double frequency = 440.0;
  for (int index = 2; index < argc; ++index) {
    const std::wstring option = argv[index];
    if (option == L"--device" && index + 1 < argc) {
      device_id = argv[++index];
    } else if (option == L"--duration-ms" && (mode == L"--probe" || mode == L"--capture") && index + 1 < argc) {
      if (!parse_unsigned(argv[++index], 1, 600000, duration_ms)) {
        std::cerr << "error: --duration-ms must be between 1 and 600000.\n";
        return 1;
      }
    } else if (option == L"--wav" && mode == L"--engine" && index + 1 < argc) {
      wav_path = argv[++index];
    } else if (option == L"--target-ms" && mode == L"--engine" && index + 1 < argc) {
      double parsed = 0.0;
      if (!parse_frequency(argv[++index], parsed) || parsed > 500.0) {
        std::cerr << "error: --target-ms must be between 1 and 500.\n";
        return 1;
      }
      target_ms = parsed;
    } else if (option == L"--frequency" && mode == L"--probe" && index + 1 < argc) {
      if (!parse_frequency(argv[++index], frequency)) {
        std::cerr << "error: --frequency must be >=1 and below the 24000 Hz Nyquist limit.\n";
        return 1;
      }
    } else {
      std::cerr << "error: invalid or incomplete option.\n";
      print_usage();
      return 1;
    }
  }

  if (mode == L"--capture-info") {
    return run_capture(device_id, true, 0);
  }
  if (mode == L"--capture") {
    return run_capture(device_id, false, duration_ms);
  }
  if (mode == L"--probe") {
    return play_probe(device_id, duration_ms, frequency);
  }
  if (mode == L"--engine") {
    return run_engine(device_id, wav_path, target_ms);
  }
  return play_stdin(device_id);
}
