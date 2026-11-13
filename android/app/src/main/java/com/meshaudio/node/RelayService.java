// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.projection.*;
import android.net.wifi.WifiManager;
import android.os.*;
import android.util.Log;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Capture begins only after a visible user action, never on boot or restore. */
public final class RelayService extends Service {
    static final String START_MIC="com.meshaudio.START_MIC", START_MEDIA="com.meshaudio.START_MEDIA",
            STOP_MIC="com.meshaudio.STOP_MIC", STOP_MEDIA="com.meshaudio.STOP_MEDIA", STOP_ALL="com.meshaudio.STOP_ALL";
    static volatile String latest="{}";
    private static final int NOTICE=301;
    private final Handler main=new Handler(Looper.getMainLooper());
    private CaptureWorker microphone,media;
    private MediaProjection projection;
    private String micError="",mediaError="";
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;
    private long lastWakeRenewal;
    private final MediaProjection.Callback projectionCallback=new MediaProjection.Callback() {
        @Override public void onStop() {
            if(projection!=null) {
                projection=null;
                stopOne(false);
                mediaError="系统已结束媒体授权，请返回应用重新授权启动。麦克风不受影响。";
                updateLifetime();
            }
        }
    };
    private final Runnable ticker=new Runnable(){
        @Override public void run(){
            publish();
            if(microphone!=null || media!=null) {
                if(!wake.isHeld() || SystemClock.elapsedRealtime()-lastWakeRenewal>5*60*1000L) {
                    wake.acquire(10*60*1000L);lastWakeRenewal=SystemClock.elapsedRealtime();
                }
                main.postDelayed(this,1000);
            }
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notices=getSystemService(NotificationManager.class);
        notices.createNotificationChannel(new NotificationChannel("capture","MeshAudio 音频采集",NotificationManager.IMPORTANCE_LOW));
        wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"MeshAudio:Capture");
        wake.setReferenceCounted(false);
        WifiManager manager=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);
        if(manager!=null) {wifi=manager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,"MeshAudio:Audio");wifi.setReferenceCounted(false);}
        publish();
    }
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public int onStartCommand(Intent intent,int flags,int startId) {
        if(intent==null) {stopSelf();return START_NOT_STICKY;}
        String action=intent.getAction();
        try {
            if(START_MIC.equals(action)) {
                if(microphone!=null) return START_NOT_STICKY;
                micError="";
                foreground(true,media!=null);
                microphone=new CaptureWorker(this,"microphone",null,this::workerFinished);
                microphone.start();
            } else if(START_MEDIA.equals(action)) {
                // A duplicate tap/intent must never consume a projection token twice.
                if(media!=null) return START_NOT_STICKY;
                mediaError="";
                Intent consent=Build.VERSION.SDK_INT>=33 ? intent.getParcelableExtra("projectionData",Intent.class)
                        : intent.getParcelableExtra("projectionData");
                if(consent==null || intent.getIntExtra("projectionResult",0)!=Activity.RESULT_OK)
                    throw new IllegalArgumentException("媒体授权未完成，请重新点击启动并确认系统授权");
                foreground(microphone!=null,true);
                MediaProjectionManager manager=(MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE);
                projection=manager.getMediaProjection(Activity.RESULT_OK,consent);
                if(projection==null) throw new IllegalStateException("媒体授权失效，请重新授权");
                projection.registerCallback(projectionCallback,main);
                media=new CaptureWorker(this,"media",projection,this::workerFinished);
                media.start();
            } else if(STOP_MIC.equals(action)) stopOne(true);
            else if(STOP_MEDIA.equals(action)) stopOne(false);
            else if(STOP_ALL.equals(action)) {stopOne(true);stopOne(false);}
            else {stopSelf();return START_NOT_STICKY;}
        } catch(Exception failure) {
            Log.e("MeshAudio","Cannot start requested stream",failure);
            String message=failure.getMessage()==null ? failure.getClass().getSimpleName() : failure.getMessage();
            if(START_MEDIA.equals(action)) {releaseProjection();mediaError=message;} else micError=message;
        }
        updateLifetime();
        return START_NOT_STICKY;
    }
    private void foreground(boolean mic,boolean playback) {
        int types=(mic && Build.VERSION.SDK_INT>=30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0)
                | (playback ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0);
        startForeground(NOTICE,notification(mic,playback),types);
    }
    private Notification notification(boolean mic,boolean playback) {
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,RelayService.class).setAction(STOP_ALL),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        String text=mic&&playback ? "正在采集麦克风和媒体音频 · 两路独立发送" : mic ? "正在采集麦克风 · 后台发送已启用" : "正在采集已授权的媒体音频 · 不传画面";
        return new Notification.Builder(this,"capture").setSmallIcon(R.drawable.ic_audio).setContentTitle("MeshAudio 音频采集已开启")
                .setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setOngoing(true)
                .setContentIntent(open).setCategory(Notification.CATEGORY_SERVICE).setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null,"停止全部采集",stop).build()).build();
    }
    private void stopOne(boolean mic) {
        CaptureWorker worker=mic?microphone:media;
        if(mic) microphone=null;else media=null;
        if(worker!=null) worker.stopCapture();
        if(!mic) releaseProjection();
    }
    private void releaseProjection() {
        MediaProjection active=projection;projection=null;
        if(active!=null) {active.unregisterCallback(projectionCallback);active.stop();}
    }
    private void workerFinished(CaptureWorker worker,String error) {
        main.post(()->{
            if(worker==microphone) {microphone=null;micError=error;}
            if(worker==media) {media=null;releaseProjection();mediaError=error;}
            updateLifetime();
        });
    }
    private void updateLifetime() {
        main.removeCallbacks(ticker);
        if(microphone!=null || media!=null) {
            foreground(microphone!=null,media!=null);
            if(!wake.isHeld()) {wake.acquire(10*60*1000L);lastWakeRenewal=SystemClock.elapsedRealtime();}
            if(wifi!=null && !wifi.isHeld()) wifi.acquire();
            ticker.run();
        } else {
            if(wake.isHeld()) wake.release();
            if(wifi!=null && wifi.isHeld()) wifi.release();
            stopForeground(STOP_FOREGROUND_REMOVE);
            publish();stopSelf();
        }
    }
    private JSONObject stopped(String error) throws Exception {return new JSONObject().put("state","stopped").put("packets",0).put("frames",0).put("rms",0).put("error",error);}
    private void publish() {
        try {
            JSONObject state=new JSONObject().put("version","0.3.1").put("updatedAt",System.currentTimeMillis())
                    .put("microphone",microphone==null?stopped(micError):microphone.status())
                    .put("media",media==null?stopped(mediaError):media.status());
            latest=state.toString();
            File pending=new File(getFilesDir(),"status.json.tmp");
            try(FileOutputStream output=new FileOutputStream(pending)){output.write(latest.getBytes(StandardCharsets.UTF_8));}
            if(!pending.renameTo(new File(getFilesDir(),"status.json"))) Log.w("MeshAudio","Cannot replace status snapshot");
        } catch(Exception failure) {Log.w("MeshAudio","Cannot publish state",failure);}
    }
    @Override public void onDestroy() {
        main.removeCallbacks(ticker);stopOne(true);stopOne(false);
        if(wake!=null && wake.isHeld()) wake.release();
        if(wifi!=null && wifi.isHeld()) wifi.release();
        publish();super.onDestroy();
    }
}
