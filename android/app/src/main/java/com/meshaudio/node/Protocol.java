// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** MSA1 v1: 48 kHz, interleaved stereo float32; never send IP-fragmented audio. */
public final class Protocol {
    public static final int RATE = 48_000;
    public static final int FRAMES = 120;
    public static final int HEADER = 20;
    public static final int PACKET_BYTES = HEADER + FRAMES * 2 * Float.BYTES;
    private Protocol() {}

    public static int encode(byte[] output, int hash, int sequence, long timestampUs,
                             short[] input, int frames, int channels) {
        if (channels < 1 || channels > 2 || frames < 1 || frames > FRAMES
                || input.length < frames * channels || output.length < HEADER + frames * 8)
            throw new IllegalArgumentException("Invalid PCM frame");
        ByteBuffer bytes = ByteBuffer.wrap(output).order(ByteOrder.LITTLE_ENDIAN);
        bytes.put((byte)'M').put((byte)'S').put((byte)'A').put((byte)'1');
        bytes.putInt(hash).putInt(sequence).putLong(timestampUs);
        for (int i = 0; i < frames; i++) {
            float left = input[i * channels] / 32768.0f;
            float right = channels == 1 ? left : input[i * channels + 1] / 32768.0f;
            bytes.putFloat(left).putFloat(right);
        }
        return bytes.position();
    }
}
