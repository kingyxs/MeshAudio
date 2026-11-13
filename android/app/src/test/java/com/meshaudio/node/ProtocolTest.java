package com.meshaudio.node;

import org.junit.Test;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import static org.junit.Assert.*;

public class ProtocolTest {
    @Test public void headerIsLittleEndianAndUint32WrapIsPreserved() {
        byte[] bytes = new byte[Protocol.PACKET_BYTES];
        int size = Protocol.encode(bytes, 0xfedcba98, -1, 123456789L, new short[]{0}, 1, 1);
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(28, size); assertEquals('M', bytes[0]); assertEquals('1', bytes[3]);
        assertEquals(0xfedcba98, b.getInt(4)); assertEquals(-1, b.getInt(8)); assertEquals(123456789L, b.getLong(12));
    }
    @Test public void monoIsDuplicatedWithoutClippingOrSignErrors() {
        byte[] bytes = new byte[Protocol.PACKET_BYTES];
        Protocol.encode(bytes, 1, 2, 3, new short[]{Short.MIN_VALUE, 0, Short.MAX_VALUE}, 3, 1);
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(-1.0f, b.getFloat(20), 0); assertEquals(-1.0f, b.getFloat(24), 0);
        assertEquals(0, b.getFloat(28), 0); assertEquals(32767 / 32768.0f, b.getFloat(36), 0);
    }
    @Test public void stereoOrderAndMtuAreStable() {
        short[] pcm = new short[Protocol.FRAMES * 2]; pcm[0] = 8192; pcm[1] = -16384;
        byte[] bytes = new byte[Protocol.PACKET_BYTES];
        assertEquals(980, Protocol.encode(bytes, 1, 0, 0, pcm, Protocol.FRAMES, 2));
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(.25f, b.getFloat(20), 0); assertEquals(-.5f, b.getFloat(24), 0); assertTrue(bytes.length <= 1200);
    }
    @Test(expected=IllegalArgumentException.class) public void oversizedPacketsAreRejected() {
        Protocol.encode(new byte[2000], 0, 0, 0, new short[500], 121, 2);
    }
    @Test(expected=IllegalArgumentException.class) public void partialStereoFrameIsRejected() {
        Protocol.encode(new byte[980], 0, 0, 0, new short[1], 1, 2);
    }
}
