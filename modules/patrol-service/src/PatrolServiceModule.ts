import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface ServiceStatus {
  /** True while the foreground service holds the process open. */
  running: boolean;
  /** POST_NOTIFICATIONS. Without it there is no service and no buzz alert. */
  notificationsAllowed: boolean;
  /** True once the user has exempted PATROL from Doze. */
  batteryUnrestricted: boolean;
}

type PatrolServiceEvents = {
  /** The user pressed Stop on the ongoing notification. */
  onStopRequested: () => void;
};

declare class PatrolServiceModuleType extends NativeModule<PatrolServiceEvents> {
  getStatus(): ServiceStatus;
  start(title: string, text: string): Promise<void>;
  update(title: string, text: string): Promise<void>;
  stop(): Promise<void>;
  requestBatteryExemption(): Promise<boolean>;
}

/**
 * Optional on purpose. The pure-JS layers and any build without this native
 * module still run — they just cannot survive being backgrounded, which is a
 * degradation rather than a crash.
 */
export default requireOptionalNativeModule<PatrolServiceModuleType>('PatrolService');
