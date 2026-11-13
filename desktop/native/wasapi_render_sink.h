#pragma once

#include "audio_sink.h"

#include <memory>
#include <string>

namespace meshaudio {

class WasapiRenderSink final : public AudioSink {
public:
  WasapiRenderSink();
  ~WasapiRenderSink() override;

  WasapiRenderSink(const WasapiRenderSink&) = delete;
  WasapiRenderSink& operator=(const WasapiRenderSink&) = delete;

  bool open(const AudioFormat& format, const wchar_t* device_id) override;
  bool write(std::span<const float> interleaved) override;
  bool drain();
  void close() override;

  const std::string& last_error() const;

  // Diagnostics for the negotiated shared-mode buffer. `low_latency_shared`
  // is retained for status compatibility; normal driver cadence is now used
  // with explicit scheduling headroom rather than a minimum-period ring.
  uint32_t buffer_frames() const;
  uint32_t engine_period_frames() const;
  bool low_latency_shared() const;
  uint64_t underruns() const;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}
