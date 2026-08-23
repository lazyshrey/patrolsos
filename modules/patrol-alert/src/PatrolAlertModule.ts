import { NativeModule, requireOptionalNativeModule } from 'expo';

type PatrolAlertEvents = {
  /** The alarm reached its deadline, or the audio failed, and has stopped. */
  onRingEnd: () => void;
};

declare class PatrolAlertModuleType extends NativeModule<PatrolAlertEvents> {
  isRinging(): boolean;
  /** Milliseconds of alarm left, or 0 when silent. */
  remainingMs(): number;
  /**
   * @param seconds  clamped to 5..180 natively
   * @param who      notification title, e.g. "DELTA-4 is looking for you"
   * @param detail   notification body
   */
  ring(seconds: number, who: string, detail: string): Promise<void>;
  stop(): Promise<void>;
}

/** Optional: a build without the native siren still relays, it just cannot ring. */
export default requireOptionalNativeModule<PatrolAlertModuleType>('PatrolAlert');
