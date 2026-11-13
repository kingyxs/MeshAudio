// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import java.util.UUID;

final class NodeSettings {
    final SharedPreferences preferences;
    NodeSettings(Context context) { preferences = context.getSharedPreferences("meshaudio", Context.MODE_PRIVATE); }
    String deviceId() {
        String id = preferences.getString("deviceId", "");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString();
            preferences.edit().putString("deviceId", id).commit();
        }
        return id;
    }
    String deviceName() { return preferences.getString("deviceName", "Android · " + Build.MODEL); }
    String host() { return preferences.getString("host", "").trim(); }
    int discoveryPort() { return preferences.getInt("discoveryPort", 4174); }
    int controlPort() { return preferences.getInt("controlPort", 4173); }
    boolean websocket() { return preferences.getBoolean("websocket", false); }
    void save(String host, int discoveryPort, int controlPort, boolean ws) {
        if (host.contains(":") || host.contains("/") || host.contains(" ") || host.length() > 253)
            throw new IllegalArgumentException("请输入电脑 IPv4 地址或主机名，不含 http:// 或端口");
        if (discoveryPort < 1 || discoveryPort > 65535 || controlPort < 1 || controlPort > 65535)
            throw new IllegalArgumentException("端口必须在 1–65535 之间");
        if (ws && host.isEmpty()) throw new IllegalArgumentException("兼容模式需要填写电脑地址");
        preferences.edit().putString("host", host).putInt("discoveryPort", discoveryPort)
                .putInt("controlPort", controlPort).putBoolean("websocket", ws).commit();
    }
    // Reserve ahead of use. App/process restarts must not rewind the native
    // receiver's uint32 sequence, or all new audio may be rejected as late.
    synchronized long reserveSequences(String type) {
        String key = "nextSequence." + type;
        long first = preferences.getLong(key, 0L);
        if (!preferences.edit().putLong(key, first + 1_048_576L).commit())
            throw new IllegalStateException("无法保存音频序号，请检查手机存储空间");
        return first;
    }
}
