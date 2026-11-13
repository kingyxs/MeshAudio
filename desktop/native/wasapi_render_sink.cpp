#include "wasapi_render_sink.h"
#include <atomic>

#include "windows_support.h"

#include <audioclient.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstring>
#include <limits>
#include <memory>
#include <vector>

namespace meshaudio {
namespace {

using Microsoft::WRL::ComPtr;

struct WaveFormatDeleter {
  void operator()(WAVEFORMATEX* format) const { CoTaskMemFree(format); }
};

enum class SampleEncoding { Float32, PcmUnsigned8, PcmSigned16, PcmSigned24, PcmSigned32 };

bool describe_format(const WAVEFORMATEX* format, SampleEncoding& encoding, uint32_t& bytes_per_sample,
                    std::string& error) {
  if (format == nullptr || format->nChannels == 0 || format->nSamplesPerSec == 0) {
    error = "The endpoint returned an invalid WASAPI mix format.";
    return false;
  }

  bool is_float = false;
  bool is_pcm = false;
  if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    if (format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
      error = "The endpoint returned a truncated WAVEFORMATEXTENSIBLE format.";
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
  } else if (is_pcm && format->wBitsPerSample == 8) {
    encoding = SampleEncoding::PcmUnsigned8;
  } else if (is_pcm && format->wBitsPerSample == 16) {
    encoding = SampleEncoding::PcmSigned16;
  } else if (is_pcm && format->wBitsPerSample == 24) {
    encoding = SampleEncoding::PcmSigned24;
  } else if (is_pcm && format->wBitsPerSample == 32) {
    encoding = SampleEncoding::PcmSigned32;
  } else {
    error = "Unsupported endpoint mix format: " + std::to_string(format->wBitsPerSample) +
            "-bit samples, format tag " + std::to_string(format->wFormatTag) + ".";
    return false;
  }

  bytes_per_sample = format->wBitsPerSample / 8;
  if (format->nBlockAlign < format->nChannels * bytes_per_sample) {
    error = "The endpoint mix format has an invalid block alignment.";
    return false;
  }
  return true;
}

float clamp_sample(float value) {
  if (!std::isfinite(value)) {
    return 0.0f;
  }
  return std::clamp(value, -1.0f, 1.0f);
}

void encode_sample(BYTE* destination, float value, SampleEncoding encoding) {
  const float sample = clamp_sample(value);
  switch (encoding) {
    case SampleEncoding::Float32:
      std::memcpy(destination, &sample, sizeof(sample));
      break;
    case SampleEncoding::PcmUnsigned8: {
      const auto encoded = static_cast<unsigned char>(std::lround((sample * 0.5f + 0.5f) * 255.0f));
      std::memcpy(destination, &encoded, sizeof(encoded));
      break;
    }
    case SampleEncoding::PcmSigned16: {
      const auto encoded = static_cast<int16_t>(std::lround(sample < 0.0f ? sample * 32768.0f : sample * 32767.0f));
      std::memcpy(destination, &encoded, sizeof(encoded));
      break;
    }
    case SampleEncoding::PcmSigned24: {
      const int32_t encoded = static_cast<int32_t>(std::lround(sample < 0.0f ? sample * 8388608.0f : sample * 8388607.0f));
      destination[0] = static_cast<BYTE>(encoded & 0xff);
      destination[1] = static_cast<BYTE>((encoded >> 8) & 0xff);
      destination[2] = static_cast<BYTE>((encoded >> 16) & 0xff);
      break;
    }
    case SampleEncoding::PcmSigned32: {
      const auto encoded = static_cast<int32_t>(std::llround(sample < 0.0f ?
          static_cast<double>(sample) * 2147483648.0 : static_cast<double>(sample) * 2147483647.0));
      std::memcpy(destination, &encoded, sizeof(encoded));
      break;
    }
  }
}

}

struct WasapiRenderSink::Impl {
  detail::ComApartment apartment;
  ComPtr<IMMDeviceEnumerator> enumerator;
  ComPtr<IMMDevice> device;
  ComPtr<IAudioClient> audio_client;
  ComPtr<IAudioRenderClient> render_client;
  std::unique_ptr<WAVEFORMATEX, WaveFormatDeleter> mix_format;
  HANDLE event_handle = nullptr;
  UINT32 buffer_frames = 0;
  AudioFormat input_format;
  SampleEncoding output_encoding = SampleEncoding::Float32;
  uint32_t output_bytes_per_sample = 0;
  bool started = false;
  std::string error;
  UINT32 engine_period_frames = 0;
  bool low_latency_shared = false;
  std::atomic<uint64_t> underrun_count {0};
  bool has_written = false;
  std::vector<float> converted;

