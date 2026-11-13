#include "mix_engine.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <sstream>

namespace meshaudio {
namespace {

// Backlog safety net (frames beyond this are dropped on the push side). It only
// matters if the render thread stops consuming; normal operation stays near the
// 15 ms target because the PI controller below tracks the clock difference.
constexpr double kBacklogCapMs = 400.0;
constexpr double kBacklogKeepMs = 150.0;
// Anything deeper than this is treated as a stall and cut back to target in one
// step instead of being resampled away over tens of seconds.
constexpr double kHardResyncMs = 300.0;
// A gap larger than this means the sender restarted (or was paused); restarting
// the timeline is better than inserting hundreds of ms of silence.
constexpr uint32_t kMaxGapPackets = 20;

// PI gains for the playback-rate controller. With the queue error in ms and the
// rate correction dimensionless: omega_n = sqrt(1000 * ki) = 0.8 rad/s,
// zeta = 1000 * kp / (2 * omega_n) = 1.0 (critically damped). A 10 ms error
// asks for a 1.6 % rate change, which is inaudible on speech and mild on music;
// the integral term settles to the actual crystal difference (typically
// 0.1-2 %) so the steady-state error goes to zero.
constexpr double kProportionalGain = 0.0010;
constexpr double kIntegralGain = 0.0005;
constexpr double kIntegralLimit = 0.03;
constexpr double kMaxCorrection = 0.05;

double round1(double value) {
  return std::round(value * 10.0) / 10.0;
}

// Catmull-Rom cubic. Linear interpolation at a ~1 % rate offset already adds
// audible high-frequency modulation; four-point interpolation is exact at the
// sample points and keeps the correction transparent.
inline double hermite(double s0, double s1, double s2, double s3, double t) {
  const double a = -0.5 * s0 + 1.5 * s1 - 1.5 * s2 + 0.5 * s3;
  const double b = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
  const double c = -0.5 * s0 + 0.5 * s2;
  return ((a * t + b) * t + c) * t + s1;
}

}  // namespace

// In-place iterative radix-2 FFT.  n must be a power of two.
static void fft(float* re, float* im, int n, bool inverse) {
  for (int i = 1, j = 0; i < n; ++i) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = 2.0 * 3.14159265358979323846 / len * (inverse ? 1.0 : -1.0);
    const float wr = static_cast<float>(std::cos(ang));
    const float wi = static_cast<float>(std::sin(ang));
    for (int i = 0; i < n; i += len) {
      float cr = 1.0f, ci = 0.0f;
      for (int j = 0; j < len / 2; ++j) {
        const int u = i + j, v = u + len / 2;
        const float tr = re[v] * cr - im[v] * ci;
        const float ti = re[v] * ci + im[v] * cr;
        re[v] = re[u] - tr; im[v] = im[u] - ti;
        re[u] += tr; im[u] += ti;
        const float nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) {
    const float s = 1.0f / n;
    for (int i = 0; i < n; ++i) { re[i] *= s; im[i] *= s; }
  }
}

void VoiceProcessor::configure(double sample_rate) {
  const double rate = std::max(8000.0, sample_rate);
  sample_rate_hz = rate;
  // One-pole high-pass at 80 Hz: drops handling rumble and DC without thinning
  // the voice fundamental.
  hp_coeff = std::exp(-2.0 * 3.14159265358979323846 * 80.0 / rate);
  for (int c = 0; c < 2; ++c) { hp_x1[c] = 0.0f; hp_y1[c] = 0.0f; }

  // sqrt-Hann: applying it before FFT and again after IFFT yields an effective
  // Hann window; with 50 % overlap the sum of two adjacent Hann windows is
  // exactly 1, so the overlap-add reconstruction is transparent when gains
  // are unity.
  for (int i = 0; i < kN; ++i) {
    const double hann = 0.5 * (1.0 - std::cos(2.0 * 3.14159265358979323846 * i / kN));
    win[i] = static_cast<float>(std::sqrt(hann));
  }

  for (int k = 0; k < kBins; ++k) { noise_psd[k] = 1e-8f; gain_spec[k] = 1.0f; }
  noise_init = false;
  vad_energy = 0.0; vad_hang = 0; vad_active = false;
  agc_rms = 0.0; agc_gain = 1.0;

  for (int c = 0; c < 2; ++c) {
    std::fill_n(ch[c].ana, kN, 0.0f); ch[c].ana_fill = 0;
    std::fill_n(ch[c].ola, kN, 0.0f);
    std::fill_n(ch[c].out, kN, 0.0f); ch[c].out_head = 0; ch[c].out_count = 0;
  }
}

void VoiceProcessor::process(float* samples, uint32_t frames, uint32_t channels) {
  if (!enabled || samples == nullptr || frames == 0) return;
  const uint32_t nch = std::min<uint32_t>(channels, 2);
  if (nch == 0) return;

  for (uint32_t f = 0; f < frames; ++f) {
    float* fp = samples + static_cast<size_t>(f) * channels;

    // --- high-pass ---
    for (uint32_t c = 0; c < nch; ++c) {
      const float x = fp[c];
      const float y = static_cast<float>(hp_coeff * (hp_y1[c] + x - hp_x1[c]));
      hp_x1[c] = x; hp_y1[c] = y;
      fp[c] = y;
    }

    // --- accumulate into per-channel analysis buffers ---
    for (uint32_t c = 0; c < nch; ++c) ch[c].ana[ch[c].ana_fill] = fp[c];
    for (uint32_t c = 0; c < nch; ++c) ch[c].ana_fill++;

    // --- when the analysis window is full, run one STFT frame ---
    if (ch[0].ana_fill >= kN) {
      // 1. mono mixdown for noise analysis
      float mono[kN];
      for (int i = 0; i < kN; ++i) {
        float sum = 0.0f;
        for (uint32_t c = 0; c < nch; ++c) sum += ch[c].ana[i];
        mono[i] = sum / static_cast<float>(nch);
      }

      // 2. window + forward FFT of the mono analysis signal
      for (int i = 0; i < kN; ++i) { fft_re[i] = mono[i] * win[i]; fft_im[i] = 0.0f; }
      fft(fft_re, fft_im, kN, false);

      // 3. power spectrum
      float power[kBins];
      for (int k = 0; k < kBins; ++k) power[k] = fft_re[k] * fft_re[k] + fft_im[k] * fft_im[k];

      // 4. frame energy -> VAD
      double energy = 0.0;
      for (int k = 0; k < kBins; ++k) energy += power[k];
      energy /= kBins;
      vad_energy += (energy - vad_energy) * 0.3;

      if (!noise_init) {
        // Start the noise estimate low so the first frames pass through
        // unattenuated; it converges upward during the first silence.
        for (int k = 0; k < kBins; ++k) noise_psd[k] = power[k] * 0.01f + 1e-10f;
        noise_init = true;
        vad_active = false;
        vad_hang = 0;
      } else {
        double avg_noise = 0.0;
        for (int k = 0; k < kBins; ++k) avg_noise += noise_psd[k];
        avg_noise /= kBins;
        if (energy > avg_noise * 3.0) {
          vad_active = true;
          vad_hang = 30;               // ~80 ms hangover at 375 frame/s
        } else if (vad_hang > 0) {
          vad_hang--;
        } else {
          vad_active = false;
        }
        // Adapt the noise PSD: slow and steady during silence to keep the
        // estimate stable (a fast tracker chases fan-noise fluctuations and
        // creates "musical noise" / flowing-water artefacts). Nearly frozen
        // during speech so speech energy never drags the estimate upward.
        const float alpha = vad_active ? 0.002f : 0.025f;
        for (int k = 0; k < kBins; ++k) {
          noise_psd[k] += (power[k] - noise_psd[k]) * alpha;
          if (noise_psd[k] < 1e-10f) noise_psd[k] = 1e-10f;
        }
      }

      // 5. Wiener spectral gains.  Keep suppression gentle to avoid the
      // hollow / "canned" artefact of over-subtraction.  Even the enhanced
      // mode stays conservative: aggressive spectral subtraction removes
      // too much of the natural room tone and voice harmonics.
      {
        const float over_sub = enhanced ? 1.15f : 0.7f;
        const float floor = enhanced ? 0.18f : 0.35f;
        const float smooth = enhanced ? 0.10f : 0.06f;
        for (int k = 0; k < kBins; ++k) {
          const float snr = power[k] / (noise_psd[k] + 1e-10f);
          float g = 1.0f - over_sub / (snr + 1e-10f);
          if (g < floor) g = floor;
          // Gentle voice-band shaping in enhanced mode: very mild treble
          // de-emphasis only.  Strong band shaping causes the hollow
          // "telephone" quality the user noticed.
          if (enhanced) {
            const float freq = static_cast<float>(k) * static_cast<float>(sample_rate_hz) / (2.0f * static_cast<float>(kBins));
            if (freq < 200.0f) g *= 0.8f;
            else if (freq >= 6000.0f) g *= 0.85f;
          }
          gain_spec[k] += (g - gain_spec[k]) * smooth;
        }
      }
      // Frequency smoothing: a 3-point moving average across bins prevents
      // isolated sharp gains (which sound like bubbles) while preserving the
      // broadband shape of the suppression.
      {
        float tmp[kBins];
        for (int k = 0; k < kBins; ++k) {
          const float left = (k > 0) ? gain_spec[k - 1] : gain_spec[k];
          const float right = (k < kBins - 1) ? gain_spec[k + 1] : gain_spec[k];
          tmp[k] = (left + gain_spec[k] * 2.0f + right) * 0.25f;
        }
        for (int k = 0; k < kBins; ++k) gain_spec[k] = tmp[k];
      }

      // 6. per-channel synthesis: STFT -> apply gains -> ISTFT -> overlap-add
      for (uint32_t c = 0; c < nch; ++c) {
        for (int i = 0; i < kN; ++i) { fft_re[i] = ch[c].ana[i] * win[i]; fft_im[i] = 0.0f; }
        fft(fft_re, fft_im, kN, false);
        for (int k = 0; k < kBins; ++k) { fft_re[k] *= gain_spec[k]; fft_im[k] *= gain_spec[k]; }
        // conjugate mirror for the negative-frequency half (real output)
        for (int k = 1; k < kBins - 1; ++k) {
          fft_re[kN - k] = fft_re[k];
          fft_im[kN - k] = -fft_im[k];
        }
        fft(fft_re, fft_im, kN, true);
        for (int i = 0; i < kN; ++i) ch[c].ola[i] += fft_re[i] * win[i];

        // First kH samples of OLA are complete -> push to output ring.
        for (int i = 0; i < kH; ++i) {
          if (ch[c].out_count < kN) {
            const int idx = (ch[c].out_head + ch[c].out_count) % kN;
            ch[c].out[idx] = ch[c].ola[i];
            ch[c].out_count++;
          }
        }
        // Shift OLA accumulator left by kH; zero the tail for the next frame.
        std::memmove(ch[c].ola, ch[c].ola + kH, sizeof(float) * (kN - kH));
        std::fill_n(ch[c].ola + (kN - kH), kH, 0.0f);
      }

      // Shift analysis windows left by kH for the next frame.
      for (uint32_t c = 0; c < nch; ++c) {
        std::memmove(ch[c].ana, ch[c].ana + kH, sizeof(float) * (kN - kH));
        ch[c].ana_fill = kN - kH;
      }
    }

    // --- pop one processed sample per channel from the output ring ---
    for (uint32_t c = 0; c < nch; ++c) {
      if (ch[c].out_count > 0) {
        fp[c] = ch[c].out[ch[c].out_head];
        ch[c].out_head = (ch[c].out_head + 1) % kN;
        ch[c].out_count--;
      } else {
        fp[c] = 0.0f;   // warm-up (first ~5 ms)
      }
    }

    // --- AGC (VAD-gated: only adapt while speech is present) ---
    double peak = 0.0;
    for (uint32_t c = 0; c < nch; ++c) peak = std::max(peak, static_cast<double>(std::fabs(fp[c])));
    agc_rms += (peak - agc_rms) * 0.0001;   // ~200 ms RMS time constant
    if (vad_active) {
      double desired = agc_rms > 1e-6 ? (enhanced ? 0.16 : 0.18) / agc_rms : 1.0;
      desired = std::max(0.35, std::min(3.0, desired));
      agc_gain += (desired - agc_gain) * 0.00001;          // ~1 s adaptation
    }
    for (uint32_t c = 0; c < nch; ++c) {
      float v = fp[c] * static_cast<float>(agc_gain);
      // soft limiter: tanh knee above ±0.95
      if (v > 0.95f) v = 0.95f + 0.05f * std::tanh((v - 0.95f) / 0.05f);
      else if (v < -0.95f) v = -0.95f + 0.05f * std::tanh((v + 0.95f) / 0.05f);
      fp[c] = v;
    }
  }
}

MixEngine::MixEngine(uint32_t channels, uint32_t sample_rate)
  : channels_(std::max<uint32_t>(1, channels)), sample_rate_(std::max<uint32_t>(8000, sample_rate)) {}

uint32_t MixEngine::framesForMs(double ms) const {
  if (!(ms > 0.0)) return 1;
  const double frames = ms * static_cast<double>(sample_rate_) / 1000.0;
  return frames >= 1.0 ? static_cast<uint32_t>(std::llround(frames)) : 1;
}

SourceRuntime& MixEngine::ensureSource(uint32_t hash) {
  for (auto& entry : sources_) {
    if (entry.first == hash) return entry.second;
  }
  sources_.emplace_back(hash, SourceRuntime {});
  return sources_.back().second;
}

void MixEngine::applyConfig(const Config& config) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::pair<uint32_t, SourceRuntime>> next;
  next.reserve(config.sources.size());
  for (const auto& settings : config.sources) {
    SourceRuntime runtime;
    for (auto& entry : sources_) {
      if (entry.first == settings.hash) {
        runtime = std::move(entry.second);
        break;
      }
    }
    runtime.gain = std::isfinite(settings.gain) ? std::max(0.0f, std::min(4.0f, settings.gain)) : 1.0f;
    runtime.muted = settings.muted;
    runtime.stopped = settings.stopped;
    runtime.bus_mask = settings.bus_mask;
    if (settings.voice && !runtime.dsp.enabled) runtime.dsp.configure(sample_rate_);
    runtime.dsp.enabled = settings.voice;
    runtime.dsp.enhanced = settings.voice_enhanced;
    next.emplace_back(settings.hash, std::move(runtime));
  }
  sources_ = std::move(next);
  bus_gains_ = config.bus_gains;
  bus_muted_ = config.bus_muted;
}

void MixEngine::push(uint32_t hash, uint32_t sequence, const float* pcm, uint32_t frames, double arrival_ms) {
  if (pcm == nullptr || frames == 0) return;
  std::lock_guard<std::mutex> lock(mutex_);
  SourceRuntime& source = ensureSource(hash);
  // An unrouted source has no consumer in this engine; queueing it would only
  // build a backlog that never drains. Node filters these out too, so this is
  // a defensive guard against a stale config.
  if (source.bus_mask == 0) {
    source.dropped_nomask++;
    return;
  }

  if (!source.has_next) {
    source.next_sequence = sequence;
    source.has_next = true;
  }
  const uint32_t distance = sequence - source.next_sequence;
  if (distance != 0 && distance >= 0x80000000u) {
    source.dropped_late++;
    return;
  }

  if (distance > 0) {
    const uint32_t packet_frames = source.last_frames ? source.last_frames : frames;
    if (!source.started) {
      source.lost += distance;
    } else if (distance > kMaxGapPackets) {
      // Sender restarted or was paused for a long time. Rebuilding the timeline
      // from here is better than inserting a huge block of silence, which would
      // become real latency.
      source.fifo.clear();
      source.pos = 0.0;
      source.started = false;
      source.integral = 0.0;
      source.ratio = 1.0;
      source.level_ms = -1.0;
      if (source.dsp.enabled) source.dsp.configure(sample_rate_);
      source.resync += distance;
    } else {
      // A queued packet ahead of the expected one proves the gap is real, so
      // hold the timeline: pad the missing packet durations with silence.
      const size_t silence = static_cast<size_t>(distance) * packet_frames;
      source.fifo.insert(source.fifo.end(), silence * channels_, 0.0f);
      source.lost += distance;
    }
  }
  source.next_sequence = sequence + 1;

  const double packet_ms = frames * 1000.0 / sample_rate_;
  if (source.has_last_sequence && sequence == source.last_sequence_seen + 1 && source.last_arrival_ms >= 0.0) {
    const double interval = std::max(0.0, arrival_ms - source.last_arrival_ms);
    source.jitter_ms += (std::abs(interval - packet_ms) - source.jitter_ms) / 16.0;
  }
  source.last_arrival_ms = arrival_ms;
  source.last_sequence_seen = sequence;
  source.has_last_sequence = true;

  source.fifo.insert(source.fifo.end(), pcm, pcm + static_cast<size_t>(frames) * channels_);
  source.last_frames = frames;
  source.received++;

  // Safety cap. Only reachable when the render thread is not consuming (device
  // lost, paused output): keep a bounded buffer instead of growing forever.
  const size_t cap = framesForMs(kBacklogCapMs);
  size_t total = source.fifo.size() / channels_;
  if (total > cap) {
    const size_t keep = framesForMs(kBacklogKeepMs);
    const size_t drop = total - keep;
    source.fifo.erase(source.fifo.begin(), source.fifo.begin() + drop * channels_);
    if (source.pos > static_cast<double>(drop)) {
      source.pos -= static_cast<double>(drop);
    } else {
      source.pos = 0.0;
    }
    source.overflowed += drop;
  }
}

bool MixEngine::renderSource(SourceRuntime& source, uint32_t frames) {
  source_scratch_.assign(static_cast<size_t>(frames) * channels_, 0.0f);
  if (source.stopped) return false;

  const double frames_per_ms = static_cast<double>(sample_rate_) / 1000.0;
  // Microphone capture arrives in slightly larger batches than playback
  // capture, so voice sources get a modest floor above the media target.
  // This is local buffer residence, not complete capture-to-ear latency;
  // platform capture, transport and output-device buffering are additional.
  const double base_target_ms = source.dsp.enabled ? std::max(target_ms_, 25.0) : target_ms_;
  const double source_target_ms = std::min(120.0, base_target_ms + source.recovery_margin_ms);
  const uint32_t fade_frames = framesForMs(2.0);
  if (source.last_output.size() != channels_) source.last_output.assign(channels_, 0.0f);
  const auto fade_tail = [&](uint32_t offset) {
    for (uint32_t frame = offset; frame < frames && source.fade_out_remaining; ++frame) {
      const float scale = static_cast<float>(--source.fade_out_remaining) / fade_frames;
      for (uint32_t channel = 0; channel < channels_; ++channel)
        source_scratch_[static_cast<size_t>(frame) * channels_ + channel] = source.last_output[channel] * scale;
    }
  };
  const double target_frames = static_cast<double>(framesForMs(source_target_ms));
  size_t total = source.fifo.size() / channels_;

  // Compact the consumed prefix, keeping one frame of history so the
  // interpolator always has the sample before the cursor.
  if (source.pos >= 4096.0) {
    const size_t drop = static_cast<size_t>(source.pos) - 1;
    source.fifo.erase(source.fifo.begin(), source.fifo.begin() + drop * channels_);
    source.pos -= static_cast<double>(drop);
    total -= drop;
  }

  double available = static_cast<double>(total) - source.pos;
  if (available < 0.0) available = 0.0;

  if (!source.started) {
    // A shortage near a block boundary may leave only one or two frames for
    // the release ramp. Finish that ramp in the next block even if new PCM
    // has already refilled the queue; replacing a half-faded tail with a new
    // near-zero attack creates exactly the short click we are avoiding.
    if (source.fade_out_remaining) {
      fade_tail(0);
      return true;
    }
    if (available < target_frames) {
      source.starved++;
      fade_tail(0);
      return true;
    }
    source.started = true;
    source.fade_in_remaining = fade_frames;
    source.fade_out_remaining = 0;
    if (available > target_frames * 2.0) source.pos = static_cast<double>(total) - target_frames;
    if (source.pos < 1.0) source.pos = 1.0;
    available = static_cast<double>(total) - source.pos;
  }

  if (available > framesForMs(kHardResyncMs)) {
    const double drop = available - target_frames;
    source.pos += drop;
    source.resync += static_cast<uint64_t>(drop);
    available = target_frames;
    source.fade_in_remaining = fade_frames;
  }

  // Rate control: one knob (playback ratio) absorbs the whole clock difference.
  // The depth is smoothed first. Packets arrive in bursts (the sender's audio
  // thread wakes every few ms and Node forwards them in the same shape), so the
  // instantaneous depth sawtooths by one packet; feeding that straight into the
  // proportional term modulates the playback rate at the packet rate, which is
  // audible as pitch shimmer.
  const double dt = static_cast<double>(frames) / sample_rate_;
  const double instant_ms = available / frames_per_ms;
  if (source.level_ms < 0.0) {
    source.level_ms = instant_ms;
  } else {
    source.level_ms += (instant_ms - source.level_ms) * std::min(1.0, dt / 0.25);
  }
  // Proportional term uses the *instantaneous* depth. Driving it from the
  // smoothed level was a positive feedback loop: after a burst the level stayed
  // high for hundreds of ms, the controller kept speeding up, drained the queue
  // to zero, and then starved - audible as choppy audio.
  const double instant_error_ms = available / frames_per_ms - source_target_ms;
  const double smooth_error_ms = source.level_ms - source_target_ms;
  double proportional = kProportionalGain * std::max(-60.0, std::min(60.0, instant_error_ms));
  // Integral learns the crystal difference, so only integrate close to target;
  // otherwise a backlog would wind it up and keep the rate pinned fast.
  if (std::abs(smooth_error_ms) < 30.0) {
    source.integral += smooth_error_ms * dt * kIntegralGain;
  }
  source.integral = std::max(-kIntegralLimit, std::min(kIntegralLimit, source.integral));
  const double correction = std::max(-kMaxCorrection, std::min(kMaxCorrection, proportional + source.integral));
  source.ratio = 1.0 + correction;

  float* dst = source_scratch_.data();
  uint32_t written = 0;
  while (written < frames) {
    const size_t index = static_cast<size_t>(source.pos);
    if (index < 1 || index + 2 >= total) break;
    const double frac = source.pos - static_cast<double>(index);
    const float* base = source.fifo.data() + (index - 1) * channels_;
    float* out = dst + static_cast<size_t>(written) * channels_;
    for (uint32_t ch = 0; ch < channels_; ++ch) {
      out[ch] = static_cast<float>(hermite(base[ch], base[channels_ + ch], base[2 * channels_ + ch],
                                           base[3 * channels_ + ch], frac));
    }
    source.pos += source.ratio;
    written++;
  }

  if (written > 0 && source.dsp.enabled) source.dsp.process(dst, written, channels_);
  for (uint32_t frame = 0; frame < written && source.fade_in_remaining; ++frame) {
    const float scale = 1.0f - static_cast<float>(--source.fade_in_remaining) / fade_frames;
    for (uint32_t channel = 0; channel < channels_; ++channel) dst[static_cast<size_t>(frame) * channels_ + channel] *= scale;
  }
  if (written > 0) {
    for (uint32_t channel = 0; channel < channels_; ++channel) source.last_output[channel] = dst[static_cast<size_t>(written - 1) * channels_ + channel];
  }
  if (written < frames) {
    source.starved++;
    source.shortfall_frames += frames - written;
    // Refill only this queue after a real shortage rather than alternating
    // between a few samples and hard zeros on every render period. Keep the
    // extra margin bounded so recovery never becomes multi-second latency.
    source.recovery_margin_ms = std::min(35.0, source.recovery_margin_ms + 10.0);
    source.started = false;
    source.integral = 0.0;
    source.level_ms = -1.0;
    source.ratio = 1.0;
    source.fade_out_remaining = fade_frames;
    fade_tail(written);
  }
  source.last_written = written;
  source.last_total = static_cast<uint32_t>(total);
  source.delay_ms = std::max(0.0, (static_cast<double>(total) - source.pos) / frames_per_ms);
  return written < frames;
}

void MixEngine::ensureScratch(uint32_t frames) {
  // Both dimensions matter: the bus count can change after a route update, and
  // sizing only by frame count left the bus buffer stale (out-of-bounds write).
  if (scratch_frames_ >= frames && scratch_buses_ >= bus_gains_.size()) return;
  scratch_frames_ = std::max(scratch_frames_, frames);
  scratch_buses_ = std::max(scratch_buses_, bus_gains_.size());
  bus_scratch_.assign(static_cast<size_t>(scratch_frames_) * channels_ * std::max<size_t>(1, scratch_buses_), 0.0f);
}

void MixEngine::render(float* out, uint32_t frames, double now_ms) {
  if (out == nullptr || frames == 0) return;
  (void)now_ms;
  std::lock_guard<std::mutex> lock(mutex_);
  ensureScratch(frames);
  const size_t samples = static_cast<size_t>(frames) * channels_;
  std::fill_n(out, samples, 0.0f);

  const size_t bus_count = bus_gains_.size();
  if (bus_count > 0) {
    std::fill_n(bus_scratch_.data(), samples * bus_count, 0.0f);
  }

  for (auto& entry : sources_) {
    SourceRuntime& source = entry.second;
    if (source.bus_mask == 0 || source.muted) continue;
    debug_hash_ = entry.first;
    renderSource(source, frames);
    const float gain = std::isfinite(source.gain) ? source.gain : 1.0f;
    for (size_t bus = 0; bus < bus_count; ++bus) {
      if ((source.bus_mask & (uint64_t { 1 } << bus)) == 0) continue;
      float* target = bus_scratch_.data() + samples * bus;
      for (size_t i = 0; i < samples; ++i) target[i] += source_scratch_[i] * gain;
    }
  }

  for (size_t bus = 0; bus < bus_count; ++bus) {
    if (bus_muted_[bus]) continue;
    const float gain = std::isfinite(bus_gains_[bus]) ? bus_gains_[bus] : 1.0f;
    const float* bus_source = bus_scratch_.data() + samples * bus;
    for (size_t i = 0; i < samples; ++i) {
      out[i] += bus_source[i] * gain;
    }
  }

  for (size_t i = 0; i < samples; ++i) {
    const float value = out[i];
    out[i] = std::isfinite(value) ? std::max(-1.0f, std::min(1.0f, value)) : 0.0f;
  }

  rendered_frames_ += frames;
}

std::string MixEngine::statsJson() const {
  struct Metrics {
    uint32_t hash;
    double queued_ms, delay_ms, jitter_ms, rate_ppm;
    uint64_t received, lost, starved, overflowed, resync, shortfall, late, no_mask;
    bool voice, enhanced;
    uint32_t written, total;
  };
  std::vector<Metrics> metrics;
  metrics.reserve(64);
  double target_ms = 0.0, rendered_ms = 0.0;
  {
    // Copy only scalar counters. Never copy PCM/DSP buffers, allocate strings
    // or format numbers while the render/push mutex is held.
    std::lock_guard<std::mutex> lock(mutex_);
    target_ms = target_ms_;
    rendered_ms = rendered_frames_ * 1000.0 / sample_rate_;
    for (const auto& entry : sources_) {
      const SourceRuntime& source = entry.second;
      const double queued = std::max(0.0, static_cast<double>(source.fifo.size() / channels_) - source.pos);
      metrics.push_back({entry.first, queued * 1000.0 / sample_rate_, source.delay_ms,
        source.jitter_ms, round1((source.ratio - 1.0) * 1e6), source.received,
        source.lost, source.starved, source.overflowed, source.resync,
        source.shortfall_frames, source.dropped_late, source.dropped_nomask,
        source.dsp.enabled, source.dsp.enhanced, source.last_written, source.last_total});
    }
  }
  std::ostringstream json;
  json.setf(std::ios::fixed);
  json.precision(1);
  json << "{\"type\":\"engine.stats\",\"targetMs\":" << target_ms
       << ",\"renderedMs\":" << rendered_ms << ",\"sources\":[";
  bool first = true;
  for (const auto& source : metrics) {
    if (!first) json << ',';
    first = false;
    json << "{\"hash\":" << source.hash
         << ",\"queuedMs\":" << source.queued_ms
         << ",\"delayMs\":" << source.delay_ms
         << ",\"jitterMs\":" << source.jitter_ms
         << ",\"ratePpm\":" << source.rate_ppm
         << ",\"received\":" << source.received
         << ",\"lost\":" << source.lost
         << ",\"starved\":" << source.starved
         << ",\"overflowed\":" << source.overflowed
         << ",\"resync\":" << source.resync
         << ",\"voice\":" << (source.voice ? 1 : 0)
         << ",\"voiceEnhanced\":" << (source.enhanced ? 1 : 0)
         << ",\"shortfallFrames\":" << source.shortfall
         << ",\"dropLate\":" << source.late
         << ",\"dropNoMask\":" << source.no_mask
         << ",\"written\":" << source.written
         << ",\"fifoFrames\":" << source.total << '}';
  }
  json << "]}";
  return json.str();
}

void MixEngine::setTargetMs(double ms) {
  if (!std::isfinite(ms)) return;
  std::lock_guard<std::mutex> lock(mutex_);
  target_ms_ = std::max(8.0, std::min(120.0, ms));
}

double MixEngine::targetMs() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return target_ms_;
}

size_t MixEngine::sourceCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return sources_.size();
}

}  // namespace meshaudio
