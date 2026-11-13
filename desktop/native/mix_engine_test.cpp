#include "mix_engine.h"
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <vector>

// A deterministic packet stall on one source must fade cleanly and leave the
// second source's samples exactly as if it were playing alone.
int main() {
  {
    // Refill immediately after a partial-block shortage, at a nonzero sample
    // value. The release must complete across the block boundary before a
    // fresh attack starts. A sine that happens to cross zero hides this bug.
    meshaudio::MixEngine boundary(2, 48000);
    meshaudio::MixEngine::Config graph;
    graph.sources = {{9, 1, false, false, false, false, 1}};
    graph.bus_gains = {1}; graph.bus_muted = {false};
    boundary.applyConfig(graph); boundary.setTargetMs(25);
    std::vector<float> input(1440 * 2, .4f), output(480 * 2);
    boundary.push(9, 0, input.data(), 1440, 0);
    float last = 0; double max_step = 0;
    for (int block = 0; block < 12; ++block) {
      if (block >= 3) boundary.push(9, block - 2, input.data(), 1440, block * 10.0);
      boundary.render(output.data(), 480, block * 10.0);
      for (size_t i = 0; i < output.size(); i += 2) {
        max_step = std::max(max_step, static_cast<double>(std::abs(output[i] - last))); last = output[i];
      }
    }
    if (max_step > .01) throw std::runtime_error("immediate refill truncates release at a block boundary");
  }
  constexpr uint32_t frames = 240, rate = 48000, channels = 2;
  meshaudio::MixEngine mixed(channels, rate), baseline(channels, rate), isolated(channels, rate);
  meshaudio::MixEngine::Config config;
  config.bus_gains = {1}; config.bus_muted = {false};
  config.sources = {{1, 1, false, false, false, false, 1}, {2, 1, false, false, false, false, 1}};
  mixed.applyConfig(config);
  config.sources.erase(config.sources.begin()); baseline.applyConfig(config);
  config.sources[0].hash = 1; isolated.applyConfig(config);
  mixed.setTargetMs(25); baseline.setTargetMs(25); isolated.setTargetMs(25);
  uint32_t seq_a = 0, seq_b = 0;
  auto push = [&](uint32_t hash, uint32_t& seq, double frequency, double now) {
    std::vector<float> packet(frames * channels);
    for (uint32_t i = 0; i < frames; ++i) {
      const float sample = static_cast<float>(std::sin((seq * frames + i) * 6.283185307179586 * frequency / rate) * .15);
      packet[i * channels] = packet[i * channels + 1] = sample;
    }
    mixed.push(hash, seq, packet.data(), frames, now);
    (hash == 1 ? isolated : baseline).push(hash, seq, packet.data(), frames, now);
    ++seq;
  };
  for (int i = 0; i < 7; ++i) { push(1, seq_a, 440, i * 5.0); push(2, seq_b, 660, i * 5.0); }
  std::vector<float> out(frames * channels), healthy(out.size()), affected(out.size());
  float previous = 0; double peak_step = 0, isolation_error = 0, healthy_energy_during_stall = 0;
  for (int tick = 0; tick < 500; ++tick) {
    if (tick < 200 || tick >= 220) push(1, seq_a, 440, (tick + 7) * 5.0);
    push(2, seq_b, 660, (tick + 7) * 5.0);
    mixed.render(out.data(), frames, tick * 5.0);
    baseline.render(healthy.data(), frames, tick * 5.0);
    isolated.render(affected.data(), frames, tick * 5.0);
    for (uint32_t i = 0; i < frames; ++i) {
      const size_t index = i * channels;
      peak_step = std::max(peak_step, static_cast<double>(std::abs(out[index] - previous))); previous = out[index];
      isolation_error = std::max(isolation_error, static_cast<double>(std::abs(out[index] - affected[index] - healthy[index])));
      if (tick >= 210 && tick < 220) healthy_energy_during_stall += healthy[index] * healthy[index];
    }
    if (tick % 10 == 0 && mixed.statsJson().find("engine.stats") == std::string::npos) throw std::runtime_error("invalid stats");
  }
  if (peak_step >= .05 || isolation_error >= 1e-6 || healthy_energy_during_stall <= 1)
    throw std::runtime_error("dropout recovery clicks or affects another source");
  std::cout << "PASS native source dropout/recovery, healthy-source isolation and telemetry: peak step="
            << peak_step << ", isolation error=" << isolation_error << '\n';
}
