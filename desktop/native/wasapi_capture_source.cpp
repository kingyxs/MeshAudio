#include "wasapi_capture_source.h"

#include "windows_support.h"

#include <audioclient.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <vector>

namespace meshaudio {
namespace {

using Microsoft::WRL::ComPtr;

struct WaveFormatDeleter {
  void operator()(WAVEFORMATEX* format) const { CoTaskMemFree(format); }
};

enum class SampleEncoding { Float32, PcmUnsigned8, PcmSigned16, PcmSigned24, PcmSigned32 };

bool describe_format(const WAVEFORMATEX* format, SampleEncoding& encoding, std::string& name,
                     std::string& error) {
  if (format == nullptr || format->nChannels == 0 || format->nSamplesPerSec == 0) {
    error = "The capture endpoint returned an invalid WASAPI mix format.";
    return false;
  }

  bool is_float = false;
  bool is_pcm = false;
  if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    if (format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
      error = "The capture endpoint returned a truncated WAVEFORMATEXTENSIBLE format.";
      return false;
    }
    const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
    is_float = IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) != FALSE;
    is_pcm = IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_PCM) != FALSE;
  } else {
    is_float = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    is_pcm = format->wFormatTag == WAVE_FORMAT_PCM;
  }

  if (is_float && format->wBitsPerSample == 32) {
    encoding = SampleEncoding::Float32;
    name = "f32le";
  } else if (is_pcm && format->wBitsPerSample == 8) {
    encoding = SampleEncoding::PcmUnsigned8;
    name = "u8";
  } else if (is_pcm && format->wBitsPerSample == 16) {
    encoding = SampleEncoding::PcmSigned16;
    name = "s16le";
  } else if (is_pcm && format->wBitsPerSample == 24) {
    encoding = SampleEncoding::PcmSigned24;
    name = "s24le";
  } else if (is_pcm && format->wBitsPerSample == 32) {
    encoding = SampleEncoding::PcmSigned32;
    name = "s32le";
  } else {
    error = "Unsupported capture mix format: " + std::to_string(format->wBitsPerSample) +
            "-bit samples, format tag " + std::to_string(format->wFormatTag) + ".";
    return false;
  }

  if (format->nBlockAlign < format->nChannels * (format->wBitsPerSample / 8)) {
    error = "The capture endpoint mix format has an invalid block alignment.";
    return false;
  }
  return true;
}

inline int16_t to_s16(float value) {
  if (!std::isfinite(value)) return 0;
  const float clamped = std::clamp(value, -1.0f, 1.0f);
  const long rounded = std::lround(clamped < 0.0f ? clamped * 32768.0f : clamped * 32767.0f);
  return static_cast<int16_t>(std::clamp<long>(rounded, -32768, 32767));
}

void convert_packet(const BYTE* data, UINT32 frames, UINT32 channels, SampleEncoding encoding,
                    std::vector<int16_t>& out) {
  const size_t count = static_cast<size_t>(frames) * channels;
  const size_t offset = out.size();
  out.resize(offset + count);

  switch (encoding) {
    case SampleEncoding::Float32: {
      const auto* source = reinterpret_cast<const float*>(data);
      for (size_t index = 0; index < count; ++index) out[offset + index] = to_s16(source[index]);
      break;
    }
    case SampleEncoding::PcmSigned16: {
      std::memcpy(out.data() + offset, data, count * sizeof(int16_t));
      break;
    }
    case SampleEncoding::PcmUnsigned8: {
      for (size_t index = 0; index < count; ++index) {
        out[offset + index] = static_cast<int16_t>((static_cast<int>(data[index]) - 128) << 8);
      }
      break;
    }
    case SampleEncoding::PcmSigned24: {
      for (size_t index = 0; index < count; ++index) {
        const BYTE* sample = data + index * 3;
        const int32_t value = static_cast<int32_t>(
            (static_cast<uint32_t>(sample[0]) << 8) | (static_cast<uint32_t>(sample[1]) << 16) |
            (static_cast<uint32_t>(sample[2]) << 24));
        out[offset + index] = static_cast<int16_t>(value >> 16);
      }
      break;
    }
    case SampleEncoding::PcmSigned32: {
      const auto* source = reinterpret_cast<const int32_t*>(data);
      for (size_t index = 0; index < count; ++index) {
        out[offset + index] = static_cast<int16_t>(source[index] >> 16);
      }
      break;
    }
  }
}

}

