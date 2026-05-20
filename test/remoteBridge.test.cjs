const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DesktopRemoteBridge } = require("../electron/remoteBridge.cjs");

function createBridge() {
  const userData = mkdtempSync(path.join(tmpdir(), "deepseek-tui-remote-"));
  const settings = {
    mobileBridgeEnabled: true,
    mobileBridgeHost: "127.0.0.1",
    mobileBridgePort: 8765,
    mobileBridgeToken: "test-admin-token-that-is-long-enough",
    mobileRelayUrl: "https://relay.example.com",
    mobileRemoteControlEnabled: false,
    updatePushEnabled: false
  };
  const harness = {
    getStatus() {
      return { running: false, activeSession: null, lastExit: null };
    },
    readSettings() {
      return settings;
    },
    start() {
      return { ok: true, pid: 1234 };
    },
    stop() {
      return { ok: true };
    },
    input() {}
  };
  const app = {
    getPath(name) {
      if (name !== "userData") throw new Error(`Unexpected app path ${name}`);
      return userData;
    }
  };
  const bridge = new DesktopRemoteBridge(app, harness);
  bridge.settings = settings;
  bridge.relay.connected = true;
  bridge.relay.sessionId = "relay_session_1";
  bridge.relay.url = settings.mobileRelayUrl;
  bridge.relay.ws = {
    readyState: 1,
    sent: [],
    send(message) {
      this.sent.push(JSON.parse(message));
    }
  };
  return {
    bridge,
    userData,
    cleanup() {
      bridge.disconnectRelay();
      rmSync(userData, { recursive: true, force: true });
    }
  };
}

test("remote pairing starts without account login and publishes hashed code to relay", () => {
  const { bridge, cleanup } = createBridge();
  try {
    const result = bridge.startPairing();

    assert.equal(result.ok, true);
    assert.match(result.pairing.code, /^\d{6}$/);
    assert.equal(result.pairing.desktopId, bridge.authState.desktopId);
    assert.equal(result.pairing.relaySessionId, "relay_session_1");
    assert.equal(bridge.relay.ws.sent.at(-1).type, "pairing.start");
    assert.equal(bridge.relay.ws.sent.at(-1).codeHash.length, 64);
    assert.equal(JSON.stringify(bridge.relay.ws.sent.at(-1)).includes(result.pairing.code), false);
  } finally {
    cleanup();
  }
});

test("pairDevice accepts code-only pairing and stores only token hash", () => {
  const { bridge, userData, cleanup } = createBridge();
  try {
    const pairing = bridge.startPairing().pairing;
    const result = bridge.pairDevice({
      pairingCode: pairing.code,
      deviceName: "West iPhone",
      clientDeviceId: "web-installation",
      platform: "web"
    });

    assert.equal(result.ok, true);
    assert.equal(result.desktopId, bridge.authState.desktopId);
    assert.equal(result.relaySessionId, "relay_session_1");
    assert.ok(result.deviceToken);
    assert.equal(result.device.accountId, "local");

    const persisted = JSON.parse(readFileSync(path.join(userData, "remote-auth.json"), "utf8"));
    assert.equal(persisted.devices.length, 1);
    assert.equal(persisted.devices[0].tokenHash.length, 64);
    assert.equal(JSON.stringify(persisted).includes(result.deviceToken), false);
  } finally {
    cleanup();
  }
});

test("pairDevice rejects invalid and expired pairing codes", () => {
  const { bridge, cleanup } = createBridge();
  try {
    const pairing = bridge.startPairing().pairing;
    const invalid = bridge.pairDevice({
      pairingCode: "000000",
      deviceName: "Phone",
      clientDeviceId: "web-installation"
    });
    bridge.authState.activePairing.expiresAt = "2026-01-01T00:00:00.000Z";
    bridge.writeAuthState();
    const expired = bridge.pairDevice({
      pairingCode: pairing.code,
      deviceName: "Phone",
      clientDeviceId: "web-installation"
    });

    assert.deepEqual(invalid, { ok: false, error: "Invalid pairing code" });
    assert.deepEqual(expired, { ok: false, error: "No active pairing code" });
  } finally {
    cleanup();
  }
});

test("pairDevice replaces an older record for the same client device id", () => {
  const { bridge, cleanup } = createBridge();
  try {
    const firstPairing = bridge.startPairing().pairing;
    bridge.pairDevice({
      pairingCode: firstPairing.code,
      deviceName: "Old iPhone",
      clientDeviceId: "web-installation"
    });
    const secondPairing = bridge.startPairing().pairing;
    const second = bridge.pairDevice({
      pairingCode: secondPairing.code,
      deviceName: "New iPhone",
      clientDeviceId: "web-installation"
    });

    assert.equal(second.ok, true);
    assert.equal(bridge.authState.devices.length, 1);
    assert.equal(bridge.authState.devices[0].name, "New iPhone");
  } finally {
    cleanup();
  }
});
