#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace meshaudio {

// Per-source PCM queue that turns the network's bursty 5 ms packets into the
// device's fixed render periods.
//
// Playback runs at a *fractional* rate driven by a PI controller on queue
// depth, and reads with cubic interpolation. That is the whole point: the
// sender's capture clock (phone ADC) and the render device's clock (PC DAC)
// are independent crystals, so one always runs a few hundred ppm away from the
// other. That difference has to be absorbed somewhere.
//
// The previous implementation dropped individual samples to keep up, which is
// what produced the "electrical noise": ~240 one-sample discontinuities per
// second is a click train at 240 Hz. Resampling moves the read cursor instead,
// so the correction is spread smoothly over the waveform and the queue stays at
// its target instead of creeping toward the (previously 1 s) backlog cap.
//
// Sequence handling is unchanged:
//   - a queued packet ahead of the expected sequence proves a gap; missing
//     packet durations are inserted as silence so the timeline does not shift
//   - an empty queue is starvation, not loss: playback holds its position so a
//     late packet can still play
// Voice chain applied to microphone sources only.
//
// 80 Hz high-pass -> STFT spectral noise suppression (NS) -> VAD-gated AGC ->
// soft limiter.
//
// The NS analyses a 256-point STFT (5.3 ms window, 2.7 ms hop, sqrt-Hann for
// perfect overlap-add reconstruction) of the mono mixdown, tracks a per-bin
// noise PSD only while VAD says "silence", and applies smoothed Wiener gains
// to each channel's spectrum.  This replaces the previous time-domain expander
// whose gain-modulation pumped with every envelope fluctuation ("piston
// sound") and whose noise-floor estimate crept upward during steady-state
// quiet ("noise floor slowly rising").
//
// The AGC targets -16 dBFS RMS and only adapts while VAD detects speech, so a
// quiet room's hiss is never amplified toward the target level.
struct VoiceProcessor {
  bool enabled = false;
  bool enhanced = false;   // DeepVQE-S mode: stronger NS + voice-band shaping

  void configure(double sample_rate);
  void process(float* interleaved, uint32_t frames, uint32_t channels);

  // 80 Hz high-pass (per channel).
  double hp_coeff = 0.0;
  float hp_x1[2] {0.0f, 0.0f};
  float hp_y1[2] {0.0f, 0.0f};

  // --- STFT noise suppressor ---
  static constexpr int kN = 256;           // FFT size
  static constexpr int kH = 128;           // hop (50 % overlap)
  static constexpr int kBins = kN / 2 + 1;

  struct Channel {
    float ana[kN] {};       // sliding analysis window
    int ana_fill = 0;
    float ola[kN] {};       // overlap-add accumulator
    float out[kN] {};       // output ring buffer
    int out_head = 0;
    int out_count = 0;
  };
  Channel ch[2];

  // Shared FFT workspace (reused per channel within one frame).
  float fft_re[kN] {};
  float fft_im[kN] {};
  float win[kN] {};         // sqrt-Hann window

  float noise_psd[kBins] {};  // per-bin noise power estimate
  float gain_spec[kBins] {};  // smoothed Wiener gains
  bool noise_init = false;

  // VAD (energy-based with hangover).
  double vad_energy = 0.0;
  int vad_hang = 0;
  bool vad_active = false;

  // AGC (slow RMS leveler, speech-gated).
  double agc_rms = 0.0;
  double agc_gain = 1.0;
  double sample_rate_hz = 48000.0;
};

struct SourceRuntime {
  // Interleaved sample FIFO plus a fractional read cursor, measured in frames
  // from the front of `fifo`.
  std::vector<float> fifo;
  double pos = 0.0;

  // Two independent cursors: `next_sequence` is the push side's expectation
  // (what the network should deliver next) and `play_sequence` is what the
  // renderer is consuming. Sharing one counter made every packet look "late"
  // once playback started, so the queue froze and the stream went silent.
  uint32_t next_sequence = 0;
  bool has_next = false;
  uint32_t play_sequence = 0;
  bool has_play = false;
  bool started = false;
  uint32_t last_frames = 0;
  VoiceProcessor dsp;

  // PI controller state (see renderSource).
  double integral = 0.0;
  double ratio = 1.0;
  double level_ms = -1.0;
  // Small bounded recovery margin after an actual underrun; telemetry never
  // changes it. Fade only the affected source, preserving other routes.
  double recovery_margin_ms = 0.0;
  std::vector<float> last_output;
  uint32_t fade_in_remaining = 0;
  uint32_t fade_out_remaining = 0;

  float gain = 1.0f;
  bool muted = false;
  bool stopped = false;
  uint64_t bus_mask = 0;

  // observability
  uint64_t received = 0;
  uint64_t lost = 0;
  uint64_t starved = 0;
  uint64_t overflowed = 0;
  uint64_t resync = 0;
  uint64_t dropped_late = 0;
  uint64_t dropped_nomask = 0;
  uint64_t shortfall_frames = 0;
  uint32_t last_written = 0;
  uint32_t last_total = 0;
  double delay_ms = 0.0;
  double jitter_ms = 0.0;
  double last_arrival_ms = -1.0;
  uint32_t last_sequence_seen = 0;
  bool has_last_sequence = false;
};

class MixEngine {
public:
  MixEngine(uint32_t channels, uint32_t sample_rate);

  struct SourceSettings {
    uint32_t hash = 0;
    float gain = 1.0f;
    bool muted = false;
    bool stopped = false;
    bool voice = false;
    bool voice_enhanced = false;
    uint64_t bus_mask = 0;
  };

  struct Config {
    std::vector<SourceSettings> sources;
    std::vector<float> bus_gains;
    std::vector<bool> bus_muted;
  };

  // Replaces gains/routes/mutes. Queues for hashes that survive the update are
  // preserved so a route or fader change does not glitch the live stream.
  void applyConfig(const Config& config);

  // `pcm` holds `frames * channels` interleaved samples.
  void push(uint32_t hash, uint32_t sequence, const float* pcm, uint32_t frames, double arrival_ms);

  // Sizes the jitter buffer to the render cadence. A block can only be fed from
  // a queue that holds at least one block; endpoints that fall back to a 10 ms
  // engine period need more than the 15 ms default.
  void setTargetMs(double ms);

  // Renders exactly `frames` interleaved samples (silence included).
  void render(float* out, uint32_t frames, double now_ms);

  std::string statsJson() const;
  double targetMs() const;
  size_t sourceCount() const;

private:
  SourceRuntime& ensureSource(uint32_t hash);
  bool renderSource(SourceRuntime& source, uint32_t frames);
  uint32_t framesForMs(double ms) const;
  void ensureScratch(uint32_t frames);

  mutable std::mutex mutex_;
  uint32_t channels_;
  uint32_t sample_rate_;
  std::vector<std::pair<uint32_t, SourceRuntime>> sources_;
  std::vector<float> bus_gains_;
  std::vector<bool> bus_muted_;
  std::vector<float> source_scratch_;
  std::vector<float> bus_scratch_;
  uint32_t scratch_frames_ = 0;
  size_t scratch_buses_ = 0;
  double target_ms_ = 15.0;
  uint64_t rendered_frames_ = 0;
  uint32_t debug_hash_ = 0;
};

}  // namespace meshaudio
