// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import android.content.Context;
import android.net.wifi.WifiManager;
import org.json.JSONObject;
import java.io.IOException;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class Discovery {
    static final class Endpoint {
        final String host;
        final int audioPort, controlPort, sourceHash;
        final String sourceId;
        Endpoint(String host, int audioPort, int controlPort, String sourceId) {
            this.host = host; this.audioPort = audioPort; this.controlPort = controlPort;
            this.sourceId = sourceId; this.sourceHash = (int) Long.parseUnsignedLong(sourceId, 16);
        }
    }
    static JSONObject metadata(NodeSettings settings, String type) throws Exception {
        return new JSONObject().put("type", "meshaudio.discover").put("protocol", 1)
                .put("deviceId", settings.deviceId()).put("deviceName", settings.deviceName())
                .put("streamType", type).put("sampleRate", Protocol.RATE).put("channels", 2)
                .put("codec", "pcm_f32le");
    }
    static Endpoint find(Context context, NodeSettings settings, String type) throws Exception {
        byte[] request = metadata(settings, type).toString().getBytes(StandardCharsets.UTF_8);
        Set<InetAddress> targets = new LinkedHashSet<>();
        if (!settings.host().isEmpty()) targets.add(InetAddress.getByName(settings.host()));
        else {
            targets.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InterfaceAddress address : network.getInterfaceAddresses())
                    if (address.getBroadcast() != null) targets.add(address.getBroadcast());
            }
        }
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi == null ? null : wifi.createMulticastLock("MeshAudio discovery");
        if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true); socket.setSoTimeout(800);
            byte[] buffer = new byte[16_384];
            for (int attempt = 0; attempt < 3; attempt++) {
                for (InetAddress target : targets) socket.send(new DatagramPacket(request, request.length, target, settings.discoveryPort()));
                long end = System.currentTimeMillis() + 850;
                while (System.currentTimeMillis() < end) {
                    DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
                    try { socket.receive(reply); } catch (SocketTimeoutException ignored) { break; }
                    JSONObject result;
                    try { result = new JSONObject(new String(reply.getData(), 0, reply.getLength(), StandardCharsets.UTF_8)); }
                    catch (Exception ignored) { continue; }
                    if (!"meshaudio.discover.response".equals(result.optString("type")) || result.optInt("protocol") != 1
                            || !settings.deviceId().equals(result.optString("deviceId"))
                            || !type.equals(result.optString("streamType"))) continue;
                    String id = result.optString("sourceId");
                    int audio = result.optInt("audioPort", result.optInt("port"));
                    int control = result.optInt("controlPort", settings.controlPort());
                    if (!id.matches("[0-9a-fA-F]{1,8}") || audio < 1 || audio > 65535 || control < 1 || control > 65535) continue;
                    if (result.optInt("sampleRate", Protocol.RATE) != Protocol.RATE || result.optInt("channels", 2) != 2)
                        throw new IOException("桌面端需使用 48 kHz / 双声道 PCM");
                    return new Endpoint(reply.getAddress().getHostAddress(), audio, control, id);
                }
            }
        } finally { if (lock != null && lock.isHeld()) lock.release(); }
        throw new IOException("未发现桌面端。请连接同一局域网、允许专用网络防火墙，或填写电脑 IP");
    }
}