  ~Impl() { release(); }

  void release() {
    if (started && audio_client) {
      audio_client->Stop();
      started = false;
    }
    render_client.Reset();
    audio_client.Reset();
    device.Reset();
    enumerator.Reset();
    mix_format.reset();
    if (event_handle != nullptr) {
      CloseHandle(event_handle);
      event_handle = nullptr;
    }
    buffer_frames = 0;
  }

  bool fail(const char* operation, HRESULT result) {
    error = detail::hresult_message(operation, result);
    return false;
  }

  bool write_frames(const float* input, uint32_t frame_count) {
    const uint32_t input_channels = input_format.channels;
    const uint32_t output_channels = mix_format->nChannels;
    const uint32_t output_rate = mix_format->nSamplesPerSec;
    const double ratio = static_cast<double>(output_rate) / input_format.sample_rate;
    const uint64_t converted_count64 = static_cast<uint64_t>(std::llround(frame_count * ratio));
    if (converted_count64 == 0) {
      return true;
    }
    if (converted_count64 > std::numeric_limits<uint32_t>::max()) {
      error = "The PCM block is too large for the endpoint.";
      return false;
    }
    const uint32_t converted_frames = static_cast<uint32_t>(converted_count64);
    converted.resize(static_cast<size_t>(converted_frames) * output_channels);

    for (uint32_t output_frame = 0; output_frame < converted_frames; ++output_frame) {
      const double source_position = std::min(static_cast<double>(frame_count - 1), output_frame / ratio);
      const uint32_t source_a = static_cast<uint32_t>(source_position);
      const uint32_t source_b = std::min(source_a + 1, frame_count - 1);
      const float fraction = static_cast<float>(source_position - source_a);
      for (uint32_t channel = 0; channel < output_channels; ++channel) {
        float a = 0.0f;
        float b = 0.0f;
        if (input_channels == 1) {
          a = input[source_a];
          b = input[source_b];
        } else if (output_channels == 1 && input_channels > 1) {
          for (uint32_t source_channel = 0; source_channel < input_channels; ++source_channel) {
            a += input[static_cast<size_t>(source_a) * input_channels + source_channel] / input_channels;
            b += input[static_cast<size_t>(source_b) * input_channels + source_channel] / input_channels;
          }
        } else if (channel < input_channels) {
          a = input[static_cast<size_t>(source_a) * input_channels + channel];
          b = input[static_cast<size_t>(source_b) * input_channels + channel];
        }
        converted[static_cast<size_t>(output_frame) * output_channels + channel] = a + (b - a) * fraction;
      }
    }

    uint32_t offset = 0;
    auto last_progress = std::chrono::steady_clock::now();
    while (offset < converted_frames) {
      // Demand-driven write: check for buffer space first and only block on the
      // WASAPI event when the endpoint buffer is actually full. Waiting before
      // every block caps throughput at one block per device period, so blocks
      // smaller than the period (a 5 ms block against a 10 ms shared-mode
      // period) are consumed at half speed and the caller's queue overflows.
      UINT32 padding = 0;
      HRESULT result = audio_client->GetCurrentPadding(&padding);
      if (FAILED(result)) {
        return fail("Reading WASAPI render padding", result);
      }
      if (padding == 0 && has_written) underrun_count.fetch_add(1, std::memory_order_relaxed);
      if (padding >= buffer_frames) {
        // Some shared/virtual endpoints coalesce or omit event notifications.
        // Recheck padding after a short timeout instead of leaving a drained
        // device silent for up to two seconds while waiting for one event.
        const DWORD wait_result = WaitForSingleObject(event_handle, 5);
        if (wait_result == WAIT_TIMEOUT) {
          if (std::chrono::steady_clock::now() - last_progress >= std::chrono::seconds(2)) {
            error = "Timed out waiting for the WASAPI render buffer.";
            return false;
          }
          continue;
        }
        if (wait_result != WAIT_OBJECT_0) {
          error = "Waiting for the WASAPI render buffer failed (Win32 error " +
                  std::to_string(GetLastError()) + ").";
          return false;
        }
        continue;
      }
      const UINT32 available = buffer_frames - padding;
      const UINT32 frames_to_write = std::min<UINT32>(available, converted_frames - offset);
      BYTE* destination = nullptr;
      result = render_client->GetBuffer(frames_to_write, &destination);
      if (FAILED(result)) {
        return fail("Acquiring a WASAPI render buffer", result);
      }

      for (UINT32 frame = 0; frame < frames_to_write; ++frame) {
        BYTE* output_frame = destination + static_cast<size_t>(frame) * mix_format->nBlockAlign;
        for (UINT32 channel = 0; channel < output_channels; ++channel) {
          const float value = converted[static_cast<size_t>(offset + frame) * output_channels + channel];
          encode_sample(output_frame + channel * output_bytes_per_sample, value, output_encoding);
        }
      }

      result = render_client->ReleaseBuffer(frames_to_write, 0);
      if (FAILED(result)) {
        return fail("Releasing a WASAPI render buffer", result);
      }
      offset += frames_to_write;
      last_progress = std::chrono::steady_clock::now();
      has_written = true;
    }
    return true;
  }
};

WasapiRenderSink::WasapiRenderSink() = default;
WasapiRenderSink::~WasapiRenderSink() { close(); }

bool WasapiRenderSink::open(const AudioFormat& format, const wchar_t* device_id) {
  close();
  impl_ = std::make_unique<Impl>();
  Impl& state = *impl_;
  state.error.clear();

  if (!state.apartment.okay()) {
    return state.fail("Initializing COM", state.apartment.result());
  }
  if (format.sample_rate < 8000 || format.sample_rate > 384000 || format.channels == 0 || format.channels > 8) {
    state.error = "Invalid input audio format; sample rate must be 8000..384000 Hz and channels 1..8.";
    return false;
  }
  state.input_format = format;

  HRESULT result = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                    IID_PPV_ARGS(&state.enumerator));
  if (FAILED(result)) {
    return state.fail("Creating the WASAPI device enumerator", result);
  }

