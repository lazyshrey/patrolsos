package expo.modules.patrolble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Connectionless BLE gossip transport.
 *
 * We never open a GATT connection. Every node broadcasts a 20-byte PATROL
 * packet inside the manufacturer-specific data of a legacy BLE advertisement
 * and simultaneously scans for the same manufacturer id. That removes MTU
 * negotiation, fragmentation, pairing and connection lifecycle entirely.
 *
 * Company id 0xFFFF is the Bluetooth SIG value reserved for testing.
 */
class PatrolBleModule : Module() {

  companion object {
    private const val MANUFACTURER_ID = 0xFFFF
  }

  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var scanCallback: ScanCallback? = null

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("No react context")

  private val adapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  override fun definition() = ModuleDefinition {
    Name("PatrolBle")

    Events("onPacket", "onError")

    /**
     * Everything the preflight screen needs. All four of these have to be true
     * before a single packet will move, and three of them fail silently.
     */
    Function("getStatus") {
      val a = adapter
      val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      mapOf(
        "hasBluetooth" to (a != null),
        "bluetoothEnabled" to (a?.isEnabled == true),
        "advertisingSupported" to (a?.isMultipleAdvertisementSupported == true),
        // Many OEM builds still gate BLE scan results on Location Services,
        // even when BLUETOOTH_SCAN is declared neverForLocation.
        "locationEnabled" to (lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true ||
          lm?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true),
        "permissionsGranted" to hasPermissions(),
        "isAdvertising" to (advertiseCallback != null),
        "isScanning" to (scanCallback != null)
      )
    }

    /**
     * Replaces the advertised payload. Android advertises one payload at a
     * time, so the JS rotation calls this repeatedly to cycle through the
     * packets this node is carrying.
     */
    AsyncFunction("setPayload") { payloadBase64: String ->
      val bytes = Base64.decode(payloadBase64, Base64.NO_WRAP)
      startAdvertisingInternal(bytes)
      null
    }

    AsyncFunction("stopAdvertising") {
      stopAdvertisingInternal()
      null
    }

    AsyncFunction("startScanning") {
      startScanningInternal()
      null
    }

    AsyncFunction("stopScanning") {
      stopScanningInternal()
      null
    }

    OnDestroy {
      stopAdvertisingInternal()
      stopScanningInternal()
    }
  }

  // -------------------------------------------------------------------------
  // Advertising
  // -------------------------------------------------------------------------

  private fun startAdvertisingInternal(payload: ByteArray) {
    val a = adapter ?: throw CodedException("Bluetooth not available")
    if (!a.isEnabled) throw CodedException("Bluetooth is off")
    if (!a.isMultipleAdvertisementSupported) {
      throw CodedException("This device cannot advertise over BLE")
    }

    stopAdvertisingInternal()

    val adv = a.bluetoothLeAdvertiser ?: throw CodedException("No BLE advertiser")
    advertiser = adv

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      // Broadcast only. Nobody connects to us, which is the whole design.
      .setConnectable(false)
      .setTimeout(0)
      .build()

    val data = AdvertiseData.Builder()
      // Critical: the device name would eat most of the 31-byte budget.
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addManufacturerData(MANUFACTURER_ID, payload)
      .build()

    val cb = object : AdvertiseCallback() {
      override fun onStartFailure(errorCode: Int) {
        sendEvent("onError", mapOf("where" to "advertise", "code" to errorCode))
      }
    }

    try {
      adv.startAdvertising(settings, data, cb)
      advertiseCallback = cb
    } catch (e: SecurityException) {
      throw CodedException("Missing BLUETOOTH_ADVERTISE permission")
    }
  }

  private fun stopAdvertisingInternal() {
    val cb = advertiseCallback ?: return
    try {
      advertiser?.stopAdvertising(cb)
    } catch (_: SecurityException) {
      // Permission revoked mid-flight; nothing useful to do.
    } catch (_: IllegalStateException) {
      // Adapter went down underneath us.
    }
    advertiseCallback = null
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  private fun startScanningInternal() {
    val a = adapter ?: throw CodedException("Bluetooth not available")
    if (!a.isEnabled) throw CodedException("Bluetooth is off")

    stopScanningInternal()

    val sc = a.bluetoothLeScanner ?: throw CodedException("No BLE scanner")
    scanner = sc

    // Empty data + empty mask matches ANY payload carrying our company id,
    // so we ignore every unrelated beacon in the room.
    val filter = ScanFilter.Builder()
      .setManufacturerData(MANUFACTURER_ID, ByteArray(0), ByteArray(0))
      .build()

    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      // ALL_MATCHES + no report delay is what keeps duplicate advertisements
      // flowing. Without it each advertiser is heard once and the mesh dies.
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setReportDelay(0)
      .build()

    val cb = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult?) {
        handleResult(result)
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>?) {
        results?.forEach { handleResult(it) }
      }

      override fun onScanFailed(errorCode: Int) {
        sendEvent("onError", mapOf("where" to "scan", "code" to errorCode))
      }
    }

    try {
      sc.startScan(listOf(filter), settings, cb)
      scanCallback = cb
    } catch (e: SecurityException) {
      throw CodedException("Missing BLUETOOTH_SCAN permission")
    }
  }

  private fun handleResult(result: ScanResult?) {
    val record = result?.scanRecord ?: return
    val payload = record.getManufacturerSpecificData(MANUFACTURER_ID) ?: return
    sendEvent(
      "onPacket",
      mapOf(
        "data" to Base64.encodeToString(payload, Base64.NO_WRAP),
        "rssi" to result.rssi
      )
    )
  }

  private fun stopScanningInternal() {
    val cb = scanCallback ?: return
    try {
      scanner?.stopScan(cb)
    } catch (_: SecurityException) {
    } catch (_: IllegalStateException) {
    }
    scanCallback = null
  }

  // -------------------------------------------------------------------------

  private fun hasPermissions(): Boolean {
    val needed = if (android.os.Build.VERSION.SDK_INT >= 31) {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT
      )
    } else {
      listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }
    return needed.all {
      ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
  }
}
