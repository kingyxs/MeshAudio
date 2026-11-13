#pragma once

#include <cstdint>
#include <span>

namespace meshaudio {

struct AudioFormat {
  uint32_t sample_rate = 48000;
  uint32_t channels = 2;
};

class AudioSink {
public:
  virtual ~AudioSink() = default;
  virtual bool open(const AudioFormat& format, const wchar_t* device_id) = 0;
  virtual bool write(std::span<const float> interleaved) = 0;
  virtual void close() = 0;
};

}