  if (device_id != nullptr && device_id[0] != L'\0') {
    result = state.enumerator->GetDevice(device_id, &state.device);
    if (FAILED(result)) {
      return state.fail("Opening the requested render endpoint", result);
    }
  } else {
    result = state.enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &state.device);
    if (FAILED(result)) {
      return state.fail("Opening the default render endpoint", result);
    }
  }

  result = state.device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  reinterpret_cast<void**>(state.audio_client.GetAddressOf()));
  if (FAILED(result)) {
    return state.fail("Activating the WASAPI audio client", result);
  }

  WAVEFORMATEX* raw_mix_format = nullptr;
  result = state.audio_client->GetMixFormat(&raw_mix_format);
  if (FAILED(result)) {
    return state.fail("Reading the endpoint mix format", result);
  }
  state.mix_format.reset(raw_mix_format);
  if (!describe_format(state.mix_format.get(), state.output_encoding, state.output_bytes_per_sample, state.error)) {
    return false;
  }

  // Use the driver's normal shared engine cadence with a short, explicit
  // scheduling reserve. Client3's minimum-period ring may hold only ~6 ms on
  // a virtual endpoint; ordinary desktop scheduling can drain that even when
  // every source packet arrived. The GStreamer comparison remains continuous
  // with 40 ms shared capacity on the same endpoint. Capacity is an upper bound
  // on queued output, never an extra sleep or exclusive ownership of audio.
  constexpr REFERENCE_TIME shared_capacity = 400'000;
  result = state.audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                          shared_capacity, 0, state.mix_format.get(), nullptr);
  if (FAILED(result)) {
    return state.fail("Initializing shared-mode WASAPI rendering", result);
  }
  REFERENCE_TIME default_period = 0, min_period = 0;
  if (SUCCEEDED(state.audio_client->GetDevicePeriod(&default_period, &min_period))) {
    state.engine_period_frames = static_cast<UINT32>(
      default_period * state.mix_format->nSamplesPerSec / 10'000'000);
  }

  state.event_handle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (state.event_handle == nullptr) {
    state.error = "Creating the WASAPI render event failed (Win32 error " + std::to_string(GetLastError()) + ").";
    return false;
  }
  result = state.audio_client->SetEventHandle(state.event_handle);
  if (FAILED(result)) {
    return state.fail("Setting the WASAPI render event", result);
  }

  result = state.audio_client->GetBufferSize(&state.buffer_frames);
  if (FAILED(result)) {
    return state.fail("Reading the WASAPI render buffer size", result);
  }
  result = state.audio_client->GetService(IID_PPV_ARGS(&state.render_client));
  if (FAILED(result)) {
    return state.fail("Creating the WASAPI render client", result);
  }
  // Start with a full silent ring, as recommended for event-driven shared
  // rendering. Starting an empty endpoint makes its first scheduled period an
  // underrun and leaves no scheduling headroom for the first producer block.
  BYTE* initial_buffer = nullptr;
  result = state.render_client->GetBuffer(state.buffer_frames, &initial_buffer);
  if (FAILED(result)) {
    return state.fail("Priming the WASAPI render buffer", result);
  }
  result = state.render_client->ReleaseBuffer(state.buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT);
  if (FAILED(result)) {
    return state.fail("Releasing the initial WASAPI silence", result);
  }
  result = state.audio_client->Start();
  if (FAILED(result)) {
    return state.fail("Starting shared-mode WASAPI rendering", result);
  }
  state.started = true;
  return true;
}

