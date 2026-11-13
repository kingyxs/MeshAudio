package com.meshaudio.testplayer;

import android.app.Activity;
import android.os.Bundle;
import android.media.*;
import android.widget.*;
import java.io.*;

/** Separate opt-in fixture; no recorder, network access or hidden capture. */
public final class MainActivity extends Activity {
    private MediaPlayer player;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(1); layout.setPadding(32,64,32,32);
        TextView label = new TextView(this); label.setText("MeshAudio 媒体捕获测试\n\n即将循环播放低音量 440 Hz 测试音。此应用明确允许 Android AudioPlaybackCapture。测试结束请点击停止。"); layout.addView(label);
        Button stop = new Button(this); stop.setText("停止测试音"); stop.setOnClickListener(v -> { if(player != null) { player.release(); player=null; } finish(); }); layout.addView(stop); setContentView(layout);
        try {
            File file = new File(getCacheDir(), "test-tone.wav");
            try (DataOutputStream stream = new DataOutputStream(new FileOutputStream(file))) {
                int samples = 48000 * 2, size = samples * 2;
                stream.writeBytes("RIFF"); le(stream,36+size,4); stream.writeBytes("WAVEfmt "); le(stream,16,4); le(stream,1,2); le(stream,1,2); le(stream,48000,4); le(stream,96000,4); le(stream,2,2); le(stream,16,2); stream.writeBytes("data"); le(stream,size,4);
                for(int i=0;i<samples;i++) le(stream,(short)(Math.sin(2*Math.PI*440*i/48000)*2048),2);
            }
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL).build());
            player.setDataSource(file.getAbsolutePath()); player.setLooping(true); player.prepare(); player.start();
        } catch(Exception e) { label.append("\n测试音失败："+e.getMessage()); }
    }
    private static void le(DataOutputStream out,int value,int count) throws IOException { for(int i=0;i<count;i++) out.writeByte(value >>> (8*i)); }
    @Override public void onDestroy() { if(player!=null) player.release(); super.onDestroy(); }
}
