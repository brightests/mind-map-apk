package com.example.mindmap.offline;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * APK 专用：把 WebView 里生成的导出文件真正写到系统下载目录。
 *
 * 上游 simple-mind-map 的导出链路是
 *   Export.js -> readBlob(FileReader.readAsDataURL) -> utils.downloadFile()
 *   -> document.createElement('a') + a.download + a.click()
 * Android WebView 默认没有 DownloadListener，data: / blob: 链接不会落地，
 * 所以浏览器点「导出」什么也不会发生（桌面 Chrome 才有效）。
 *
 * 这里不依赖第三方插件、不申请存储权限：
 *   Android 10 (API 29) 及以上：MediaStore.Downloads 分区存储，写入 下载/MindMap；
 *   Android 9 及以下：getExternalFilesDir(DIRECTORY_DOWNLOADS) 应用专属目录，
 *                     无需 WRITE_EXTERNAL_STORAGE，文件可从文件管理器访问。
 *
 * mobile.js 负责拦截 a.click()，把 data:URL 拆成 fileName / mimeType / base64
 * 后通过 Capacitor 的 nativePromise('ApkFile', 'saveToDownloads', ...) 调进来。
 */
@CapacitorPlugin(name = "ApkFile")
public class ApkFilePlugin extends Plugin {

    private static final String DOWNLOAD_RELATIVE_PATH =
            Environment.DIRECTORY_DOWNLOADS + "/MindMap";
    private static final int MAX_OPEN_BYTES = 30 * 1024 * 1024;

    @PluginMethod
    public void openDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "application/json",
                "application/octet-stream",
                "text/plain",
                "text/markdown",
                "application/zip",
                "*/*"
        });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "openDocumentResult");
    }

    @ActivityCallback
    private void openDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未选择文件");
            return;
        }

        ContentResolver resolver = getContext().getContentResolver();
        InputStream in = null;
        try {
            in = resolver.openInputStream(uri);
            if (in == null) {
                call.reject("无法读取所选文件");
                return;
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int read;
            int total = 0;
            while ((read = in.read(chunk)) != -1) {
                total += read;
                if (total > MAX_OPEN_BYTES) {
                    call.reject("文件超过 30 MB，请先精简后再打开");
                    return;
                }
                buffer.write(chunk, 0, read);
            }

            JSObject payload = new JSObject();
            payload.put("name", queryDisplayName(resolver, uri));
            payload.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
            payload.put("size", total);
            payload.put("cancelled", false);
            call.resolve(payload);
        } catch (Exception e) {
            call.reject("读取文件失败：" + e.getMessage());
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    // 关闭失败不影响已读出的内容
                }
            }
        }
    }

    private String queryDisplayName(ContentResolver resolver, Uri uri) {
        Cursor cursor = resolver.query(uri, null, null, null, null);
        if (cursor == null) {
            return "导图.smm";
        }
        try {
            if (cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } finally {
            cursor.close();
        }
        return "导图.smm";
    }

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String fileName = call.getString("fileName");
        String base64 = call.getString("base64");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        if (fileName == null || fileName.isEmpty() || base64 == null) {
            call.reject("缺少文件名或文件内容");
            return;
        }
        if (mimeType == null || mimeType.isEmpty()) {
            mimeType = "application/octet-stream";
        }

        final byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("文件内容不是有效的 base64");
            return;
        }

        try {
            String path;
            String uriString = "";

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, DOWNLOAD_RELATIVE_PATH);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);

                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    call.reject("系统下载目录不可写");
                    return;
                }

                OutputStream out = resolver.openOutputStream(uri);
                if (out == null) {
                    resolver.delete(uri, null, null);
                    call.reject("无法打开下载文件");
                    return;
                }
                try {
                    out.write(bytes);
                    out.flush();
                } finally {
                    out.close();
                }

                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, done, null, null);

                uriString = uri.toString();
                path = DOWNLOAD_RELATIVE_PATH + "/" + fileName;
            } else {
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) {
                    call.reject("外部存储不可用");
                    return;
                }
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建下载目录");
                    return;
                }
                File file = new File(dir, fileName);
                FileOutputStream out = new FileOutputStream(file);
                try {
                    out.write(bytes);
                    out.flush();
                } finally {
                    out.close();
                }
                path = file.getAbsolutePath();
            }

            JSObject result = new JSObject();
            result.put("name", fileName);
            result.put("path", path);
            result.put("uri", uriString);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("保存失败：" + e.getMessage());
        }
    }
}
