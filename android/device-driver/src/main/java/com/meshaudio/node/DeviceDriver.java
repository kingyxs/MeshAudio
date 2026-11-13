package com.meshaudio.node;

import android.app.Instrumentation;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.*;

/** Test-only accessibility driver; never included in the application APK. */
public final class DeviceDriver extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle args){super.onCreate(args);arguments=args;start();}
    private boolean click(AccessibilityNodeInfo node,String target){
        if(node==null)return false;
        String id=node.getViewIdResourceName();CharSequence text=node.getText();
        boolean idMatch=(target.startsWith("#")&&id!=null&&id.endsWith("/"+target.substring(1)))
                || (target.startsWith("id:")&&id!=null&&id.endsWith("/"+target.substring(3)));
        if(node.isEnabled() && (idMatch || target.equals(String.valueOf(text)))) {
            AccessibilityNodeInfo action=node;
            while(action!=null && !action.isClickable()) action=action.getParent();
            if(action!=null && action.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        for(int i=0;i<node.getChildCount();i++)if(click(node.getChild(i),target))return true;
        return false;
    }
    @Override public void onStart(){
        Bundle result=new Bundle();
        try {
            android.accessibilityservice.AccessibilityServiceInfo info=getUiAutomation().getServiceInfo();
            info.flags|=android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            getUiAutomation().setServiceInfo(info);
            String target=arguments.getString("target","");
            long end=android.os.SystemClock.uptimeMillis()+5000;boolean done=false;
            while(android.os.SystemClock.uptimeMillis()<end&&!done){
                done=click(getUiAutomation().getRootInActiveWindow(),target);
                if(!done)android.os.SystemClock.sleep(100);
            }
            result.putString("driverResult",done?"clicked":"not-found");finish(done?-1:0,result);
        }catch(Exception error){result.putString("driverError",error.toString());finish(0,result);}
    }
}
