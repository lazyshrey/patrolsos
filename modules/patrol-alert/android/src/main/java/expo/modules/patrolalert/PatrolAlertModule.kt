package expo.modules.patrolalert

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The siren.
 *
 * Trilateration narrows a silent phone down to a circle tens of metres across.
 * That is enough to pick the right building and not enough to pick the right
 * room, let alone the right void under a slab. The last few metres are solved
 * with ears.
 *
 * Three decisions make this loud enough to be worth having:
 *
 *   STREAM_ALARM, not the notification or media stream. Alarm audio plays
 *   through silent mode and through Do Not Disturb, because that is what alarms
 *   are for. A rescue tool that respects a mute switch is a rescue tool that
 *   fails in the one situation it exists for.
 *
 *   The alarm stream volume is forced to maximum for the duration and put back
 *   afterwards. A phone found at 20% volume under a metre of concrete is a
 *   phone not found.
 *
 *   Vibration runs alongside the sound rather than instead of it. Sound
 *   travels through air pockets, vibration travels through the slab the phone
 *   is resting on, and neither one alone is reliable in rubble.
 *
 * Everything is bounded: the alarm stops itself after the requested number of
 * seconds even if the app is killed mid-ring, and it can always be silenced by
 * hand.
 */
class PatrolAlertModule : Module() {

  companion object {
    const val CHANNEL_ID = "patrol.buzz"
    const val NOTIFICATION_ID = 4202
  }

  private val main = Handler(Looper.getMainLooper())

  @Volatile
  private var player: MediaPlayer? = null
  private var vibrator: Vibrator? = null

  @Volatile
  private var stopAt: Long = 0
  private var previousVolume: Int? = null
  private val autoStop = Runnable { silence(notify = true) }

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("No react context")

  override fun definition() = ModuleDefinition {
    Name("PatrolAlert")

    Events("onRingEnd")

    Function("isRinging") { player != null }

    /**
     * Start the alarm. Calling it again while ringing extends the deadline and
     * refreshes the notification rather than restarting the sound — a stutter
     * is worse than a steady tone to walk towards.
     */
    AsyncFunction("ring") { seconds: Int, who: String, detail: String ->
      val bounded = seconds.coerceIn(5, 180)
      stopAt = System.currentTimeMillis() + bounded * 1000L

      // MediaPlayer, Vibrator and the auto-stop timer all belong to one thread
      // or they race each other. Expo async functions run off a module queue,
      // so everything is marshalled onto main here and nowhere else.
      main.post {
        showNotification(who, detail)
        startSound()
        startVibration()
        main.removeCallbacks(autoStop)
        main.postDelayed(autoStop, bounded * 1000L)
      }
      null
    }

    AsyncFunction("stop") {
      main.post { silence(notify = false) }
      null
    }

    /** Milliseconds of alarm left, or 0. Lets the UI count down honestly. */
    Function("remainingMs") {
      if (player == null) 0.0 else (stopAt - System.currentTimeMillis()).coerceAtLeast(0).toDouble()
    }

    OnDestroy {
      // The module dies on a JS reload. An alarm that outlives the code able to
      // stop it would be a phone nobody can shut up.
      main.post { silence(notify = false) }
    }
  }

  // ---------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------

  private fun startSound() {
    if (player != null) return

    val uri = alarmUri() ?: return
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    audio?.let {
      // Remember what the user had, so a rescue buzz does not permanently
      // reset their morning alarm volume.
      if (previousVolume == null) previousVolume = it.getStreamVolume(AudioManager.STREAM_ALARM)
      try {
        it.setStreamVolume(
          AudioManager.STREAM_ALARM,
          it.getStreamMaxVolume(AudioManager.STREAM_ALARM),
          0
        )
      } catch (_: SecurityException) {
        // A DND policy can refuse the change. The alarm still plays.
      }
    }

    val mp = MediaPlayer()
    mp.setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
    )

    try {
      mp.setDataSource(context, uri)
      mp.isLooping = true
      mp.setOnErrorListener { _, _, _ ->
        main.post { silence(notify = true) }
        true
      }
      mp.prepare()
      mp.start()
    } catch (_: Exception) {
      mp.release()
      restoreVolume()
      return
    }

    player = mp
  }

  /** Prefer a real alarm tone; fall back through anything the phone has. */
  private fun alarmUri(): Uri? =
    RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

  private fun stopSound() {
    player?.let {
      try {
        if (it.isPlaying) it.stop()
      } catch (_: IllegalStateException) {
      }
      it.release()
    }
    player = null
    restoreVolume()
  }

  private fun restoreVolume() {
    val restore = previousVolume ?: return
    previousVolume = null
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    try {
      audio?.setStreamVolume(AudioManager.STREAM_ALARM, restore, 0)
    } catch (_: SecurityException) {
      // A DND policy took the stream away from us. Nothing to undo.
    }
  }

  // ---------------------------------------------------------------------------
  // Vibration
  // ---------------------------------------------------------------------------

  private fun startVibration() {
    val v = resolveVibrator() ?: return
    vibrator = v

    // Long pulses with short gaps: distinctive enough not to be mistaken for a
    // message, and long enough to be felt through a bag or a coat.
    val pattern = longArrayOf(0, 700, 300, 700, 900)
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    try {
      v.vibrate(VibrationEffect.createWaveform(pattern, 0), attributes)
    } catch (_: Exception) {
      // No vibrator, or the OEM refused. The sound carries it.
    }
  }

  private fun resolveVibrator(): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

  private fun stopVibration() {
    try {
      vibrator?.cancel()
    } catch (_: Exception) {
    }
    vibrator = null
  }

  // ---------------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------------

  private fun showNotification(who: String, detail: String) {
    ensureChannel()

    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val open = launch?.let {
      PendingIntent.getActivity(context, 2, it, PendingIntent.FLAG_IMMUTABLE)
    }

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(who)
      .setContentText(detail)
      .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
      .setSmallIcon(android.R.drawable.stat_notify_error)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      // The channel is silent by design: MediaPlayer owns the sound so it can
      // use the alarm stream and be stopped precisely.
      .setSilent(true)
      .setContentIntent(open)

    // Wakes the screen straight into the app on a locked phone, where a
    // heads-up banner would go unseen.
    if (open != null) builder.setFullScreenIntent(open, true)

    try {
      NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS denied. The alarm is still audible, which is the
      // part that matters.
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Someone is looking for you",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "A nearby phone rang this one to find it"
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      setBypassDnd(true)
    }
    manager.createNotificationChannel(channel)
  }

  private fun clearNotification() {
    try {
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    } catch (_: Exception) {
    }
  }

  // ---------------------------------------------------------------------------

  private fun silence(notify: Boolean) {
    main.removeCallbacks(autoStop)
    val wasRinging = player != null
    stopSound()
    stopVibration()
    clearNotification()
    stopAt = 0
    if (notify && wasRinging) {
      try {
        sendEvent("onRingEnd", mapOf<String, Any>())
      } catch (_: Exception) {
        // JS is gone. Nothing to tell.
      }
    }
  }
}
