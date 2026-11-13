#pragma once

#include <windows.h>
#include <objbase.h>

#include <iomanip>
#include <sstream>
#include <string>

namespace meshaudio::detail {

class ComApartment {
public:
  ComApartment() : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComApartment() {
    if (SUCCEEDED(result_)) {
      CoUninitialize();
    }
  }

  ComApartment(const ComApartment&) = delete;
  ComApartment& operator=(const ComApartment&) = delete;

  bool okay() const { return SUCCEEDED(result_) || result_ == RPC_E_CHANGED_MODE; }
  HRESULT result() const { return result_; }

private:
  HRESULT result_;
};

inline std::string wide_to_utf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (length <= 1) {
    return {};
  }
  std::string result(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, result.data(), length, nullptr, nullptr);
  result.resize(static_cast<size_t>(length - 1));
  return result;
}

inline std::string hresult_message(const char* operation, HRESULT result) {
  LPWSTR system_message = nullptr;
  const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
  const DWORD length = FormatMessageW(flags, nullptr, static_cast<DWORD>(result), 0,
                                      reinterpret_cast<LPWSTR>(&system_message), 0, nullptr);

  std::ostringstream message;
  message << operation << " failed (HRESULT 0x" << std::hex << std::uppercase
          << static_cast<unsigned long>(result) << ")";
  if (length > 0 && system_message != nullptr) {
    std::wstring text(system_message, length);
    while (!text.empty() && (text.back() == L'\r' || text.back() == L'\n' || text.back() == L' ')) {
      text.pop_back();
    }
    const std::string utf8 = wide_to_utf8(text);
    if (!utf8.empty()) {
      message << ": " << utf8;
    }
  }
  if (system_message != nullptr) {
    LocalFree(system_message);
  }
  return message.str();
}

}
