# Third-party notices

MeshAudio code: GPL-3.0-or-later (LICENSE). Original MIT grants remain in LICENSES/MeshAudio-original-MIT.txt. Third-party works retain their copyrights and licences; no upstream code is relicensed as MeshAudio-owned.

## Frontend / desktop shell

Vue 3 and Pinia: MIT. Lucide icons: ISC, with Feather portions under MIT. QR Code Generator: MIT, copyright Kazuhiko Arase; QR Code is a trademark of DENSO WAVE. Full npm texts are collected into the installed licenses/npm directory; QR text is in licenses/qrcode-generator-MIT.txt.

Tauri, its plugins, serde and other Rust dependencies: their original MIT/Apache-2.0 and other declared licences. The exact Windows dependency list and licence declarations are in licenses/inventory.json. MPL-covered crates are included in the separate corresponding-source bundle. Build-only dependencies may appear in the conservative notice inventory.

Node.js: MIT plus embedded third-party notices (V8, OpenSSL and others); the full LICENSE from the exact runtime version is included as licenses/Node.js-LICENSE.txt.

## Android node and build wrapper

OkHttp 4.12.0, Okio and the Kotlin standard library retain their Apache-2.0 notices. The Android APK includes the GPL and Apache licence texts and an Android-specific notice file in assets/licenses. The SDK and proprietary tools are not redistributed. Gradle Wrapper is Apache-2.0; its pinned distribution and SHA-256 are recorded in android/gradle/wrapper/gradle-wrapper.properties. Exact resolved dependency checksums are in android/gradle/verification-metadata.xml. Test-only media player and UI driver APKs are not part of the delivered application.

## AirPlay runtime

Modified UxPlay 1.73.6: GPL-3.0-or-later. Pinned upstream and changes: third_party/uxplay.lock.json and uxplay-meshaudio.patch; full source in third_party/UxPlay. Installed copy also includes UXPLAY-LICENSE and the UxPlay source snapshot.

GStreamer and plugins: LGPL-2.1-or-later, with original component terms retained. Custom FFmpeg 9.0.2 is built with only AAC/ALAC audio decoders and GPL/nonfree features disabled; it is not the full GPL-configured MSYS2 binary. Codec licences and actual DLL closure are recorded in third_party/airplay-dependencies.lock.json. OpenSSL uses Apache-2.0. GLib, libplist, libiconv/gettext and other runtime libraries retain their own licences. GCC runtime libraries retain the GCC Runtime Library Exception. Dynamic LGPL libraries can be replaced with ABI-compatible modified versions.

Exact full source archives, package recipes/patches, build flags and MPL Rust sources accompany public binaries in the matching MeshAudio-VERSION-third-party-sources.tar.gz. See SOURCE-NOTICE.txt and docs/THIRD-PARTY-SOURCES.md. Do not distribute a binary without its matching source materials.

## Optional proprietary system components

VB-CABLE (Donationware, VB-Audio) and Bonjour (Apple) are not part of the source or installer distribution. The app downloads them directly from their publishers only when selected. Their official installers, licences, signatures, administrator prompts and reboot requirements apply.

## Design references

Port dragging and validation were informed by ComfyUI documentation; no ComfyUI code or artwork is bundled. Earlier audio architecture took design inspiration from Sunshine; no Sunshine code is included. Platform APIs are used through public Windows interfaces.
