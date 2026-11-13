// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import android.content.Context;
import org.json.*;
import okhttp3.*;
import okio.ByteString;
import java.io.IOException;
import java.net.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

interface AudioTransport extends AutoCloseable {
    Discovery.Endpoint endpoint();
    void send(byte[] packet, int length) throws Exception;
    void close();

    OkHttpClient HTTP = new OkHttpClient.Builder().connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(2, TimeUnit.SECONDS)
            .pingInterval(10, TimeUnit.SECONDS).build();
    // Desktop 0.3.1's binary-ingress reader consumes ping frames without a pong.
    // Audio data and the bounded send queue detect a failed connection; do not
    // enable OkHttp's ping timeout on this compatibility endpoint.
    OkHttpClient AUDIO = HTTP.newBuilder().pingInterval(0, TimeUnit.SECONDS).build();

    static AudioTransport open(Context context, NodeSettings settings, String type) throws Exception {
        return settings.websocket() ? new WebAudio(settings, type) : new UdpAudio(Discovery.find(context, settings, type));
    }

    final class UdpAudio implements AudioTransport {
        private final Discovery.Endpoint endpoint;
        private final DatagramSocket socket;
        UdpAudio(Discovery.Endpoint endpoint) throws Exception {
            this.endpoint = endpoint;
            socket = new DatagramSocket(); socket.setSendBufferSize(16 * Protocol.PACKET_BYTES);
            socket.connect(InetAddress.getByName(endpoint.host), endpoint.audioPort);
        }
        public Discovery.Endpoint endpoint() { return endpoint; }
        public void send(byte[] bytes, int length) throws IOException { socket.send(new DatagramPacket(bytes, length)); }
        public void close() { socket.close(); }
    }

    /** Optional TCP fallback, reusing the existing token-scoped PCM ingress. */
    final class WebAudio implements AudioTransport {
        private final Discovery.Endpoint endpoint;
        private final WebSocket socket;
        private volatile String failure;
        WebAudio(NodeSettings settings, String type) throws Exception {
            String base = "http://" + settings.host() + ":" + settings.controlPort();
            RequestBody body = RequestBody.create(Discovery.metadata(settings, type).toString(), MediaType.get("application/json"));
            Request request = new Request.Builder().url(base + "/api/browser-source").post(body).build();
            Call call = HTTP.newCall(request); call.timeout().timeout(5, TimeUnit.SECONDS);
            JSONObject response;
            try (Response result = call.execute()) {
                if (!result.isSuccessful() || result.body() == null) throw new IOException("注册音源失败：HTTP " + result.code());
                String text = result.body().string();
                if (text.length() > 65536) throw new IOException("桌面响应过大");
                response = new JSONObject(text);
            }
            if (response.optInt("sampleRate") != Protocol.RATE || response.optInt("channels") != 2)
                throw new IOException("桌面端需使用 48 kHz / 双声道 PCM");
            String sourceId = response.optString("sourceId");
            if (!sourceId.matches("[0-9a-fA-F]{1,8}")) throw new IOException("桌面返回了无效来源 ID");
            String token = response.getString("token");
            if (!token.matches("[a-f0-9]{36}")) throw new IOException("无效音频会话令牌");
            endpoint = new Discovery.Endpoint(settings.host(), 0, settings.controlPort(), sourceId);
            CountDownLatch ready = new CountDownLatch(1);
            socket = AUDIO.newWebSocket(new Request.Builder().url(base.replace("http:", "ws:") + "/browser-audio?token=" + token).build(), new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) { ready.countDown(); }
                @Override public void onFailure(WebSocket ws, Throwable error, Response response) { failure = error.getMessage(); if(failure==null) failure="音频连接失败"; ready.countDown(); }
                @Override public void onClosing(WebSocket ws, int code, String reason) { failure = "桌面已关闭音频会话"; ws.close(code, reason); }
                @Override public void onClosed(WebSocket ws, int code, String reason) { failure = "音频会话已关闭"; }
            });
            if (!ready.await(5, TimeUnit.SECONDS) || failure != null) { socket.cancel(); throw new IOException(failure == null ? "音频连接超时" : failure); }
        }
        public Discovery.Endpoint endpoint() { return endpoint; }
        public void send(byte[] bytes, int length) throws IOException {
            if (failure != null) throw new IOException(failure);
            // Bound queued PCM to about 120 ms; reconnect instead of accumulating seconds.
            if (socket.queueSize() > 48L * Protocol.PACKET_BYTES) { socket.cancel(); throw new IOException("网络拥塞，已丢弃积压并重新连接"); }
            if (!socket.send(ByteString.of(bytes, 0, length))) throw new IOException("音频连接不可写");
        }
        public void close() { socket.cancel(); }
    }
}