struct WasapiCaptureSource::Impl {
  detail::ComApartment apartment;
  ComPtr<IMMDeviceEnumerator> enumerator;
  ComPtr<IMMDevice> device;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  std::unique_ptr<WAVEFORMATEX, WaveFormatDeleter> mix_format;
  HANDLE event_handle = nullptr;
  bool event_driven = false;
  bool started = false;
  SampleEncoding encoding = SampleEncoding::Float32;
  CaptureFormat format;
  uint64_t discontinuity_count = 0;
  uint64_t missing_frame_count = 0;
  uint64_t expected_position = 0;
  bool has_position = false;
  std::string error;

  ~Impl() { release(); }

  void release() {
    if (started && client) {
      client->Stop();
      started = false;
    }
    capture.Reset();
    client.Reset();
    device.Reset();
    enumerator.Reset();
    mix_format.reset();
    if (event_handle != nullptr) {
      CloseHandle(event_handle);
      event_handle = nullptr;
    }
    event_driven = false;
  }

  bool fail(const char* operation, HRESULT result) {
    error = detail::hresult_message(operation, result);
    return false;
  }
};

WasapiCaptureSource::WasapiCaptureSource() = default;
WasapiCaptureSource::~WasapiCaptureSource() { close(); }

bool WasapiCaptureSource::open(const wchar_t* device_id, std::string& error) {
  close();
  impl_ = std::make_unique<Impl>();
  Impl& state = *impl_;

  if (!state.apartment.okay()) {
    error = detail::hresult_message("Initializing COM", state.apartment.result());
    return false;
  }

  HRESULT result = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                    IID_PPV_ARGS(&state.enumerator));
  if (FAILED(result)) {
    state.fail("Creating the WASAPI device enumerator", result);
    error = state.error;
    return false;
  }

  if (device_id != nullptr && device_id[0] != L'\0') {
    result = state.enumerator->GetDevice(device_id, &state.device);
    if (FAILED(result)) {
      state.fail("Opening the requested capture endpoint", result);
      error = state.error;
      return false;
    }
  } else {
    result = state.enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &state.device);
    if (FAILED(result)) {
      state.fail("Opening the default capture endpoint", result);
      error = state.error;
      return false;
    }
  }

  result = state.device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  reinterpret_cast<void**>(state.client.GetAddressOf()));
  if (FAILED(result)) {
    state.fail("Activating the WASAPI capture client", result);
    error = state.error;
    return false;
  }

  WAVEFORMATEX* raw_format = nullptr;
  result = state.client->GetMixFormat(&raw_format);
  if (FAILED(result)) {
    state.fail("Reading the capture mix format", result);
    error = state.error;
    return false;
  }
  state.mix_format.reset(raw_format);

  std::string encoding_name;
  if (!describe_format(state.mix_format.get(), state.encoding, encoding_name, state.error)) {
    error = state.error;
    return false;
  }
  state.format.sample_rate = state.mix_format->nSamplesPerSec;
  state.format.channels = state.mix_format->nChannels;
  state.format.source_encoding = encoding_name;

  // Event-driven capture keeps the read loop off a timer. Some virtual drivers
  // reject the event flag, so fall back to polling rather than failing.
  state.event_handle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  // Capacity is not a batching delay: read() still drains on every event.
  // A 100 ms ring prevents the diagnostic/virtual-mic consumer from losing
  // samples when Windows schedules the reader late for a single period.
  constexpr REFERENCE_TIME capture_capacity = 1'000'000;
  if (state.event_handle != nullptr) {
    result = state.client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                      capture_capacity, 0, state.mix_format.get(), nullptr);
    if (SUCCEEDED(result) && SUCCEEDED(state.client->SetEventHandle(state.event_handle))) {
      state.event_driven = true;
    } else if (SUCCEEDED(result)) {
      // Initialized with the flag but could not bind the event: recreate the
      // client rather than leaving it in an unusable state.
      state.client.Reset();
      result = state.device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                      reinterpret_cast<void**>(state.client.GetAddressOf()));
      if (FAILED(result)) {
        state.fail("Reactivating the WASAPI capture client", result);
        error = state.error;
        return false;
      }
    }
  }

  if (!state.event_driven) {
    result = state.client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, capture_capacity, 0, state.mix_format.get(), nullptr);
    if (FAILED(result)) {
      state.fail("Initializing shared-mode WASAPI capture", result);
      error = state.error;
      return false;
    }
  }

  result = state.client->GetService(IID_PPV_ARGS(&state.capture));
  if (FAILED(result)) {
    state.fail("Acquiring the WASAPI capture service", result);
    error = state.error;
    return false;
  }

  return true;
}

