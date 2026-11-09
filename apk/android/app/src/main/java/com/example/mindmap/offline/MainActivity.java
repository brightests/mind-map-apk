package com.example.mindmap.offline;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件必须在 super.onCreate() 之前注册：BridgeActivity.load() 在
        // super.onCreate() 内部消费 initialPlugins，之后注册不会被 Bridge 装载。
        // ApkFilePlugin 提供导出文件写入系统下载目录的能力（WebView 无下载监听）。
        registerPlugin(ApkFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
