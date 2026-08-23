package expo.modules.patrolservice

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS handle on the foreground service.
 *
 * Deliberately thin: the service owns the wake lock and the notification, and
 * this class only starts, retitles and stops it. Keeping the lifetime in the
 * service rather than in the module matters because the module dies on every
 * JS reload and the service must not.
 */
class PatrolServiceModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("No react context")

  override fun definition() = ModuleDefinition {
    Name("PatrolService")

    Events("onStopRequested")

    OnCreate {
      PatrolForegroundService.onStopRequested = {
        // The user pressed Stop on the notification. JS has to hear about it or
        // it will keep believing the mesh is up.
        sendEvent("onStopRequested", mapOf<String, Any>())
      }
    }

    Function("getStatus") {
      mapOf(
        "running" to PatrolForegroundService.isRunning,
        "notificationsAllowed" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "batteryUnrestricted" to isIgnoringBatteryOptimizations()
      )
    }

    /**
     * Idempotent: calling it while the service is up just re-titles it, which
     * is how the notification tracks the peer count.
     */
    AsyncFunction("start") { title: String, text: String ->
      send(PatrolForegroundService.ACTION_START, title, text)
      null
    }

    AsyncFunction("update") { title: String, text: String ->
      // Never resurrect a stopped service from a routine text update.
      if (PatrolForegroundService.isRunning) {
        send(PatrolForegroundService.ACTION_UPDATE, title, text)
      }
      null
    }

    AsyncFunction("stop") {
      val intent = Intent(context, PatrolForegroundService::class.java)
        .setAction(PatrolForegroundService.ACTION_STOP)
      try {
        context.startService(intent)
      } catch (_: IllegalStateException) {
        // Not running, or the process is already backgrounded past the point
        // where it may start services. Either way there is nothing to stop.
      }
      null
    }

    /**
     * Sends the user to the exemption prompt. Doze is the single biggest reason
     * a node goes quiet overnight while its owner believes it is still relaying.
     */
    AsyncFunction("requestBatteryExemption") {
      if (isIgnoringBatteryOptimizations()) return@AsyncFunction true

      val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

      try {
        context.startActivity(direct)
        return@AsyncFunction true
      } catch (_: Exception) {
        // Some OEM builds and Play-restricted configurations refuse the direct
        // prompt. The full list always opens.
      }

      try {
        context.startActivity(
          Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        true
      } catch (_: Exception) {
        false
      }
    }

    OnDestroy {
      PatrolForegroundService.onStopRequested = null
    }
  }

  private fun send(action: String, title: String, text: String) {
    val intent = Intent(context, PatrolForegroundService::class.java)
      .setAction(action)
      .putExtra(PatrolForegroundService.EXTRA_TITLE, title)
      .putExtra(PatrolForegroundService.EXTRA_TEXT, text)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ContextCompat.startForegroundService(context, intent)
    } else {
      context.startService(intent)
    }
  }

  private fun isIgnoringBatteryOptimizations(): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return pm.isIgnoringBatteryOptimizations(context.packageName)
  }
}
