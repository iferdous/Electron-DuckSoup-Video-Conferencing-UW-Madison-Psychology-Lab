# Two-Computer DuckSoup Testing

Use this when you want the Mac/host and Windows laptops to join the same live session.

There are two different local servers:

```text
DuckSoup/Mozza server:      http://MAC_IP:8100
Video call signal server:  http://MAC_IP:8765
```

`8100` only proves DuckSoup is alive. It does not, by itself, make the two laptops see each other. The live video call uses `8765` for signaling.

## Short Version

One laptop is the Mac/host. Both laptops run the Electron app. Both apps use the same Room ID. Windows should discover the Mac/host automatically. If it does not, use the Mac IP manually:

```text
DuckSoup server:  http://HOST_LAN_IP:8100
Signal server:    http://HOST_LAN_IP:8765
```

For example:

```text
DuckSoup server:  http://192.168.1.42:8100
Signal server:    http://192.168.1.42:8765
```

## Host Laptop

1. Connect both laptops to the same Wi-Fi or wired LAN.
2. Start Docker Desktop.
3. If you are using this repo's Docker profile, copy the Mozza plugin files into the profile once:

```bash
cd "/Users/iferdous001/Desktop/Video Conferencing Software/docker/ducksoup"
mkdir -p plugins
cp /Users/iferdous001/Documents/ducksoup-research/ducksoup-server/plugins/* plugins/
```

4. Start DuckSoup:

```bash
cd "/Users/iferdous001/Desktop/Video Conferencing Software/docker/ducksoup"
cp env.lan.example .env
docker compose up -d
```

You can also use the existing DuckSoup research server directly:

```bash
cd /Users/iferdous001/Documents/ducksoup-research/ducksoup-server
docker compose up -d --force-recreate
```

5. Open the Electron app.
6. Click **Mac/host**.
7. Click **Start Mac host** in the Live Video Conference section. This starts the video call signal server on port `8765` and advertises both required URLs.
8. Use `P001` as the station ID.
9. Find the host IP from the app's Local Network panel, or run:

```bash
ipconfig getifaddr en0
```

10. If macOS asks about incoming network connections, allow Docker/Electron on the private network.

## Both Laptops

1. Start the Electron app:

```bash
cd "/Users/iferdous001/Desktop/Video Conferencing Software"
npm install
npm run dev
```

2. On the Mac/host app, click **Start Mac host** once.
3. On the Windows app, click **Find Mac/host**. If it works, it fills in both server fields and the Room ID.
4. If discovery does not work, type the Mac IP manually:

```text
DuckSoup server:  http://HOST_LAN_IP:8100
Signal server:    http://HOST_LAN_IP:8765
```

5. Use the exact same Room ID on both laptops.
6. Use different station IDs, for example:

```text
Mac/host: P001
Windows:  P002
```

7. In **Live Video Conference**, click **Check** on Windows. It should say the signal server is reachable.
8. Click **Join call** on Mac/host.
9. Click **Join call** on Windows.
10. After the two live video panels work, use the DuckSoup section if you are also testing Mozza manipulation.

## What To Watch

- The Latency Viewer should begin updating after the WebRTC call connects.
- Lower RTT and jitter are better.
- Same LAN should be much better than remote internet.
- Wired ethernet is better than Wi-Fi when synchrony matters.

## Remote Testing

For laptops on different networks, a plain LAN IP will not work. Use one of these:

- Deploy DuckSoup on a reachable server with HTTPS/WSS.
- Configure TURN so WebRTC can relay through restrictive networks.
- Use a VPN such as Tailscale so both laptops appear on the same private network.
- Use an HTTPS tunnel for the signal server only when both laptops can still form a WebRTC media path. A tunnel by itself does not replace TURN for restrictive networks.

For real experiments, prefer a stable lab LAN or a dedicated server. Avoid consumer video-call infrastructure when the study depends on controlled manipulation timing.

## Common Failure Points

- DuckSoup host firewall blocks port `8100`.
- Electron or macOS firewall blocks port `8765`.
- Laptops are on different Wi-Fi networks.
- The app points to `localhost:8100` or `localhost:8765` on Windows. On Windows, localhost means Windows itself, not the Mac/host.
- `DUCKSOUP_ALLOWED_WS_ORIGINS` does not include `http://localhost:5173`.
- Both users accidentally use different Room IDs.
- Both users use the same station ID.
