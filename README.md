# Cloudflare WHIP Streamer

A small React + Vite browser app for publishing camera and microphone video to
Cloudflare Stream using WebRTC WHIP.

This project is intentionally simple: paste a Cloudflare Stream WebRTC publish
URL, allow camera/microphone access, and start streaming from the browser. It is
useful as a learning project, a quick test tool, or a starting point for adding
creator livestreaming to your own app.

## Features

- Browser-based WebRTC publishing to Cloudflare Stream WHIP
- Camera preview before streaming
- Camera switch button for devices with front/back cameras
- Configurable max video bitrate
- Live network stats: bitrate, FPS, and RTT
- Connection health warning when the stream appears unhealthy
- Responsive landscape-first layout for desktop, tablet, and mobile
- Cloudflare-friendly video codec preference handling

## Demo Flow

1. Create or open a Cloudflare Stream live input.
2. Copy the live input WebRTC publish URL.
3. Paste it into this app.
4. Click **Stream**.
5. Grant browser camera and microphone permission.

The publish URL usually looks like this:

```text
https://customer-<CODE>.cloudflarestream.com/<SECRET>/webRTC/publish
```

Keep this URL private. Anyone with the publish URL can stream to that live input.

## Requirements

- Node.js 20 or newer is recommended
- npm
- A Cloudflare account with Stream enabled
- A Cloudflare Stream live input with WebRTC/WHIP support
- A modern browser with WebRTC support
- HTTPS in production, because browsers require a secure context for camera and
  microphone access. `localhost` works during local development.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

Type-check the project:

```bash
npm run lint
```

## Getting a Cloudflare WHIP URL

Cloudflare documents the WebRTC WHIP flow in the Stream WebRTC docs:

https://developers.cloudflare.com/stream/webrtc-beta/

Short version:

1. Go to the Cloudflare dashboard.
2. Open **Stream**.
3. Create or select a **Live input**.
4. Copy the **WebRTC publish** URL, also exposed as `webRTC.url` in the API.
5. Paste that URL into this app.

Cloudflare also provides a WHEP playback URL for viewing the same live input with
sub-second latency. This app only handles publishing.

## How It Works

The app uses browser-native WebRTC APIs:

- `navigator.mediaDevices.getUserMedia()` captures camera and microphone input.
- `RTCPeerConnection` creates a send-only WebRTC connection.
- The browser generates an SDP offer.
- The app sends that offer to Cloudflare's WHIP publish endpoint.
- Cloudflare returns an SDP answer.
- The app sets the answer as the remote description and starts publishing.

Video capture is currently configured for 360p at 30fps by default. The bitrate
slider controls the sender's `maxBitrate`.

## Project Structure

```text
.
├── index.html
├── package.json
├── src
│   ├── App.tsx
│   ├── index.css
│   ├── main.tsx
│   └── vite-env.d.ts
├── tsconfig.json
└── vite.config.ts
```

Most of the app logic currently lives in `src/App.tsx` so it is easy to read and
modify.

## Troubleshooting

### The Stream button is disabled

Paste a WHIP publish URL into the **WHIP Publish URL** field first.

### Camera or microphone permission fails

Make sure you are using `localhost` during development or HTTPS in production.
Browsers block camera and microphone access on insecure origins.

### Cloudflare returns an error

Check that you pasted the WebRTC publish URL, not an RTMPS URL, stream key, or
playback URL. The URL should end with `/webRTC/publish`.

### The stream starts but bitrate stays near 0 kbps

Check your network connection, browser permissions, camera availability, and
whether the Cloudflare live input is enabled.

### Mobile camera switch does not work on every device

Camera switching depends on browser and device support for `facingMode`. Some
browsers may ignore the requested camera mode.

## Security Notes

- Do not commit real Cloudflare publish URLs.
- Do not expose a creator's publish URL publicly.
- Treat the WHIP publish URL like a secret for that live input.
- For a production app, generate or fetch publish URLs from your backend instead
  of hard-coding them in the frontend.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite dev server on port 3000 |
| `npm run build` | Create a production build in `dist/` |
| `npm run preview` | Preview the production build |
| `npm run lint` | Run TypeScript type-checking |
| `npm run clean` | Remove the `dist/` directory |

## Contributing

Contributions are welcome. A few good first improvements:

- Add a WHEP playback view
- Save recent settings locally
- Add resolution presets
- Add better error messages for Cloudflare WHIP responses
- Split the app into smaller components
- Add automated browser tests

Please keep the project approachable. The goal is to help people understand
browser-based WHIP streaming without hiding the important pieces behind a large
framework.

## Credits

Idea & concept by Dimas Seputro  
https://github.com/seputrodimas

## License

This project is licensed under the terms in [LICENSE](./LICENSE).