bool WasapiRenderSink::write(std::span<const float> interleaved) {
  if (!impl_ || !impl_->started) {
    if (impl_) {
      impl_->error = "The WASAPI render sink is not open.";
    }
    return false;
  }
  const size_t channels = impl_->input_format.channels;
  if (interleaved.empty() || interleaved.size() % channels != 0) {
    impl_->error = "PCM data must contain complete interleaved frames.";
    return false;
  }
  const size_t frames = interleaved.size() / channels;
  if (frames > std::numeric_limits<uint32_t>::max()) {
    impl_->error = "The PCM block is too large.";
    return false;
  }
  return impl_->write_frames(interleaved.data(), static_cast<uint32_t>(frames));
}

bool WasapiRenderSink::drain() {
  if (!impl_ || !impl_->started) {
    return true;
  }
  for (int attempt = 0; attempt < 100; ++attempt) {
    UINT32 padding = 0;
    const HRESULT result = impl_->audio_client->GetCurrentPadding(&padding);
    if (FAILED(result)) {
      return impl_->fail("Reading WASAPI render padding while draining", result);
    }
    if (padding == 0) {
      return true;
    }
    const DWORD wait_result = WaitForSingleObject(impl_->event_handle, 1000);
    if (wait_result == WAIT_FAILED) {
      impl_->error = "Waiting for WASAPI playback to drain failed (Win32 error " +
                     std::to_string(GetLastError()) + ").";
      return false;
    }
  }
  impl_->error = "Timed out waiting for WASAPI playback to drain.";
  return false;
}

void WasapiRenderSink::close() {
  impl_.reset();
}

const std::string& WasapiRenderSink::last_error() const {
  static const std::string no_error = "The WASAPI render sink has not been opened.";
  return impl_ ? impl_->error : no_error;
}

uint32_t WasapiRenderSink::buffer_frames() const {
  return impl_ ? impl_->buffer_frames : 0;
}

uint32_t WasapiRenderSink::engine_period_frames() const {
  return impl_ ? impl_->engine_period_frames : 0;
}

bool WasapiRenderSink::low_latency_shared() const {
  return impl_ && impl_->low_latency_shared;
}

uint64_t WasapiRenderSink::underruns() const {
  return impl_ ? impl_->underrun_count.load(std::memory_order_relaxed) : 0;
}

}
