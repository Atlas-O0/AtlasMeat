// Optional TURN relay for users who cannot connect peer-to-peer.
//
// Recommended free option (no credit card):
//   ExpressTURN → https://www.expressturn.com (free plan, 1 TB/month)
//   After signup, copy the Username + Password from the dashboard into
//   the Render environment as EXPRESSTURN_USERNAME / EXPRESSTURN_PASSWORD.
//   The server will expose them at /turn automatically.
//
// Alternatively you can hardcode any TURN server here:
//
// window.ATLAS_TURN = {
//   urls: [
//     'turn:your-turn-host:3478?transport=udp',
//     'turn:your-turn-host:3478?transport=tcp'
//   ],
//   username: 'user',
//   credential: 'password'
// };