bool WasapiCaptureSource::start(std::string& error) {
  if (!impl_) {
    error = "Capture source is not open.";
    return false;
  }
  if (impl_->started) return true;
  const HRESULT result = impl_->client->Start();
  if (FAILED(result)) {
    impl_->fail("Starting WASAPI capture", result);
    error = impl_->error;
    return false;
  }
  impl_->started = true;
  return true;
}

bool WasapiCaptureSource::read(std::vector<int16_t>& samples, uint32_t timeout_ms, std::string& error) {
  if (!impl_ || !impl_->capture) {
    error = "Capture source is not open.";
    return false;
  }
  Impl& state = *impl_;

  if (state.event_driven && state.event_handle != nullptr) {
    const DWORD waited = WaitForSingleObject(state.event_handle, timeout_ms);
    if (waited == WAIT_FAILED) {
      error = "Waiting for the WASAPI capture event failed (Win32 error " +
              std::to_string(GetLastError()) + ").";
      return false;
    }
  } else {
    Sleep(std::min<uint32_t>(timeout_ms, 10));
  }

  UINT32 packet_frames = 0;
  HRESULT result = state.capture->GetNextPacketSize(&packet_frames);
  if (FAILED(result)) {
    state.fail("Reading the WASAPI capture packet size", result);
    error = state.error;
    return false;
  }

  while (packet_frames > 0) {
    BYTE* data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    UINT64 device_position = 0;
    result = state.capture->GetBuffer(&data, &frames, &flags, &device_position, nullptr);
    if (FAILED(result)) {
      state.fail("Acquiring a WASAPI capture buffer", result);
      error = state.error;
      return false;
    }

    if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) state.discontinuity_count++;
    if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0) {
      if (state.has_position && device_position > state.expected_position) state.missing_frame_count += device_position - state.expected_position;
      state.expected_position = device_position + frames;
      state.has_position = true;
    }
    if (frames > 0) {
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr) {
        const size_t offset = samples.size();
        samples.resize(offset + static_cast<size_t>(frames) * state.format.channels, 0);
      } else {
        convert_packet(data, frames, state.format.channels, state.encoding, samples);
      }
    }

    result = state.capture->ReleaseBuffer(frames);
    if (FAILED(result)) {
      state.fail("Releasing a WASAPI capture buffer", result);
      error = state.error;
      return false;
    }

    result = state.capture->GetNextPacketSize(&packet_frames);
    if (FAILED(result)) {
      state.fail("Reading the WASAPI capture packet size", result);
      error = state.error;
      return false;
    }
  }

  return true;
}

void WasapiCaptureSource::close() {
  if (!impl_) return;
  impl_->release();
  impl_.reset();
}

uint64_t WasapiCaptureSource::discontinuities() const { return impl_ ? impl_->discontinuity_count : 0; }
uint64_t WasapiCaptureSource::missing_frames() const { return impl_ ? impl_->missing_frame_count : 0; }

const CaptureFormat& WasapiCaptureSource::format() const {
  static const CaptureFormat empty{};
  return impl_ ? impl_->format : empty;
}

}
