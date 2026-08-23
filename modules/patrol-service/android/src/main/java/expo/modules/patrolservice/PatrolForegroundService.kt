package expo.modules.patrolservice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The background job.
 *
 * PATROL is only useful if it is running when nobody is looking at it. A phone
 * in a pocket with the screen off is the normal case, not the edge case: that
 * is the phone relaying somebody else's report across a street, and that is the
 * phone that has to start screaming when a rescuer rings it.
 *
 * Android will not let an ordinary app do any of that. Backgrounded processes
 * are frozen, BLE scanning is throttled to nothing, and the JS timers that
 * drive the rotation simply stop firing. A foreground service is the only
 * sanctioned way to stay alive, and the price is a permanent notification —
 * which is the right price, because a phone quietly running its radio flat
 * should say so.
 *
 * Two things are held here and nowhere else:
 *
 *   1. Foreground status, which keeps the process off the kill list.
 *   2. A PARTIAL_WAKE_LOCK, which keeps the CPU running with the screen off.
 *      Without it Doze suspends the JS thread within minutes and the node goes
 *      silent while still appearing, to its own user, to be switched on.
 */
class PatrolForegroundService : Service() {

  companion object {
    const val CHANNEL_ID = "patrol.mesh"
    const val NOTIFICATION_ID = 4201

    const val ACTION_START = "expo.modules.patrolservice.START"
    const val ACTION_UPDATE = "expo.modules.patrolservice.UPDATE"
    const val ACTION_STOP = "expo.modules.patrolservice.STOP"

    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"

    /** Read by the module so JS can show the true state after a reload. */
    @Volatile
    var isRunning: Boolean = false
      private set

    /**
     * Set by the module while it is alive. Lets the notification's Stop button
     * tell JS to shut the radio down cleanly instead of leaving it advertising
     * into a service that no longer exists.
     */
    @Volatile
    var onStopRequested: (() -> Unit)? = null
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        // Fire the callback BEFORE tearing down: once stopSelf has run, JS may
        // never get another chance to stop the radio.
        onStopRequested?.invoke()
        shutdown()
        return START_NOT_STICKY
      }
      else -> {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "PATROL"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Listening for nearby phones"
        goForeground(title, text)
      }
    }

    // START_STICKY: if Android kills us for memory, come back. The mesh is
    // worth more than the RAM.
    return START_STICKY
  }

  private fun goForeground(title: String, text: String) {
    ensureChannel()

    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, build(title, text), serviceType())
    } catch (e: Exception) {
      // Android 14 rejects a foreground service whose declared type is not
      // backed by a granted permission. Falling back to no type keeps the
      // service alive on the paths where that happens rather than crashing the
      // app at the exact moment somebody needed it.
      try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(title, text), 0)
      } catch (_: Exception) {
        stopSelf()
        return
      }
    }

    isRunning = true
    acquireWakeLock()
  }

  /**
   * Only claim a type we can actually back with a granted permission.
   *
   * `connectedDevice` covers the BLE radio and is always true of a running
   * node. `location` is added only when fine location has actually been
   * granted — claiming it without the permission is what makes Android 14 throw
   * on startForeground.
   */
  private fun serviceType(): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0

    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
    val fineLocation = ContextCompat.checkSelfPermission(
      this,
      Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    if (fineLocation && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
    }
    return type
  }

  private fun build(title: String, text: String): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val open = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }

    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, PatrolForegroundService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      // The mesh carries other people's emergencies. Nothing in this
      // notification should be hidden on a lock screen.
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(open)
      .addAction(0, "Stop", stop)
      .build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Mesh running",
      // LOW: this notification must be unmissable but never make a sound. The
      // sound is reserved for a buzz, and a channel that cries wolf all day
      // gets muted by the user on day one.
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Shown while PATROL is relaying for nearby phones"
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    manager.createNotificationChannel(channel)
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "patrol:mesh").apply {
      setReferenceCounted(false)
      // No timeout. A timeout here would mean the node silently leaves the
      // mesh after N hours, which is the failure mode this whole class exists
      // to prevent. The user stops it from the notification, or by stopping
      // the mesh in the app.
      acquire()
    }
  }

  private fun releaseWakeLock() {
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (_: RuntimeException) {
      // Already released underneath us.
    }
    wakeLock = null
  }

  private fun shutdown() {
    releaseWakeLock()
    isRunning = false
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    releaseWakeLock()
    isRunning = false
    super.onDestroy()
  }
}
