#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace meshaudio {

struct CaptureFormat {
  uint32_t sample_rate = 0;
  uint32_t channels = 0;
  // Encoding reported by the endpoint mix format, for diagnostics only. The
  // capture source always emits interleaved S16LE on stdout.
  std::string source_encoding;
};

// Shared-mode WASAPI capture of a recording endpoint (for example CABLE
// Output). It is deliberately read-only: no loopback flag, no render device.
class WasapiCaptureSource final {
public:
  WasapiCaptureSource();
  ~WasapiCaptureSource();

  WasapiCaptureSource(const WasapiCaptureSource&) = delete;
  WasapiCaptureSource& operator=(const WasapiCaptureSource&) = delete;

  bool open(const wchar_t* device_id, std::string& error);
  bool start(std::string& error);
  // Blocks up to timeout_ms, then appends every available frame as S16LE.
  bool read(std::vector<int16_t>& samples, uint32_t timeout_ms, std::string& error);
  void close();

  const CaptureFormat& format() const;
  uint64_t discontinuities() const;
  uint64_t missing_frames() const;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}
