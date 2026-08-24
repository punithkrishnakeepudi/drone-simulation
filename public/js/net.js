/**
 * Net.js
 *
 * Small WebSocket wrapper (Link) shared by the simulator and the phone.
 * It handles the pairing handshake, keeps a live count of the peers on the
 * relay, and reconnects on its own when the Wi-Fi hiccups.
 *
 * Peer counts are both stored on `link.peers` and pushed to `onPeers`, so a
 * page can react the moment the other device shows up.
 */

export class Link {
  constructor({ role, pin, callsign, team, onMessage, onStatus, onPeers }) {
    this.role = role;
    this.pin = pin;
    this.callsign = callsign || '';
    this.team = team || '';
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onPeers = onPeers;
    this.peers = { sim: 0, ctrl: 0, any: 0 };
    this.welcome = null;
    this.seat = null;
    this.status = 'offline';
    this.denied = false;
    this.retry = 0;
    this.ws = null;
    this.connect();
  }

  connect() {
    if (this.denied) return;

    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let ws;
    try {
      ws = new WebSocket(protocol + location.host);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', role: this.role, pin: this.pin, callsign: this.callsign, team: this.team }));
    };

    ws.onmessage = (event) => {
      let m;
      try {
        m = JSON.parse(event.data);
      } catch {
        return;
      }

      if (m.t === 'welcome') {
        // The relay hands a screen its seat number here, so keep the whole
        // greeting around rather than just the fact that we are connected.
        this.welcome = m;
        this.seat = m.seat ?? null;
        this.status = 'online';
        this.onStatus?.('online');
        this.onMessage?.(m);
      } else if (m.t === 'denied') {
        this.denied = true;
        this.status = 'denied';
        this.onStatus?.('denied', m.reason);
      } else if (m.t === 'team/joined') {
        // Remembered on the link so a reconnect rejoins the same team rather
        // than silently landing back in the shared default room.
        this.team = m.isDefault ? '' : m.code;
        this.onMessage?.(m);
      } else if (m.t === 'peers') {
        // `any` is the screen count across every team, not just this one — a
        // phone still choosing a team needs it, so it must not be dropped here.
        this.peers = { sim: m.sim || 0, ctrl: m.ctrl || 0, any: m.any ?? m.sim ?? 0 };
        this.onPeers?.(this.peers);
        this.onStatus?.(this.status);
      } else {
        this.onMessage?.(m);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;         // an older socket finally gave up
      if (this.status === 'denied') return;
      this.status = 'offline';
      this.peers = { sim: 0, ctrl: 0, any: 0 };
      this.onPeers?.(this.peers);
      this.onStatus?.('offline');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows, so let that path do the reconnecting.
      try { ws.close(); } catch { /* already closing */ }
    };
  }

  /** Back off a little so a server that is still booting is not hammered. */
  scheduleReconnect() {
    if (this.denied) return;
    const wait = Math.min(4000, 400 * 2 ** this.retry++);
    setTimeout(() => this.connect(), wait);
  }

  /** Re-pair with a different code without reloading the page. */
  repair(pin) {
    this.pin = pin;
    this.denied = false;
    this.retry = 0;
    try { this.ws?.close(); } catch { /* nothing open */ }
    this.ws = null;
    this.connect();
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
