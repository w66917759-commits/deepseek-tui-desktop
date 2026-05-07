const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DesktopRemoteBridge } = require("../electron/remoteBridge.cjs");

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function fakeApp(userDataPath) {
  return {
    getPath(name) {
      if (name === "userData") {
        return userDataPath;
      }
      return path.join(userDataPath, name);
    }
  };
}

function fakeHarness() {
  let settings = {};
  let lastInput = "";
  return {
    getStatus() {
      return { running: false, activeSession: null, lastExit: null };
    },
    readSettings() {
      return settings;
    },
    writeSettings(nextSettings) {
      settings = { ...nextSettings };
      return settings;
    },
    start(options) {
      return { ok: true, options };
    },
    stop() {
      return { ok: true };
    },
    input(data) {
      lastInput = data;
    },
    getLastInput() {
      return lastInput;
    },
    createSkillTemplate(payload) {
      return {
        ok: true,
        skill: {
          id: payload.skillId || "remote-skill"
        }
      };
    }
  };
}

function fakeRequest(headers = {}) {
  return {
    headers,
    socket: {
      remoteAddress: "127.0.0.1"
    }
  };
}

test("remote bridge hides admin token and authenticates admin bearer tokens", (t) => {
  const root = makeTempRoot("dstui-remote");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const settings = {
    mobileBridgeEnabled: false,
    mobileBridgeHost: "127.0.0.1",
    mobileBridgePort: 8765,
    mobileBridgeToken: "admin-token-123456789012345",
    mobileRemoteControlEnabled: false,
    updatePushEnabled: false
  };
  const bridge = new DesktopRemoteBridge(fakeApp(path.join(root, "userData")), fakeHarness());
  t.after(() => bridge.stop());
  bridge.configure(settings);

  const publicStatus = bridge.getStatus(false);
  assert.equal(publicStatus.token, undefined);
  assert.equal(publicStatus.tokenPreview, "admin-...2345");

  const auth = bridge.resolveAuth(
    fakeRequest({ authorization: `Bearer ${settings.mobileBridgeToken}` }),
    new URL("http://127.0.0.1/api/v1/status")
  );
  assert.equal(auth.ok, true);
  assert.equal(auth.admin, true);
  assert.equal(auth.device, null);

  const denied = bridge.resolveAuth(
    fakeRequest({ authorization: "Bearer wrong-token" }),
    new URL("http://127.0.0.1/api/v1/status")
  );
  assert.equal(denied.ok, false);
});

test("pairing flow normalizes accounts, issues device tokens, and supports revocation", (t) => {
  const root = makeTempRoot("dstui-pairing");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bridge = new DesktopRemoteBridge(fakeApp(path.join(root, "userData")), fakeHarness());
  t.after(() => bridge.stop());
  bridge.configure({
    mobileBridgeEnabled: false,
    mobileBridgeHost: "127.0.0.1",
    mobileBridgePort: 8765,
    mobileBridgeToken: "admin-token-123456789012345",
    mobileRemoteControlEnabled: true,
    updatePushEnabled: false
  });

  const login = bridge.loginAccount({
    email: "USER@Example.COM",
    displayName: "Desktop User"
  });
  assert.equal(login.ok, true);
  assert.equal(login.auth.account.accountId, "user@example.com");

  const pairing = bridge.startPairing();
  assert.equal(pairing.ok, true);
  assert.match(pairing.pairing.code, /^\d{6}$/);
  assert.equal(pairing.pairing.accountId, "user@example.com");

  const mismatch = bridge.pairDevice({
    accountId: "other@example.com",
    pairingCode: pairing.pairing.code
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /Account mismatch/);

  const paired = bridge.pairDevice({
    accountId: "USER@example.com",
    pairingCode: pairing.pairing.code,
    deviceName: "Phone",
    platform: "ios",
    clientDeviceId: "phone-1"
  });
  assert.equal(paired.ok, true);
  assert.equal(paired.device.name, "Phone");
  assert.equal(typeof paired.deviceToken, "string");

  const deviceAuth = bridge.resolveAuth(
    fakeRequest({ "x-deepseek-device-token": paired.deviceToken }),
    new URL("http://127.0.0.1/api/v1/status")
  );
  assert.equal(deviceAuth.ok, true);
  assert.equal(deviceAuth.admin, false);
  assert.equal(deviceAuth.device.id, paired.device.id);

  const revoke = bridge.revokeDevice(paired.device.id);
  assert.equal(revoke.ok, true);

  const afterRevoke = bridge.resolveAuth(
    fakeRequest({ "x-deepseek-device-token": paired.deviceToken }),
    new URL("http://127.0.0.1/api/v1/status")
  );
  assert.equal(afterRevoke.ok, false);
});

test("terminal replay buffer is bounded for remote event streams", (t) => {
  const root = makeTempRoot("dstui-terminal-buffer");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bridge = new DesktopRemoteBridge(fakeApp(path.join(root, "userData")), fakeHarness());
  t.after(() => bridge.stop());
  bridge.configure({
    mobileBridgeEnabled: false,
    mobileBridgeHost: "127.0.0.1",
    mobileBridgePort: 8765,
    mobileBridgeToken: "admin-token-123456789012345",
    mobileRemoteControlEnabled: false,
    updatePushEnabled: false
  });

  bridge.handleTerminalData("x".repeat(90_000));

  assert.equal(bridge.terminalBuffer.length, 80_000);
  assert.equal(bridge.getStatus(false).terminalPreview.length, 4000);
});
