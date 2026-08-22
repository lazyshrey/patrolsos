package expo.modules.patrolwifi

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pGroup
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Wi-Fi Direct bulk transport.
 *
 * BLE advertisement gossip is the floor that always works: 20 bytes at a time,
 * low power, no connection. This module is the opportunistic upgrade — when two
 * nodes are close enough, they form a Wi-Fi Direct group and exchange their
 * ENTIRE packet store in one shot instead of dribbling 20 bytes per advertising
 * slot.
 *
 * THE DIALOG PROBLEM AND WHY THIS WORKS
 * -------------------------------------
 * Classic Wi-Fi Direct pairing shows an "invitation" dialog, which makes it
 * useless for an unattended mesh. Android 10+ lets us skip it entirely: build a
 * WifiP2pConfig with an explicit network name and passphrase and call
 * createGroup(), and the group forms autonomously with no user interaction.
 *
 * Peers do not need to exchange those credentials, because both sides DERIVE
 * them from a shared constant plus a day bucket (see src/services/wifiCreds.ts).
 * Rotating daily also stops the network name becoming a permanent tracking
 * beacon for anyone watching the airwaves.
 *
 * The wire format on the socket is deliberately trivial: a uint16 count followed
 * by that many fixed 20-byte PATROL packets. Everything above — dedup, CRDT
 * merge, TTL — is the exact same code path as a packet heard over BLE.
 */
class PatrolWifiModule : Module() {

  companion object {
    private const val PORT = 8988
    private const val PACKET_SIZE = 20
    /** A hostile peer must not be able to make us allocate unbounded memory. */
    private const val MAX_PACKETS = 4096
    private const val SOCKET_TIMEOUT_MS = 8000
  }

  private var manager: WifiP2pManager? = null
  private var channel: WifiP2pManager.Channel? = null
  private var receiver: BroadcastReceiver? = null

  private var serverSocket: ServerSocket? = null
  private val serverRunning = AtomicBoolean(false)

  /** Packets we hand to any peer that connects. Replaced from JS. */
  @Volatile
  private var outgoing: ByteArray = ByteArray(0)

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("No react context")

  override fun definition() = ModuleDefinition {
    Name("PatrolWifi")

    Events("onGroupInfo", "onPeerData", "onError")

    Function("getStatus") {
      val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      mapOf(
        "supported" to context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT),
        "wifiEnabled" to (wifi?.isWifiEnabled == true),
        // Autonomous, dialog-free group formation needs the Android 10 config API.
        "canFormGroupSilently" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
        "permissionsGranted" to hasPermissions(),
        "serverRunning" to serverRunning.get()
      )
    }

    AsyncFunction("initialize") {
      if (manager == null) {
        manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
          ?: throw CodedException("Wi-Fi Direct not available")
        channel = manager!!.initialize(context, Looper.getMainLooper(), null)
        registerReceiver()
      }
      null
    }

    /**
     * Become the group owner. Forms an autonomous group with the given
     * credentials — no invitation dialog, nothing for the user to accept.
     */
    AsyncFunction("createGroup") { networkName: String, passphrase: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw CodedException("Silent group creation needs Android 10 or newer")
      }
      val m = manager ?: throw CodedException("Call initialize() first")
      val c = channel ?: throw CodedException("Call initialize() first")
      requirePermissions()

      // Android requires the network name to start with "DIRECT-".
      val name = if (networkName.startsWith("DIRECT-")) networkName else "DIRECT-$networkName"

