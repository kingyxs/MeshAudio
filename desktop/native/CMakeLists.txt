cmake_minimum_required(VERSION 3.24)
project(MeshAudioNative LANGUAGES CXX)

# The installer must work on machines without the Visual C++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

if(NOT WIN32)
  message(FATAL_ERROR "MeshAudioNative currently supports Windows only.")
endif()

add_library(MeshAudioNative STATIC
  device_enumerator.cpp
  mix_engine.cpp
  wasapi_capture_source.cpp
  wasapi_render_sink.cpp
)
target_include_directories(MeshAudioNative PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_features(MeshAudioNative PUBLIC cxx_std_20)
target_compile_definitions(MeshAudioNative PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_link_libraries(MeshAudioNative PUBLIC ole32 uuid propsys avrt)

add_executable(meshaudio-native main.cpp)
target_compile_features(meshaudio-native PRIVATE cxx_std_20)
target_compile_definitions(meshaudio-native PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_link_libraries(meshaudio-native PRIVATE MeshAudioNative)

if(MSVC)
  target_compile_options(MeshAudioNative PRIVATE /W4 /permissive- /EHsc)
  target_compile_options(meshaudio-native PRIVATE /W4 /permissive- /EHsc)
endif()

install(TARGETS meshaudio-native RUNTIME DESTINATION bin)

include(CTest)
if(BUILD_TESTING)
  add_executable(meshaudio-mix-test mix_engine_test.cpp mix_engine.cpp)
  target_compile_features(meshaudio-mix-test PRIVATE cxx_std_20)
  target_compile_definitions(meshaudio-mix-test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  add_test(NAME native-mixer-recovery COMMAND meshaudio-mix-test)
endif()
