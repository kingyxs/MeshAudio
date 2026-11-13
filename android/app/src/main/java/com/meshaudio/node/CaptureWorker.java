// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import android.content.Context;
import android.media.*;
import android.media.projection.MediaProjection;
import android.os.Process;
import android.util.Log;
import org.json.JSONObject;

/** One source per worker. AudioRecord is the clock; no timers generate PCM. */
final class CaptureWorker extends Thread {
    interface Finished { void finish(CaptureWorker worker, String error); }
    private final Context context;
    private final NodeSettings settings;
    private final MediaProjection projection;
    private final Finished finished;
    final String type;
    private volatile boolean running = true;
    private volatile AudioRecord recorder;
    private volatile AudioTransport transport;
    private volatile ControlMonitor control;
    volatile String state="connecting", error="", destination="", sourceId="";
    volatile long packets, samples, reconnects;
    volatile double rms;
    private long sequence, sequenceLimit;

    CaptureWorker(Context context, String type, MediaProjection projection, Finished finished) {
        super("MeshAudio-"+type); this.context=context; this.type=type; this.projection=projection;
        this.finished=finished; settings=new NodeSettings(context);
    }
    void stopCapture() {
        running=false; state="stopping";
        AudioTransport active=transport; if(active!=null) active.close();
        ControlMonitor monitor=control; if(monitor!=null) monitor.close();
        AudioRecord record=recorder;
        if(record!=null) try { record.stop(); } catch(IllegalStateException ignored) {}
        interrupt();
    }
    private AudioRecord createRecorder() {
        if(context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)!=android.content.pm.PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("音频录制权限已被撤销，请重新授权");
        int channels=projection==null ? AudioFormat.CHANNEL_IN_MONO : AudioFormat.CHANNEL_IN_STEREO;
        int minimum=AudioRecord.getMinBufferSize(Protocol.RATE,channels,AudioFormat.ENCODING_PCM_16BIT);
        if(minimum<=0) throw new IllegalStateException("手机不支持 48 kHz 音频采集");
        AudioFormat format=new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(Protocol.RATE).setChannelMask(channels).build();
        AudioRecord.Builder builder=new AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(Math.max(minimum, 3840));
        if(projection==null) {
            AudioManager audio=(AudioManager)context.getSystemService(Context.AUDIO_SERVICE);
            boolean unprocessed="true".equals(audio.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
            builder.setAudioSource(unprocessed ? MediaRecorder.AudioSource.UNPROCESSED : MediaRecorder.AudioSource.VOICE_RECOGNITION);
        } else builder.setAudioPlaybackCaptureConfig(new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN).excludeUid(Process.myUid()).build());
        AudioRecord result=builder.build();
        if(result.getState()!=AudioRecord.STATE_INITIALIZED) { result.release(); throw new IllegalStateException("音频采集初始化失败"); }
        return result;
    }
    private int nextSequence() {
        if(sequence>=sequenceLimit) { sequence=settings.reserveSequences(type); sequenceLimit=sequence+1_048_576L; }
        return (int)sequence++;
    }
    @Override public void run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        String fatal="";
        try {
            recorder=createRecorder();
            int channels=projection==null ? 1 : 2;
            short[] input=new short[Protocol.FRAMES*channels];
            byte[] packet=new byte[Protocol.PACKET_BYTES];
            int retry=0;
            while(running) {
                try {
                    state=retry==0 ? "connecting" : "reconnecting";
                    transport=AudioTransport.open(context,settings,type);
                    if(!running) break;
                    Discovery.Endpoint endpoint=transport.endpoint();
                    sourceId=endpoint.sourceId;
                    destination=endpoint.host+":"+(settings.websocket()?endpoint.controlPort:endpoint.audioPort);
                    control=new ControlMonitor(endpoint);
                    long lastControlAttempt=android.os.SystemClock.elapsedRealtime();
                    recorder.startRecording(); error=""; retry=0; state="streaming";
                    boolean recording=true;
                    while(running) {
                        long now=android.os.SystemClock.elapsedRealtime();
                        if(control!=null && !control.connected && now-lastControlAttempt>5000) {
                            control.close();control=new ControlMonitor(endpoint);lastControlAttempt=now;
                        }
                        boolean paused=control!=null && control.paused;
                        if(paused) {
                            state="paused";
                            if(recording) {recorder.stop(); recording=false;}
                            Thread.sleep(50); continue;
                        }
                        if(!recording) {recorder.startRecording(); recording=true;}
                        state="streaming";
                        int count=recorder.read(input,0,input.length,AudioRecord.READ_BLOCKING);
                        if(!running) break;
                        if(count<0) throw new IllegalStateException("音频读取失败（"+count+"），请停止后重新授权启动");
                        if(count==0) continue;
                        if(count%channels!=0) throw new IllegalStateException("采集返回了不完整声道帧");
                        int frames=count/channels;
                        // Capture time is in the monotonic device clock domain; it is
                        // not advertised as an end-to-end network latency measurement.
                        long time=android.os.SystemClock.elapsedRealtimeNanos()/1000-frames*1_000_000L/Protocol.RATE;
                        int length=Protocol.encode(packet,endpoint.sourceHash,nextSequence(),time,input,frames,channels);
                        transport.send(packet,length); packets++; samples+=frames;
                        double sum=0; for(int i=0;i<count;i++){double x=input[i]/32768.0;sum+=x*x;} rms=Math.sqrt(sum/count);
                    }
                } catch(java.io.IOException network) {
                    if(!running) break;
                    error=network.getMessage()==null ? "网络连接失败" : network.getMessage();
                    state="reconnecting"; reconnects++; retry++;
                    Log.w("MeshAudio",type+" network: "+error);
                } finally {
                    try { if(recorder.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING) recorder.stop(); } catch(Exception ignored) {}
                    AudioTransport active=transport; transport=null; if(active!=null) active.close();
                    ControlMonitor monitor=control; control=null; if(monitor!=null) monitor.close();
                }
                if(running) Thread.sleep(Math.min(8000,500L << Math.min(retry,4)));
            }
        } catch(InterruptedException stopped) {
            if(running) fatal="采集线程被意外中断";
        } catch(Exception failure) {
            if(running) {fatal=failure.getMessage()==null ? failure.getClass().getSimpleName() : failure.getMessage();Log.e("MeshAudio",type+" capture failed",failure);}
        } finally {
            AudioRecord record=recorder; recorder=null; if(record!=null) record.release();
            AudioTransport active=transport; if(active!=null) active.close();
            ControlMonitor monitor=control; if(monitor!=null) monitor.close();
            running=false;state="stopped";finished.finish(this,fatal);
        }
    }
    JSONObject status() {
        JSONObject result=new JSONObject();
        try {
            ControlMonitor monitor=control;
            result.put("state",state).put("packets",packets).put("frames",samples).put("rms",rms)
                    .put("reconnects",reconnects).put("error",error).put("endpoint",destination)
                    .put("sourceId",sourceId).put("controlConnected",monitor!=null && monitor.connected)
                    .put("desktopConfirmed",monitor!=null && monitor.confirmed)
                    .put("desktopPackets",monitor==null ? 0 : monitor.receivedPackets);
        } catch(Exception ignored) {}
        return result;
    }
}
