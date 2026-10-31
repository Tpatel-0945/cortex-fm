// Spotify Web Playback SDK: turns this browser tab into a Spotify device
// named "Cortex FM". Needs Premium and a browser with DRM (Chrome, Edge, Firefox, Safari).
import { token } from './spotify.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load Spotify's player. Check your connection or ad blocker."));
    document.head.append(s);
  });
}

/**
 * Start the in-browser player.
 * handlers: onReady(deviceId), onNotReady(), onState({ id, paused, position, duration }), onError(kind, message)
 * Returns { deviceId(), activate(), pause(), resume(), next(), previous(), disconnect() }.
 */
export async function createWebPlayer(handlers = {}) {
  await loadSdk();
  let deviceId = null;

  const player = new window.Spotify.Player({
    name: 'Cortex FM',
    volume: 0.8,
    // The SDK asks for a token whenever it needs one, so refreshed tokens flow through.
    getOAuthToken: cb => token().then(cb).catch(e => handlers.onError?.('auth', e.message)),
  });

  player.addListener('ready', ({ device_id }) => { deviceId = device_id; handlers.onReady?.(device_id); });
  player.addListener('not_ready', () => { deviceId = null; handlers.onNotReady?.(); });
  player.addListener('player_state_changed', st => {
    if (!st) return;
    const cur = st.track_window?.current_track;
    handlers.onState?.({ id: cur?.id, linkedId: cur?.linked_from?.id, paused: st.paused, position: st.position, duration: st.duration });
  });
  player.addListener('initialization_error', ({ message }) => handlers.onError?.('init', message));
  player.addListener('authentication_error', ({ message }) => handlers.onError?.('auth', message));
  player.addListener('account_error', ({ message }) => handlers.onError?.('account', message));
  player.addListener('playback_error', ({ message }) => handlers.onError?.('playback', message));
  player.addListener('autoplay_failed', () => handlers.onError?.('autoplay', 'Browser blocked autoplay'));

  const ok = await player.connect();
  if (!ok) throw new Error('The Spotify player could not connect in this browser.');

  return {
    deviceId: () => deviceId,
    // Browsers only allow audio after a tap; call this inside the click handler.
    activate: () => player.activateElement?.(),
    pause: () => player.pause(),
    resume: () => player.resume(),
    next: () => player.nextTrack(),
    previous: () => player.previousTrack(),
    disconnect: () => player.disconnect(),
  };
}
