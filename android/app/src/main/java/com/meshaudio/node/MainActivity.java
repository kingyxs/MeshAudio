// SPDX-License-Identifier: GPL-3.0-or-later
package com.meshaudio.node;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int AUDIO_PERMISSION=40,PROJECTION=41;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private NodeSettings settings;
    private EditText host,discoveryPort,controlPort;
    private Spinner mode;
    private TextView connection,micState,mediaState,micStats,mediaStats;
    private Button micButton,mediaButton,scanButton,saveButton;
    private boolean pendingProjection,actionPending,scanning;
    private String pendingAction="";
    private final Runnable refresh=new Runnable(){@Override public void run(){renderState();handler.postDelayed(this,800);}};

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);settings=new NodeSettings(this);settings.deviceId();
        if(saved!=null) {pendingProjection=saved.getBoolean("pendingProjection");actionPending=saved.getBoolean("actionPending");pendingAction=saved.getString("pendingAction","");}
        ScrollView scroll=new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout page=new LinearLayout(this);page.setOrientation(LinearLayout.VERTICAL);page.setPadding(dp(22),dp(24),dp(22),dp(32));scroll.addView(page);
        // Insets remain explicit when targetSdk 35 enforces edge-to-edge.
        scroll.setOnApplyWindowInsetsListener((view,insets)->{
            if(Build.VERSION.SDK_INT>=30) {
                android.graphics.Insets safe=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());
                view.setPadding(safe.left,safe.top,safe.right,safe.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView title=text("MeshAudio",32,0xfff4f6fb);title.setTypeface(Typeface.create("serif",Typeface.NORMAL));page.addView(title);
        page.addView(text("Android 音频节点 · 0.3.1",13,0xffaeb7c7));
        TextView intro=text("将手机音频发送到电脑。两类音频各自成为独立来源，混音与连线在桌面端完成。",14,0xffc2cad8);margin(intro,16,22);page.addView(intro);

        LinearLayout network=panel(page,"连接电脑");
        network.addView(text("电脑 IP（留空自动发现，仅 UDP）",13,0xffc2cad8));
        host=input(settings.host(),"例如 192.168.0.30",false,R.id.desktop_host);network.addView(host);
        LinearLayout ports=new LinearLayout(this);ports.setOrientation(LinearLayout.HORIZONTAL);network.addView(ports);
        LinearLayout d=column();d.addView(text("发现端口",12,0xffaeb7c7));discoveryPort=input(String.valueOf(settings.discoveryPort()),"4174",true,R.id.discovery_port);d.addView(discoveryPort);
        LinearLayout c=column();c.addView(text("兼容/控制端口",12,0xffaeb7c7));controlPort=input(String.valueOf(settings.controlPort()),"4173",true,R.id.control_port);c.addView(controlPort);
        ports.addView(d,new LinearLayout.LayoutParams(0,-2,1));LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(0,-2,1);cp.leftMargin=dp(12);ports.addView(c,cp);
        mode=new Spinner(this);mode.setId(R.id.transport_mode);mode.setContentDescription("音频传输方式");
        ArrayAdapter<String> options=new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"局域网 · UDP（推荐）","兼容连接 · WebSocket"});mode.setAdapter(options);mode.setSelection(settings.websocket()?1:0);network.addView(mode,new LinearLayout.LayoutParams(-1,dp(52)));
        LinearLayout commands=new LinearLayout(this);commands.setOrientation(LinearLayout.HORIZONTAL);
        saveButton=button("保存连接",R.id.save_connection,v->save());scanButton=button("探测桌面端",R.id.probe_desktop,v->probe());
        commands.addView(saveButton,new LinearLayout.LayoutParams(0,dp(48),1));LinearLayout.LayoutParams sc=new LinearLayout.LayoutParams(0,dp(48),1);sc.leftMargin=dp(8);commands.addView(scanButton,sc);network.addView(commands);
        connection=text("仅在可信局域网使用。音频未加密；请勿填写不信任的服务器地址。",12,0xffaeb7c7);margin(connection,12,0);network.addView(connection);

        LinearLayout mic=panel(page,"麦克风");
        mic.addView(text("采集真实麦克风；启动后通过前台服务与常驻通知保持后台发送。",13,0xffc2cad8));
        micState=text("未启动",15,0xff8fbaff);margin(micState,12,0);mic.addView(micState);
        micStats=text("48 kHz · 单声道采集 / 双声道发送",12,0xffaeb7c7);mic.addView(micStats);
        micButton=button("启动麦克风",R.id.toggle_microphone,v->toggle("microphone"));margin(micButton,12,0);mic.addView(micButton,new LinearLayout.LayoutParams(-1,dp(50)));

        LinearLayout media=panel(page,"媒体音频");
        media.addView(text("每次启动需系统授权。仅转发允许捕获的应用音频，不采集或传输画面；部分视频、直播、通话及受保护内容可能禁止捕获。",13,0xffc2cad8));
        mediaState=text("未启动",15,0xff8fbaff);margin(mediaState,12,0);media.addView(mediaState);
        mediaStats=text("48 kHz · 双声道 · AudioPlaybackCapture",12,0xffaeb7c7);media.addView(mediaStats);
        mediaButton=button("启动媒体音频",R.id.toggle_media,v->toggle("media"));margin(mediaButton,12,0);media.addView(mediaButton,new LinearLayout.LayoutParams(-1,dp(50)));

        Button stop=button("停止全部采集",R.id.stop_all,v->{send(RelayService.STOP_ALL,null,0);pendingAction="";});page.addView(stop,new LinearLayout.LayoutParams(-1,dp(52)));
        Button help=button("权限、后台与排错说明",R.id.open_help,v->new AlertDialog.Builder(this).setTitle("使用说明")
                .setMessage("1. 电脑与手机连接同一局域网，启动桌面程序，允许专用网络访问。\n\n2. 手机只发送音源，不决定路由。桌面需连接 来源 → 通道 → 输出，并检查增益与静音。\n\n3. 麦克风、媒体音频分别授权和启停。首次授权被拒绝时可重试；永久拒绝需到系统应用权限中启用。不会自动复用旧的屏幕捕获授权。\n\n4. 后台采集会显示常驻通知。厂商省电策略可能终止后台服务，可由你自行调整。系统终止后不会偷偷恢复采集。\n\n5. 系统可能在锁屏、投屏变化或撤销授权时结束媒体会话（包括较新 Android 的限制）；需要返回本应用重新授权。\n\n6. 兼容模式复用桌面音频网关，仍发送 PCM，不代表省带宽或完整端到端低延迟。\n\n开源许可：GPL-3.0-or-later。OkHttp、Okio 与 Kotlin 标准库依各自 Apache-2.0 许可使用。")
                .setPositiveButton("知道了",null).show());margin(help,8,0);page.addView(help,new LinearLayout.LayoutParams(-1,dp(48)));
        setContentView(scroll);renderState();
    }
    private LinearLayout panel(LinearLayout page,String heading) {
        LinearLayout p=column();p.setPadding(dp(17),dp(18),dp(17),dp(18));p.setBackground(shape(0xff1c222d,16,0xff354051));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(18);page.addView(p,lp);
        TextView h=text(heading,19,0xfff4f6fb);h.setTypeface(null,Typeface.BOLD);margin(h,0,12);p.addView(h);return p;
    }
    private LinearLayout column(){LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);return layout;}
    private TextView text(String value,int size,int color){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);t.setLineSpacing(dp(3),1);return t;}
    private EditText input(String value,String hint,boolean numeric,int id){EditText t=new EditText(this);t.setId(id);t.setSingleLine(true);t.setTextSize(15);t.setTextColor(0xfff4f6fb);t.setHintTextColor(0xff8793a7);t.setText(value);t.setHint(hint);t.setContentDescription(hint);t.setInputType(numeric?android.text.InputType.TYPE_CLASS_NUMBER:android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);t.setPadding(dp(12),dp(4),dp(12),dp(4));t.setBackground(shape(0xff131923,9,0xff485569));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(48));p.topMargin=dp(7);p.bottomMargin=dp(12);t.setLayoutParams(p);return t;}
    private Button button(String title,int id,View.OnClickListener onClick){Button b=new Button(this);b.setId(id);b.setText(title);b.setTextSize(14);b.setAllCaps(false);b.setTextColor(0xfff4f6fb);b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(0xff304566));b.setPadding(dp(8),0,dp(8),0);b.setMinHeight(dp(48));b.setOnClickListener(onClick);return b;}
    private GradientDrawable shape(int color,int radius,int line){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));d.setStroke(dp(1),line);return d;}
    private int dp(int px){return Math.round(px*getResources().getDisplayMetrics().density);}
    private void margin(View view,int top,int bottom){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(top);p.bottomMargin=dp(bottom);view.setLayoutParams(p);}
    private void message(String text){connection.setText(text);Toast.makeText(this,text,Toast.LENGTH_LONG).show();}

    private boolean save(){
        try {settings.save(host.getText().toString().trim(),Integer.parseInt(discoveryPort.getText().toString()),Integer.parseInt(controlPort.getText().toString()),mode.getSelectedItemPosition()==1);connection.setText("连接设置已保存。启动音源后，请在电脑画布中完成连线。");return true;}
        catch(Exception error){message(error.getMessage()==null?"请检查地址和端口":error.getMessage());return false;}
    }
    private boolean active(String type){try{return !"stopped".equals(new JSONObject(RelayService.latest).optJSONObject(type).optString("state","stopped"));}catch(Exception ignored){return false;}}
    private void toggle(String type){
        if(active(type)) {send(type.equals("microphone")?RelayService.STOP_MIC:RelayService.STOP_MEDIA,null,0);return;}
        if(actionPending||pendingProjection) return;
        if(!save()) return;
        pendingAction=type;actionPending=true;renderState();
        ArrayList<String> permissions=new ArrayList<>();
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.RECORD_AUDIO);
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        if(!permissions.isEmpty()) requestPermissions(permissions.toArray(new String[0]),AUDIO_PERMISSION);else continueStart();
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] result){
        super.onRequestPermissionsResult(request,permissions,result);
        if(request!=AUDIO_PERMISSION) return;
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){actionPending=false;pendingAction="";message("麦克风/音频录制权限未授权，本次未启动采集。可重新点击或到系统应用权限中启用。");renderState();return;}
        continueStart();
    }
    private void continueStart(){
        if("media".equals(pendingAction)) {
            pendingProjection=true;
            try {startActivityForResult(((MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE)).createScreenCaptureIntent(),PROJECTION);}
            catch(Exception error){pendingProjection=false;actionPending=false;pendingAction="";message("无法打开系统媒体授权："+error.getMessage());}
        } else {send(RelayService.START_MIC,null,0);actionPending=false;pendingAction="";}
        renderState();
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request!=PROJECTION) return;
        pendingProjection=false;actionPending=false;pendingAction="";
        if(result==RESULT_OK&&data!=null) send(RelayService.START_MEDIA,data,result);
        else message("媒体授权已取消，没有启动媒体采集。麦克风状态不变。");
        renderState();
    }
    private void send(String action,Intent projection,int result){
        try {
            Intent request=new Intent(this,RelayService.class).setAction(action);
            if(projection!=null) request.putExtra("projectionData",projection).putExtra("projectionResult",result);
            if(action.equals(RelayService.START_MIC)||action.equals(RelayService.START_MEDIA)) startForegroundService(request);
            else startService(request);
        }catch(Exception failure){message("无法切换采集状态："+failure.getMessage());}
    }
    private void probe(){
        if(scanning||!save()) return;
        scanning=true;scanButton.setEnabled(false);connection.setText("正在查找桌面端…");
        new Thread(()->{
            String answer;
            try {
                if(settings.websocket()) {
                    okhttp3.Request request=new okhttp3.Request.Builder().url("http://"+settings.host()+":"+settings.controlPort()+"/api/server-info").build();
                    okhttp3.Call call=AudioTransport.HTTP.newCall(request);call.timeout().timeout(5,java.util.concurrent.TimeUnit.SECONDS);
                    try(okhttp3.Response response=call.execute()){if(!response.isSuccessful())throw new Exception("HTTP "+response.code());answer="已找到桌面端："+settings.host()+"（兼容模式）";}
                } else {Discovery.Endpoint endpoint=Discovery.find(this,settings,"microphone");answer="已找到桌面端："+endpoint.host+" · 音频 UDP "+endpoint.audioPort;}
            }catch(Exception failure){answer="连接失败："+failure.getMessage();}
            final String text=answer;handler.post(()->{scanning=false;scanButton.setEnabled(true);connection.setText(text);});
        },"MeshAudio-probe").start();
    }
    private void renderState(){
        try {
            JSONObject state=new JSONObject(RelayService.latest);
            renderOne(state.optJSONObject("microphone"),micState,micStats,micButton,"麦克风");
            renderOne(state.optJSONObject("media"),mediaState,mediaStats,mediaButton,"媒体音频");
        }catch(Exception ignored){}
        boolean running=active("microphone")||active("media");
        for(View input:new View[]{host,discoveryPort,controlPort,mode,saveButton})input.setEnabled(!running&&!actionPending&&!pendingProjection);
        scanButton.setEnabled(!scanning&&!actionPending&&!pendingProjection);
        micButton.setEnabled(!actionPending&&!pendingProjection);mediaButton.setEnabled(!actionPending&&!pendingProjection);
        if(pendingProjection)mediaButton.setText("等待系统授权…");
    }
    private void renderOne(JSONObject state,TextView status,TextView stats,Button button,String name){
        if(state==null){button.setText("启动"+name);return;}
        String phase=state.optString("state","stopped"),error=state.optString("error");
        String label=switch(phase){case "connecting"->"正在连接桌面端…";case "streaming"->state.optBoolean("desktopConfirmed")?"正在发送 · 桌面已确认接收":"正在发送 · 请在桌面检查音源与连线";case "reconnecting"->"网络断开，正在重连…";case "paused"->"桌面已暂停此来源";case "stopping"->"正在停止…";default->"未启动";};
        status.setText(error.isEmpty()?label:label+"\n"+error);
        if(!phase.equals("stopped")) stats.setText(String.format(Locale.ROOT,"%s · 已发送 %,d 包 · %.1f dBFS",state.optString("endpoint","连接中"),state.optLong("packets"),20*Math.log10(Math.max(1e-6,state.optDouble("rms",0)))));
        else stats.setText(name.equals("麦克风")?"48 kHz · 单声道采集 / 双声道发送":"每次启动需重新授权 · 不传画面");
        button.setText((phase.equals("stopped")?"启动":"停止")+name);
    }
    @Override protected void onResume(){super.onResume();handler.removeCallbacks(refresh);handler.post(refresh);}
    @Override protected void onPause(){handler.removeCallbacks(refresh);super.onPause();}
    @Override protected void onSaveInstanceState(Bundle out){out.putBoolean("pendingProjection",pendingProjection);out.putBoolean("actionPending",actionPending);out.putString("pendingAction",pendingAction);super.onSaveInstanceState(out);}
}
