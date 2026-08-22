import { NativeModule, requireNativeModule } from 'expo';

export interface BleStatus {
  hasBluetooth: boolean;
  bluetoothEnabled: boolean;
  advertisingSupported: boolean;
  locationEnabled: boolean;
  permissionsGranted: boolean;
  isAdvertising: boolean;
  isScanning: boolean;
}

export interface PacketEventPayload {
  /** base64 of the manufacturer-specific data (our 20 bytes). */
  data: string;
  rssi: number;
}

export interface BleErrorPayload {
  where: 'advertise' | 'scan';
  code: number;
}

type PatrolBleEvents = {
  onPacket: (event: PacketEventPayload) => void;
  onError: (event: BleErrorPayload) => void;
};

declare class PatrolBleModuleType extends NativeModule<PatrolBleEvents> {
  getStatus(): BleStatus;
  setPayload(base64: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  startScanning(): Promise<void>;
  stopScanning(): Promise<void>;
}

export default requireNativeModule<PatrolBleModuleType>('PatrolBle');
