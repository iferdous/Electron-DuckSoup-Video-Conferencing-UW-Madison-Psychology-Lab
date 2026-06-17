# Two-Computer Testing

Use this when a controller/host computer and one or more participant computers need to join the same live room.

There are two local services to know about:

```text
DuckSoup/Mozza server:     http://HOST_LAN_IP:8100
App signal server:         http://HOST_LAN_IP:8765
```

The app signal server on `8765` is what lets computers find each other for the live call.

The DuckSoup/Mozza server on `8100` is only needed when testing the local DuckSoup/Mozza Docker path.

## Host Computer

1. Connect all computers to the same network.
2. Open this repo.
3. Install dependencies if needed:

```bash
npm install
```

4. Start the app:

```bash
npm run dev
```

If that does not open a window:

```bash
npm run build:manual
npm run start:manual
```

5. In the app, choose `Controller`.
6. Choose `Dyad`, `Triad`, or `Quad`.
7. Click `Start server here`.
8. Copy the server URL shown by the app. It should look like:

```text
http://192.168.1.42:8765
```

9. Keep the Meeting ID visible.
10. Click `Continue to room`.
11. Click `Join room`.

## Participant Computer

1. Open this repo.
2. Install dependencies if needed:

```bash
npm install
```

3. Start the app:

```bash
npm run dev
```

4. In the app, choose `Participant`.
5. Enter the same Meeting ID as the controller.
6. Enter the controller/host server URL.
7. Enter a display name and station ID.
8. Click `Continue to room`.
9. Click `Join room`.

## Optional: Start Local DuckSoup/Mozza

Only do this if the session needs the local DuckSoup/Mozza Docker server.

On the host computer:

```bash
cd docker/ducksoup
cp env.example .env
docker compose up -d
```

Check it:

```bash
curl http://localhost:8100/health
```

Stop it:

```bash
cd docker/ducksoup
docker compose down
```

## Common Problems

- The participant entered `localhost:8765`. On a participant computer, `localhost` means that participant computer, not the host.
- The computers are on different Wi-Fi networks.
- Windows is using a `Public` network profile. Change it to `Private`.
- macOS firewall blocked incoming connections.
- The Meeting ID is not exactly the same on every computer.
- Two participants used the same station ID.

## Remote Testing

Plain LAN URLs do not work when computers are on different networks.

For remote testing, use one of these:

- a VPN such as Tailscale
- a hosted server with HTTPS/WSS
- TURN for restrictive WebRTC networks

For real experiments, use the most stable network possible.
