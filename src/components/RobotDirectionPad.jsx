import { useEffect, useRef } from 'preact/hooks';
import { useI18n } from '../lib/i18n.js';
import {
  DEFAULT_BLE_CONFIG,
  MIN_DIRECTION_SPEED_MPS,
  ROS_MAX_LINEAR_SPEED_MPS,
} from '../lib/robotProtocol.js';

/**
 * Manual direction pad (forward / left / stop / right / back) with
 * hold-to-repeat and a speed slider.
 *
 * Self-contained: it only needs the BLE client to send direction commands,
 * the connection flag, and the persisted GATT config for step sizes / speed.
 * `configLocked` disables the speed slider while a connection is active (the
 * client rejects config changes mid-connection); `onUpdateConfig` writes the
 * slider back into the same config the rest of RobotControl persists.
 */
export function RobotDirectionPad({ connected, configLocked, client, config, onUpdateConfig }) {
  const { t } = useI18n();
  const padTimer = useRef(null);
  const padActiveRef = useRef(false);

  function stopPadRepeat() {
    if (padTimer.current) {
      clearInterval(padTimer.current);
      padTimer.current = null;
    }
  }

  useEffect(() => () => stopPadRepeat(), []);

  function startPadHold(direction, options) {
    return (event) => {
      if (!connected) return;
      event.preventDefault();
      if (padActiveRef.current) return; // another button already holds
      padActiveRef.current = true;
      const command = {
        ...options,
        speedMetersPerSecond:
          config.directionSpeedMetersPerSecond ?? DEFAULT_BLE_CONFIG.directionSpeedMetersPerSecond,
      };
      const send = () => client.sendDirection(direction, command).catch(() => {});
      send();
      padTimer.current = setInterval(send, 450);
    };
  }

  function endPadHold(event) {
    event?.preventDefault();
    padActiveRef.current = false;
    stopPadRepeat();
  }

  function stopNow() {
    stopPadRepeat();
    padActiveRef.current = false;
    client.sendDirection('stop').catch(() => {});
  }

  return (
    <div class="robot-pad" aria-label={t('robot.pad.aria')}>
      <div class="robot-pad-head">
        <span>{t('robot.pad.title')}</span>
        <small>{t('robot.pad.step', { meters: config.directionStepMeters ?? 0.15, degrees: config.directionStepDegrees ?? 15 })}</small>
      </div>
      <label class="robot-speed-slider">
        <span>{t('robot.pad.speed')}</span>
        <input
          type="range"
          min={MIN_DIRECTION_SPEED_MPS}
          max={ROS_MAX_LINEAR_SPEED_MPS}
          step="0.05"
          value={config.directionSpeedMetersPerSecond ?? DEFAULT_BLE_CONFIG.directionSpeedMetersPerSecond}
          onInput={(event) => onUpdateConfig('directionSpeedMetersPerSecond', event.currentTarget.value)}
          disabled={configLocked}
          aria-label={t('robot.pad.speedAria')}
        />
        <strong>{(config.directionSpeedMetersPerSecond ?? DEFAULT_BLE_CONFIG.directionSpeedMetersPerSecond).toFixed(2)} m/s</strong>
      </label>
      <div class="robot-pad-grid">
        <button
          class="robot-pad-btn pad-up"
          type="button"
          aria-label={t('robot.pad.forward')}
          disabled={!connected}
          onPointerDown={startPadHold('forward', { amountMeters: config.directionStepMeters })}
          onPointerUp={endPadHold}
          onPointerLeave={endPadHold}
          onPointerCancel={endPadHold}
          onContextMenu={(event) => event.preventDefault()}
        >↑<small>{t('robot.pad.forwardShort')}</small></button>
        <button
          class="robot-pad-btn pad-left"
          type="button"
          aria-label={t('robot.pad.left')}
          disabled={!connected}
          onPointerDown={startPadHold('left', { amountDegrees: config.directionStepDegrees })}
          onPointerUp={endPadHold}
          onPointerLeave={endPadHold}
          onPointerCancel={endPadHold}
          onContextMenu={(event) => event.preventDefault()}
        >←<small>{t('robot.pad.leftShort')}</small></button>
        <button
          class="robot-pad-btn pad-stop"
          type="button"
          aria-label={t('robot.pad.stop')}
          disabled={!connected}
          onPointerDown={(event) => event.preventDefault()}
          onClick={stopNow}
        >■<small>{t('robot.pad.stopShort')}</small></button>
        <button
          class="robot-pad-btn pad-right"
          type="button"
          aria-label={t('robot.pad.right')}
          disabled={!connected}
          onPointerDown={startPadHold('right', { amountDegrees: config.directionStepDegrees })}
          onPointerUp={endPadHold}
          onPointerLeave={endPadHold}
          onPointerCancel={endPadHold}
          onContextMenu={(event) => event.preventDefault()}
        >→<small>{t('robot.pad.rightShort')}</small></button>
        <button
          class="robot-pad-btn pad-down"
          type="button"
          aria-label={t('robot.pad.backward')}
          disabled={!connected}
          onPointerDown={startPadHold('backward', { amountMeters: config.directionStepMeters })}
          onPointerUp={endPadHold}
          onPointerLeave={endPadHold}
          onPointerCancel={endPadHold}
          onContextMenu={(event) => event.preventDefault()}
        >↓<small>{t('robot.pad.backwardShort')}</small></button>
      </div>
      <small class="robot-hint">{t('robot.pad.hint')}</small>
    </div>
  );
}
