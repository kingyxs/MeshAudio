// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import okhttp3.*;
import org.json.*;

/** Read-only, independent control socket; losing it never stops capture/audio. */
final class ControlMonitor extends WebSocketListener implements AutoCloseable {
    private final String sourceId;
    private final WebSocket socket;
    volatile boolean connected, paused, confirmed;
    volatile long receivedPackets;
    ControlMonitor(Discovery.Endpoint endpoint) {
        sourceId = endpoint.sourceId;
        socket = AudioTransport.HTTP.newWebSocket(new Request.Builder()
                .url("ws://" + endpoint.host + ":" + endpoint.controlPort + "/control").build(), this);
    }
    @Override public void onOpen(WebSocket ws, Response response) { connected = true; }
    @Override public void onMessage(WebSocket ws, String text) {
        try {
            JSONObject state = new JSONObject(text);
            JSONArray sources = state.optJSONArray("sources");
            if (sources == null) return;
            for (int i=0; i<sources.length(); i++) {
                JSONObject source = sources.getJSONObject(i);
                if (!sourceId.equals(source.optString("sourceId")) && !("net-"+sourceId).equals(source.optString("id"))) continue;
                if (source.has("stopped")) paused = source.optBoolean("stopped");
                if (source.has("packets")) { receivedPackets = source.optLong("packets"); confirmed = receivedPackets > 0; }
            }
        } catch (JSONException ignored) { /* Ignore unrelated or partial telemetry. */ }
    }
    @Override public void onFailure(WebSocket ws, Throwable error, Response response) { connected = false; paused = false; }
    @Override public void onClosed(WebSocket ws, int code, String reason) { connected = false; paused = false; }
    @Override public void onClosing(WebSocket ws, int code, String reason) { connected = false; paused = false; ws.close(code, reason); }
    public void close() { connected = false; socket.cancel(); }
}
