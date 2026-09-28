package ru.encryption.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Системные уведомления о новых сообщениях (без раскрытия текста в шторке при желании). */
public final class Notifications {

    private static final String CHANNEL = "encryption_messages";
    private static int counter = 100;

    public static void show(Context ctx, String title, String body) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Сообщения",
                    NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Новые сообщения Encryption");
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(ctx, CHANNEL);
        else b = new Notification.Builder(ctx);
        b.setSmallIcon(R.mipmap.ic_launcher)
         .setContentTitle(title == null ? "Encryption" : title)
         .setContentText(body == null ? "Новое сообщение" : body)
         .setAutoCancel(true)
         .setContentIntent(pi)
         .setWhen(System.currentTimeMillis());

        nm.notify(counter++, b.build());
    }

    private Notifications() {}
}
