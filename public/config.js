/**
 * Where the relay lives.
 *
 * The frontend is static and can be served from anywhere (Netlify), while the
 * relay has to be a real server that holds WebSockets open (Render). So the
 * two halves are usually on different hosts and the frontend needs to be told
 * where to look.
 *
 * The one exception is running the whole thing yourself: `npm start` serves the
 * pages and the relay from the same process, and pointing that at a remote
 * backend means edits to the server never show up in the browser. That is a
 * genuinely confusing way to lose an afternoon, so a page served from a local
 * or private address always talks to whoever served it.
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;
const PRIVATE_LAN = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** The deployed relay. Change this to your own backend when you host one. */
const REMOTE = 'https://drone-simulation-7iws.onrender.com';

const servedLocally =
  typeof location !== 'undefined' &&
  (LOCAL_HOST.test(location.hostname) || PRIVATE_LAN.test(location.hostname));

export const BACKEND_URL = servedLocally ? '' : REMOTE;