      val config = WifiP2pConfig.Builder()
        .setNetworkName(name)
        .setPassphrase(passphrase)
        // Non-persistent: the group dies with us rather than being silently
        // rejoined tomorrow with yesterday's rotated credentials.
        .enablePersistentMode(false)
        .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_AUTO)
        .build()

      try {
        m.createGroup(c, config, actionListener("createGroup"))
      } catch (e: SecurityException) {
        throw CodedException("Missing NEARBY_WIFI_DEVICES / location permission")
      }
      null
    }

    /** Join an existing group formed with the same derived credentials. */
    AsyncFunction("joinGroup") { networkName: String, passphrase: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw CodedException("Silent join needs Android 10 or newer")
      }
      val m = manager ?: throw CodedException("Call initialize() first")
      val c = channel ?: throw CodedException("Call initialize() first")
      requirePermissions()

      val name = if (networkName.startsWith("DIRECT-")) networkName else "DIRECT-$networkName"
      val config = WifiP2pConfig.Builder()
        .setNetworkName(name)
        .setPassphrase(passphrase)
        .enablePersistentMode(false)
        .build()

      try {
        m.connect(c, config, actionListener("joinGroup"))
      } catch (e: SecurityException) {
        throw CodedException("Missing NEARBY_WIFI_DEVICES / location permission")
      }
      null
    }

    AsyncFunction("removeGroup") {
      val m = manager
      val c = channel
      if (m != null && c != null) {
        runCatching { m.removeGroup(c, actionListener("removeGroup")) }
      }
      null
    }

    /** Replace the blob handed to any peer that connects to us. */
    Function("setOutgoing") { packetsBase64: String ->
      outgoing = Base64.decode(packetsBase64, Base64.NO_WRAP)
      null
    }

    /** Group owner side: accept connections and swap stores. */
    AsyncFunction("startServer") {
      startServerInternal()
      null
    }

    AsyncFunction("stopServer") {
      stopServerInternal()
      null
    }

    /** Client side: connect to the group owner and swap stores. */
    AsyncFunction("syncWith") { host: String ->
      syncWithInternal(host)
      null
    }

    OnDestroy {
      stopServerInternal()
      unregisterReceiver()
    }
  }

  // -------------------------------------------------------------------------
  // Socket exchange
  // -------------------------------------------------------------------------

  private fun startServerInternal() {
    if (serverRunning.getAndSet(true)) return

    thread(isDaemon = true, name = "patrol-wifi-server") {
      try {
        val server = ServerSocket()
        server.reuseAddress = true
        server.bind(InetSocketAddress(PORT))
        serverSocket = server

        while (serverRunning.get()) {
          val socket = try {
            server.accept()
          } catch (e: Exception) {
            if (serverRunning.get()) emitError("accept: ${e.message}")
            break
          }
          // One peer at a time is fine: an exchange is a few kilobytes.
          runCatching { exchange(socket) }
            .onFailure { emitError("exchange: ${it.message}") }
        }
      } catch (e: Exception) {
        emitError("server: ${e.message}")
      } finally {
        serverRunning.set(false)
        runCatching { serverSocket?.close() }
        serverSocket = null
      }
    }
  }

  private fun stopServerInternal() {
    serverRunning.set(false)
    runCatching { serverSocket?.close() }
    serverSocket = null
  }

  private fun syncWithInternal(host: String) {
    thread(isDaemon = true, name = "patrol-wifi-client") {
      runCatching {
        val socket = Socket()
        socket.connect(InetSocketAddress(host, PORT), SOCKET_TIMEOUT_MS)
        exchange(socket)
      }.onFailure { emitError("connect: ${it.message}") }
    }
  }

  /**
   * Symmetric swap: write ours, read theirs, close. Both sides run the same
   * code, so there is no client/server asymmetry to get wrong.
   */
  private fun exchange(socket: Socket) {
    socket.use { s ->
      s.soTimeout = SOCKET_TIMEOUT_MS
      val payload = outgoing

      DataOutputStream(s.getOutputStream()).let { out ->
        val count = payload.size / PACKET_SIZE
        out.writeShort(count)
        out.write(payload, 0, count * PACKET_SIZE)
        out.flush()
      }

      val input = DataInputStream(s.getInputStream())
      val count = input.readUnsignedShort()
      if (count > MAX_PACKETS) throw IllegalStateException("peer sent $count packets")

      val buf = ByteArray(count * PACKET_SIZE)
      input.readFully(buf)

      sendEvent(
        "onPeerData",
        mapOf(
          "data" to Base64.encodeToString(buf, Base64.NO_WRAP),
          "count" to count
        )
      )
    }
  }

  // -------------------------------------------------------------------------
  // P2P state
  // -------------------------------------------------------------------------

  private fun registerReceiver() {
    if (receiver != null) return
    val filter = IntentFilter().apply {
      addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
      addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
    }

    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION) return
        val m = manager ?: return
        val c = channel ?: return

        try {
          m.requestConnectionInfo(c) { info: WifiP2pInfo? ->
            m.requestGroupInfo(c) { group: WifiP2pGroup? ->
              sendEvent(
                "onGroupInfo",
                mapOf(
                  "connected" to (info?.groupFormed == true),
                  "isOwner" to (info?.isGroupOwner == true),
                  // Clients dial this address; the owner just listens.
                  "ownerAddress" to (info?.groupOwnerAddress?.hostAddress ?: ""),
                  "clientCount" to (group?.clientList?.size ?: 0)
                )
              )
            }
          }
        } catch (e: SecurityException) {
          emitError("connection info: permission denied")
        }
      }
    }

    ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    receiver = r
  }

  private fun unregisterReceiver() {
    receiver?.let { runCatching { context.unregisterReceiver(it) } }
    receiver = null
  }

  private fun actionListener(what: String) = object : WifiP2pManager.ActionListener {
    override fun onSuccess() {}
    override fun onFailure(reason: Int) {
      emitError("$what failed: ${reasonName(reason)}")
    }
  }

  private fun reasonName(reason: Int) = when (reason) {
    WifiP2pManager.P2P_UNSUPPORTED -> "P2P unsupported on this device"
    WifiP2pManager.BUSY -> "framework busy"
    WifiP2pManager.ERROR -> "internal error"
    else -> "reason $reason"
  }

  private fun emitError(message: String) {
    sendEvent("onError", mapOf("message" to message))
  }

  // -------------------------------------------------------------------------

  private fun neededPermissions(): List<String> =
    if (Build.VERSION.SDK_INT >= 33) {
      listOf(Manifest.permission.NEARBY_WIFI_DEVICES)
    } else {
      listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun hasPermissions(): Boolean = neededPermissions().all {
    ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
  }

  private fun requirePermissions() {
    if (!hasPermissions()) throw CodedException("Wi-Fi Direct permission not granted")
  }
}
