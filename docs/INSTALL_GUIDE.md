# Installing SyncLink (for lab staff)

This is for the **participant computers** (the two people having the conversation).
The experimenter/host computer is set up separately (it runs Docker) — that's a
one-time technical setup done by whoever manages the lab machine.

The participant app is **free and unsigned**, which just means the first time you
open it, your computer shows a scary-looking warning. It is safe — follow the
one-time steps below and it opens normally forever after.

---

## Where to download

Go to the project's **Releases** page on GitHub and download the file for your computer:

- **Mac** → the file ending in **`.dmg`**
- **Windows** → the file ending in **`.exe`**

---

## Mac — first time you open it

1. Open the `.dmg` you downloaded and drag **SyncLink** into your **Applications** folder.
2. Open **Applications**, find **SyncLink**, and double-click it.
3. A warning appears saying it can't be opened because it's from an unidentified
   developer. Click **Done** (do NOT click "Move to Trash").
4. Open **System Settings** → **Privacy & Security**.
5. Scroll down to the **Security** section. You'll see a line like
   *"SyncLink was blocked to protect your Mac."* Click **Open Anyway**.
6. Enter your Mac password / Touch ID if asked, then click **Open**.

That's it — from now on it opens with a normal double-click.

> **If it instead says "SyncLink is damaged and can't be opened":**
> This is the same block, just worded differently. Open the **Terminal** app and paste
> this one line, then press Enter:
> ```
> xattr -cr /Applications/SyncLink.app
> ```
> Then open SyncLink normally. (You only ever do this once.)

**Camera/microphone:** the first time you join a call, Mac asks for permission to
use the camera and microphone. Click **Allow** for both, or the other person won't
see or hear you.

---

## Windows — first time you open it

1. Double-click the `.exe` installer.
2. A blue box may appear: **"Windows protected your PC."**
3. Click **More info**, then click **Run anyway**.
4. Follow the installer, then open SyncLink.

---

## Joining a call (participants)

You do **not** need Docker, GitHub, or any setup. You only need two things:

1. The **SyncLink app** (installed above).
2. The **join link** the experimenter sends you.

Open the app, paste/click the link, and you're in. The link already knows where the
host computer is, so there's nothing to type.

---

## If something doesn't work

- **"Continue to room" does nothing / no video:** the host computer's media server
  isn't reachable. Make sure the experimenter's computer is running and on the same
  network, and that they sent you a fresh link.
- **No video on Mac even after joining:** you probably clicked "Don't Allow" on the
  camera prompt. Open **System Settings → Privacy & Security → Camera** and turn
  **SyncLink** on, then restart the app.
