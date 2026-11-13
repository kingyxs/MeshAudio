#pragma once

#include <string>
#include <vector>

namespace meshaudio {

enum class AudioDataFlow {
  Render,
  Capture,
};

struct AudioDevice {
  std::wstring id;
  std::wstring name;
  AudioDataFlow data_flow = AudioDataFlow::Render;
  bool is_default = false;
};

bool enumerate_audio_devices(AudioDataFlow data_flow, std::vector<AudioDevice>& devices, std::string& error);
bool enumerate_render_devices(std::vector<AudioDevice>& devices, std::string& error);

}
