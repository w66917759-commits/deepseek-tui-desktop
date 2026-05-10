const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildDmgCodesignArgs,
  buildNotarySubmitArgs,
  buildUserKeychainList,
  detectAppleApiKeyId,
  detectDeveloperIdIntermediateUrl,
  findSigningCertificateCerPath,
  parseSecurityList,
  resolveOfficialMacReleaseConfig
} = require("../scripts/release-mac-official.cjs");

test("detectAppleApiKeyId parses the AuthKey filename", () => {
  assert.equal(
    detectAppleApiKeyId("/Users/west/project/appkey/AuthKey_5D6759RUY7.p8"),
    "5D6759RUY7"
  );
});

test("resolveOfficialMacReleaseConfig derives artifact paths and required credentials", () => {
  const config = resolveOfficialMacReleaseConfig({
    cwd: "/tmp/deepseektuidesk",
    version: "0.1.8",
    env: {
      DEEPSEEK_TUI_MAC_SIGN_IDENTITY: "Developer ID Application: chen He (3ZN7R3Z947)",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_API_KEY_PATH: "/Users/west/project/appkey/AuthKey_5D6759RUY7.p8",
      DEEPSEEK_TUI_CERT_CER_PATH: "/Users/west/project/appkey/developerID_application.cer",
      CSC_LINK: "/Users/west/project/appkey/证书.p12",
      CSC_KEY_PASSWORD: "p12-password"
    }
  });

  assert.equal(config.identity, "Developer ID Application: chen He (3ZN7R3Z947)");
  assert.equal(
    config.appPath,
    "/tmp/deepseektuidesk/release/mac-arm64/DeepSeek TUI Desktop.app"
  );
  assert.equal(
    config.dmgPath,
    "/tmp/deepseektuidesk/release/DeepSeek TUI Desktop-0.1.8-arm64.dmg"
  );
  assert.equal(config.appleApi.keyId, "5D6759RUY7");
  assert.equal(config.appleApi.issuer, "issuer-uuid");
  assert.equal(
    config.signingCertificate.cerPath,
    "/Users/west/project/appkey/developerID_application.cer"
  );
  assert.equal(config.signingCertificate.p12Path, "/Users/west/project/appkey/证书.p12");
  assert.equal(config.signingCertificate.p12Password, "p12-password");
  assert.equal(
    config.releaseKeychain.path,
    path.join(process.env.HOME, "Library/Keychains", "deepseek-release-signing.keychain-db")
  );
  assert.equal(config.releaseKeychain.password, "deepseek-release-signing");
});

test("buildNotarySubmitArgs emits a wait-based notarytool command", () => {
  const config = resolveOfficialMacReleaseConfig({
    cwd: "/tmp/deepseektuidesk",
    version: "0.1.8",
    env: {
      DEEPSEEK_TUI_MAC_SIGN_IDENTITY: "Developer ID Application: chen He (3ZN7R3Z947)",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_API_KEY_PATH: "/Users/west/project/appkey/AuthKey_5D6759RUY7.p8",
      DEEPSEEK_TUI_CERT_CER_PATH: "/Users/west/project/appkey/developerID_application.cer",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "/Users/west/project/appkey/证书.p12"
    }
  });

  assert.deepEqual(buildNotarySubmitArgs(config), [
    "notarytool",
    "submit",
    "/tmp/deepseektuidesk/release/DeepSeek TUI Desktop-0.1.8-arm64.dmg",
    "--key",
    "/Users/west/project/appkey/AuthKey_5D6759RUY7.p8",
    "--key-id",
    "5D6759RUY7",
    "--issuer",
    "issuer-uuid",
    "--wait",
    "--output-format",
    "json"
  ]);
});

test("buildDmgCodesignArgs signs the DMG with timestamped Developer ID identity", () => {
  const config = resolveOfficialMacReleaseConfig({
    cwd: "/tmp/deepseektuidesk",
    version: "0.1.8",
    env: {
      DEEPSEEK_TUI_MAC_SIGN_IDENTITY: "Developer ID Application: chen He (3ZN7R3Z947)",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_API_KEY_PATH: "/Users/west/project/appkey/AuthKey_5D6759RUY7.p8",
      DEEPSEEK_TUI_CERT_CER_PATH: "/Users/west/project/appkey/developerID_application.cer",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "/Users/west/project/appkey/证书.p12"
    }
  });

  assert.deepEqual(buildDmgCodesignArgs(config), [
    "--force",
    "--keychain",
    path.join(process.env.HOME, "Library/Keychains", "deepseek-release-signing.keychain-db"),
    "--sign",
    "Developer ID Application: chen He (3ZN7R3Z947)",
    "--timestamp",
    "/tmp/deepseektuidesk/release/DeepSeek TUI Desktop-0.1.8-arm64.dmg"
  ]);
});

test("findSigningCertificateCerPath discovers the Developer ID certificate", () => {
  assert.equal(
    findSigningCertificateCerPath("/Users/west/project/appkey"),
    "/Users/west/project/appkey/developerID_application.cer"
  );
});

test("detectDeveloperIdIntermediateUrl selects the Apple G2 intermediate for current certificates", () => {
  assert.equal(
    detectDeveloperIdIntermediateUrl(
      "issuer=CN=Developer ID Certification Authority, OU=G2, O=Apple Inc., C=US"
    ),
    "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"
  );
});

test("parseSecurityList strips quotes and blank lines", () => {
  assert.deepEqual(
    parseSecurityList(`    "/tmp/a.keychain-db"\n    "/tmp/b.keychain-db"\n`),
    ["/tmp/a.keychain-db", "/tmp/b.keychain-db"]
  );
});

test("buildUserKeychainList prepends the release keychain and preserves system defaults", () => {
  const config = resolveOfficialMacReleaseConfig({
    cwd: "/tmp/deepseektuidesk",
    version: "0.1.8",
    env: {
      DEEPSEEK_TUI_MAC_SIGN_IDENTITY: "Developer ID Application: chen He (3ZN7R3Z947)",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_API_KEY_PATH: "/Users/west/project/appkey/AuthKey_5D6759RUY7.p8",
      DEEPSEEK_TUI_CERT_CER_PATH: "/Users/west/project/appkey/developerID_application.cer",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "/Users/west/project/appkey/证书.p12"
    }
  });

  assert.deepEqual(buildUserKeychainList(config, ["/tmp/custom.keychain-db"]), [
    path.join(process.env.HOME, "Library/Keychains", "deepseek-release-signing.keychain-db"),
    "/tmp/custom.keychain-db",
    path.join(process.env.HOME, "Library/Keychains/login.keychain-db"),
    "/Library/Keychains/System.keychain"
  ]);
});

test("package.json exposes an official mac release script", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );

  assert.equal(
    packageJson.scripts["dist:mac:official"],
    "node scripts/release-mac-official.cjs"
  );
});
