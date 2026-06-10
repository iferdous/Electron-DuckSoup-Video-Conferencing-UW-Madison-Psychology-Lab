# Two-Computer DuckSoup Testing

Use this when you want two laptops to join the same live DuckSoup/Mozza room.

## Short Version

One laptop is the DuckSoup host. Both laptops run the Electron app. Both apps use the same Room ID. Both apps point to the host laptop's LAN URL:

```text
http://HOST_LAN_IP:8100
```

For example:

```text
http://192.168.1.42:8100
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

5. Find the host IP from the app's Two-Computer Setup panel, or run:

```bash
ipconfig getifaddr en0
```

6. If macOS asks about incoming network connections, allow Docker/Electron on the private network.

## Both Laptops

1. Start the Electron app:

```bash
cd "/Users/iferdous001/Desktop/Video Conferencing Software"
npm install
npm run dev
```

2. In both apps, set DuckSoup server to:

```text
http://HOST_LAN_IP:8100
```

3. Use the exact same Room ID on both laptops.
4. Use different station IDs, for example:

```text
Laptop A: P001
Laptop B: P002
```

5. Click Check on both laptops.
6. Click Connect on both laptops.

## What To Watch

- The Latency Viewer should begin updating after the WebRTC room starts.
- Lower RTT and jitter are better.
- Same LAN should be much better than remote internet.
- Wired ethernet is better than Wi-Fi when synchrony matters.

## Remote Testing

For laptops on different networks, a plain LAN IP will not work. Use one of these:

- Deploy DuckSoup on a reachable server with HTTPS/WSS.
- Configure TURN so WebRTC can relay through restrictive networks.
- Use a VPN such as Tailscale so both laptops appear on the same private network.

For real experiments, prefer a stable lab LAN or a dedicated server. Avoid consumer video-call infrastructure when the study depends on controlled manipulation timing.

## Common Failure Points

- DuckSoup host firewall blocks port `8100`.
- Laptops are on different Wi-Fi networks.
- The app points to `localhost:8100` on the non-host laptop. On the second laptop, localhost means that second laptop, not the host.
- `DUCKSOUP_ALLOWED_WS_ORIGINS` does not include `http://localhost:5173`.
- Both users accidentally use different Room IDs.
