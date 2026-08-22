import { NativeModule, requireNativeModule } from 'expo';

export interface WifiStatus {
  supported: boolean;
  wifiEnabled: boolean;
  /** Dialog-free autonomous group formation needs Android 10+. */
  canFormGroupSilently: boolean;
  permissionsGranted: boolean;
  serverRunning: boolean;
}

export interface GroupInfo {
  connected: boolean;
  isOwner: boolean;
  /** Clients dial this; the owner just listens. Empty until the group forms. */
  ownerAddress: string;
  clientCount: number;
}

export interface PeerDataPayload {
  /** base64 of `count` concatenated 20-byte PATROL packets. */
  data: string;
  count: number;
}

type PatrolWifiEvents = {
  onGroupInfo: (event: GroupInfo) => void;
  onPeerData: (event: PeerDataPayload) => void;
  onError: (event: { message: string }) => void;
};

declare class PatrolWifiModuleType extends NativeModule<PatrolWifiEvents> {
  getStatus(): WifiStatus;
  initialize(): Promise<void>;
  createGroup(networkName: string, passphrase: string): Promise<void>;
  joinGroup(networkName: string, passphrase: string): Promise<void>;
  removeGroup(): Promise<void>;
  setOutgoing(packetsBase64: string): void;
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
  syncWith(host: string): Promise<void>;
}

export default requireNativeModule<PatrolWifiModuleType>('PatrolWifi');
