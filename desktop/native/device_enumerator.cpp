#include "device_enumerator.h"

#include "windows_support.h"

#include <propkey.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
#include <propsys.h>
#include <wrl/client.h>

#include <memory>
#include <utility>

namespace meshaudio {
namespace {

using Microsoft::WRL::ComPtr;

bool get_device_name(IMMDevice* device, std::wstring& name, std::string& error) {
  ComPtr<IPropertyStore> properties;
  HRESULT result = device->OpenPropertyStore(STGM_READ, &properties);
  if (FAILED(result)) {
    error = detail::hresult_message("Opening audio endpoint properties", result);
    return false;
  }

  PROPVARIANT value;
  PropVariantInit(&value);
  result = properties->GetValue(PKEY_Device_FriendlyName, &value);
  if (FAILED(result)) {
    error = detail::hresult_message("Reading audio endpoint name", result);
    PropVariantClear(&value);
    return false;
  }
  if (value.vt == VT_LPWSTR && value.pwszVal != nullptr) {
    name = value.pwszVal;
  }
  PropVariantClear(&value);
  return true;
}

}

bool enumerate_audio_devices(AudioDataFlow data_flow, std::vector<AudioDevice>& devices, std::string& error) {
  devices.clear();
  error.clear();

  detail::ComApartment apartment;
  if (!apartment.okay()) {
    error = detail::hresult_message("Initializing COM", apartment.result());
    return false;
  }

  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                    IID_PPV_ARGS(&enumerator));
  if (FAILED(result)) {
    error = detail::hresult_message("Creating the WASAPI device enumerator", result);
    return false;
  }

  const EDataFlow flow = data_flow == AudioDataFlow::Render ? eRender : eCapture;
  std::wstring default_id;
  ComPtr<IMMDevice> default_device;
  result = enumerator->GetDefaultAudioEndpoint(flow, eConsole, &default_device);
  if (SUCCEEDED(result)) {
    LPWSTR raw_id = nullptr;
    result = default_device->GetId(&raw_id);
    if (SUCCEEDED(result) && raw_id != nullptr) {
      default_id = raw_id;
      CoTaskMemFree(raw_id);
    }
  }

  ComPtr<IMMDeviceCollection> collection;
  result = enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection);
  if (FAILED(result)) {
    error = detail::hresult_message(data_flow == AudioDataFlow::Render
                                        ? "Enumerating active render endpoints"
                                        : "Enumerating active capture endpoints", result);
    return false;
  }

  UINT count = 0;
  result = collection->GetCount(&count);
  if (FAILED(result)) {
    error = detail::hresult_message("Counting audio endpoints", result);
    return false;
  }

  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    result = collection->Item(index, &device);
    if (FAILED(result)) {
      error = detail::hresult_message("Opening an audio endpoint", result);
      return false;
    }

    LPWSTR raw_id = nullptr;
    result = device->GetId(&raw_id);
    if (FAILED(result) || raw_id == nullptr) {
      error = detail::hresult_message("Reading an audio endpoint ID", FAILED(result) ? result : E_FAIL);
      return false;
    }
    AudioDevice endpoint;
    endpoint.id = raw_id;
    CoTaskMemFree(raw_id);
    endpoint.data_flow = data_flow;
    endpoint.is_default = endpoint.id == default_id;
    if (!get_device_name(device.Get(), endpoint.name, error)) {
      return false;
    }
    if (endpoint.name.empty()) {
      endpoint.name = endpoint.id;
    }
    devices.push_back(std::move(endpoint));
  }

  return true;
}

bool enumerate_render_devices(std::vector<AudioDevice>& devices, std::string& error) {
  return enumerate_audio_devices(AudioDataFlow::Render, devices, error);
}

}
